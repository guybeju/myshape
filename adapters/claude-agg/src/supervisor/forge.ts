// The two forge actions a worker may ask for (option A of the credential
// report): push its own branch and open its pull request. The worker has no
// forge credential and no route to GitHub; the supervisor runs git and gh for
// it with the login of whoever runs the supervisor, and there is no tool that
// merges.
//
// push_branch refuses a branch that, compared with the default branch's tip
// as GitHub has it now, changes anything under .github/: a workflow file on a
// pushed branch runs on GitHub with whatever token permissions it asks for.
// The worker can write the main checkout's shared .git (its refs, its
// objects), so nothing there is trusted for the check: the default tip comes
// from `git ls-remote`, and the comparison and the push run in a bare
// repository only the supervisor writes, outside every worker's sandbox. The
// branch's commits reach that repository by a fetch from the main checkout,
// which checks every object against its name, so a rewritten object in the
// shared store cannot make the comparison see another tree than the one
// pushed. The one commit compared is the one pushed.

import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { CommandResult, Git, PlainEnv, RunCommand } from "./commands.js";

/** What one worker session's forge tools act on; bound when the session starts. */
export interface ForgeTarget {
  task: string;
  /** The worker's branch, `agg/<task>`. */
  branch: string;
  /** The target repository's main checkout, whose origin remote is pushed to. */
  mainCheckout: string;
  defaultBranch: string;
  /** The supervisor's own bare repository for this target repository. */
  pushRepo: string;
}

export const FORGE_TEXT = {
  pushed: (sha: string, branch: string) => `已推送 ${sha} 到 ${branch}。`,
  refused: (why: string) => `supervisor 拒絕推送：${why}`,
  remote: "主 checkout 的 origin 不是可以推送的網址",
  noTip: "從 GitHub 抓不到預設分支現在的 commit",
  noFetch: "抓不到預設分支的內容",
  noBranch: "讀不到這個 task 的分支",
  noHistory: "分支和預設分支沒有共同的歷史",
  noCommits: "分支沒有比預設分支多的提交",
  compare: "比對 .github/ 失敗",
  github: "分支改到了 .github/；CI 的改動交給 captain",
  pushFailed: (line: string) => `git push 失敗：${line}`,
  notPushed: "還沒有成功推送這個分支，不能開 PR。",
  notGithub: "origin 不是 GitHub 的 repo，不能開 PR。",
  prFailed: (line: string) => `gh pr create 失敗：${line}`,
  opened: (url: string) => `PR 開好了：${url}`,
} as const;

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** A remote git may push to without running a program: no `<transport>::` and no file URL. */
const PUSHABLE = /^(https:\/\/|ssh:\/\/|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!:))/;
const GITHUB_REPO =
  /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const PR_URL = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/;

function lastLine(result: CommandResult): string {
  const line = result.stderr.trim().split("\n").at(-1) ?? "";
  return line === "" ? `exit ${String(result.status)}` : line;
}

/** The origin URL, or undefined when it is not one git can push to without running a program. */
function pushableUrl(url: string): string | undefined {
  return PUSHABLE.test(url) || (isAbsolute(url) && !url.includes("::")) ? url : undefined;
}

/** `owner/name` of a GitHub remote URL, or undefined. */
export function githubRepo(url: string): string | undefined {
  return GITHUB_REPO.exec(url)?.[1];
}

/** The one SHA `git ls-remote <url> refs/heads/<branch>` printed for exactly that ref. */
export function tipOf(stdout: string, branch: string): string | undefined {
  const lines = stdout.split("\n").filter((line) => line !== "");
  if (lines.length !== 1) return undefined;
  const [sha, ref] = (lines[0] ?? "").split("\t");
  return sha !== undefined && SHA.test(sha) && ref === `refs/heads/${branch}` ? sha : undefined;
}

/** What a forge tool hands back to the worker: whether it did it, and what to tell the worker. */
export interface ToolAnswer {
  ok: boolean;
  text: string;
}

function refused(text: string): ToolAnswer {
  return { ok: false, text };
}

type Step<T> = { ok: true; value: T } | { ok: false; why: string };

function fail<T>(why: string): Step<T> {
  return { ok: false, why };
}

/**
 * One worker session's forge tools. Each method returns the text the worker
 * gets back; a refused push is also kept in `refusal`, for the supervisor to
 * report as the task's summary whatever the worker writes.
 */
export class Forge {
  /** The commit the last push put on the branch, once one succeeded. */
  pushed: string | undefined;
  /** The pull request open_pr opened, from gh's own output. */
  prUrl: string | undefined;
  /** Why the last push was refused, or undefined. */
  refusal: string | undefined;

  constructor(
    private readonly git: Git,
    private readonly run: RunCommand,
    private readonly env: PlainEnv,
    readonly target: ForgeTarget,
  ) {}

  /** push_branch: the checks above, then `git push <origin> <sha>:refs/heads/<branch>`. */
  async pushBranch(): Promise<ToolAnswer> {
    const checked = await this.check();
    if (!checked.ok) {
      this.refusal = FORGE_TEXT.refused(checked.why);
      return refused(this.refusal);
    }
    const { url, sha } = checked.value;
    const { branch, pushRepo } = this.target;
    const push = await this.git.git(
      pushRepo,
      "push",
      "--quiet",
      url,
      `${sha}:refs/heads/${branch}`,
    );
    if (push.status !== 0) return refused(FORGE_TEXT.pushFailed(lastLine(push)));
    this.pushed = sha;
    this.refusal = undefined;
    return { ok: true, text: FORGE_TEXT.pushed(sha, branch) };
  }

  /** Everything push_branch checks; on success the URL to push to and the one commit to push. */
  private async check(): Promise<Step<{ url: string; sha: string }>> {
    const url = await this.originUrl();
    if (url === undefined) return fail(FORGE_TEXT.remote);
    const tip = await this.defaultTip(url);
    if (!tip.ok) return tip;
    const sha = await this.branchCommit();
    if (!sha.ok) return sha;
    const same = await this.sameGithub(tip.value, sha.value);
    return same.ok ? { ok: true, value: { url, sha: sha.value } } : same;
  }

  private async originUrl(): Promise<string | undefined> {
    const result = await this.git.git(this.target.mainCheckout, "remote", "get-url", "origin");
    return result.status === 0 ? pushableUrl(result.stdout.trim()) : undefined;
  }

  /** The default branch's tip as GitHub has it now, with its objects in the push repository. */
  private async defaultTip(url: string): Promise<Step<string>> {
    const { defaultBranch, pushRepo } = this.target;
    const ref = `refs/heads/${defaultBranch}`;
    const listed = await this.git.git(pushRepo, "ls-remote", "--exit-code", url, ref);
    const tip = listed.status === 0 ? tipOf(listed.stdout, defaultBranch) : undefined;
    if (tip === undefined) return fail(FORGE_TEXT.noTip);
    const fetched = await this.git.git(pushRepo, "fetch", "--quiet", "--no-tags", url, ref);
    const present = await this.git.git(pushRepo, "cat-file", "-e", `${tip}^{commit}`);
    return fetched.status === 0 && present.status === 0
      ? { ok: true, value: tip }
      : fail(FORGE_TEXT.noFetch);
  }

  /** The branch's commit, fetched by name from the main checkout into the push repository. */
  private async branchCommit(): Promise<Step<string>> {
    const { branch, mainCheckout, pushRepo, task } = this.target;
    const local = `refs/claude-agg/${task}`;
    const refspec = `+refs/heads/${branch}:${local}`;
    const fetched = await this.git.git(
      pushRepo,
      "fetch",
      "--quiet",
      "--no-tags",
      mainCheckout,
      refspec,
    );
    if (fetched.status !== 0) return fail(FORGE_TEXT.noBranch);
    const parsed = await this.git.git(pushRepo, "rev-parse", "--verify", `${local}^{commit}`);
    const sha = parsed.stdout.trim();
    return parsed.status === 0 && SHA.test(sha)
      ? { ok: true, value: sha }
      : fail(FORGE_TEXT.noBranch);
  }

  /**
   * Whether the two commits share history, the branch has at least one commit
   * beyond the tip, and both hold the same .github/ tree.
   */
  private async sameGithub(tip: string, sha: string): Promise<Step<true>> {
    const { pushRepo } = this.target;
    const base = await this.git.git(pushRepo, "merge-base", tip, sha);
    if (base.status === 1) return fail(FORGE_TEXT.noHistory);
    if (base.status !== 0) return fail(FORGE_TEXT.compare);
    const ahead = await this.git.git(pushRepo, "rev-list", "--count", `${tip}..${sha}`);
    const count = Number(ahead.stdout.trim());
    if (ahead.status !== 0 || !Number.isInteger(count)) return fail(FORGE_TEXT.compare);
    if (count === 0) return fail(FORGE_TEXT.noCommits);
    const diff = await this.git.git(pushRepo, "diff", "--quiet", tip, sha, "--", ".github/");
    if (diff.status === 1) return fail(FORGE_TEXT.github);
    return diff.status === 0 ? { ok: true, value: true } : fail(FORGE_TEXT.compare);
  }

  /** open_pr: `gh pr create` for the branch this session pushed, into the default branch. */
  async openPr(title: string, body: string): Promise<ToolAnswer> {
    if (this.pushed === undefined) return refused(FORGE_TEXT.notPushed);
    const url = await this.git.git(this.target.mainCheckout, "remote", "get-url", "origin");
    const repo = url.status === 0 ? githubRepo(url.stdout.trim()) : undefined;
    if (repo === undefined) return refused(FORGE_TEXT.notGithub);
    const { defaultBranch, branch } = this.target;
    const args = ["pr", "create", "--repo", repo, "--base", defaultBranch, "--head", branch];
    const result = await this.run({
      file: "gh",
      args: [...args, "--title", title, "--body", body],
      env: { ...this.env, GH_PROMPT_DISABLED: "1" },
    });
    const opened = result.status === 0 ? PR_URL.exec(result.stdout)?.[0] : undefined;
    if (opened === undefined) return refused(FORGE_TEXT.prFailed(lastLine(result)));
    this.prUrl = opened;
    return { ok: true, text: FORGE_TEXT.opened(opened) };
  }
}

/**
 * Makes `path` a bare repository only the supervisor writes, unless it is one
 * already.
 *
 * Returns:
 *   undefined when it is ready, else git's one-line reason.
 */
export async function ensurePushRepo(git: Git, path: string): Promise<string | undefined> {
  if (existsSync(`${path}/HEAD`)) return undefined;
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const made = await git.git(path, "init", "--bare", "--quiet");
  return made.status === 0 ? undefined : lastLine(made);
}
