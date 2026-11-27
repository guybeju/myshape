// push_branch and open_pr with real git, in sandbox repositories this test
// makes under its own temporary directory: a bare "remote" standing for
// GitHub, a main checkout whose origin it is, a worktree on the task's branch
// and the supervisor's own push repository. Every git call goes through a
// runner that refuses any directory outside that temporary directory; gh is
// a double.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { Git, spawnCommand, type CommandRequest, type RunCommand } from "./commands.js";
import { ensurePushRepo, Forge, FORGE_TEXT, githubRepo, tipOf, type ForgeTarget } from "./forge.js";

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "claude-agg-forge-")));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const ENV = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  HOME: join(sandbox, "h"),
  LANG: "C.UTF-8",
  TMPDIR: tmpdir(),
};
const GIT_ENV = { ...ENV, GIT_CONFIG_NOSYSTEM: "1" };
mkdirSync(ENV.HOME);

function inSandbox(dir: string | undefined): boolean {
  return dir !== undefined && (dir === sandbox || dir.startsWith(`${sandbox}/`));
}

/** git -C <dir> for the test itself (the worker's side), only inside the sandbox. */
function git(dir: string, ...args: string[]): string {
  if (!inSandbox(dir)) throw new Error(`refused: git outside the sandbox (${dir})`);
  const identity = ["-c", "user.name=t", "-c", "user.email=t@example.invalid"];
  const out = spawnSync("git", ["-C", dir, ...identity, "-c", "commit.gpgsign=false", ...args], {
    env: GIT_ENV,
    encoding: "utf8",
  });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
}

interface Recorded {
  run: RunCommand;
  calls: CommandRequest[];
}

/**
 * The supervisor's runner: real git inside the sandbox only, gh answered by
 * `gh`; `breakOn` makes one git subcommand fail as if git broke.
 */
function runner(gh: (request: CommandRequest) => string | null, breakOn?: string): Recorded {
  const calls: CommandRequest[] = [];
  const run: RunCommand = async (request) => {
    calls.push(request);
    if (request.file === "gh") {
      const out = gh(request);
      return out === null
        ? { status: 1, stdout: "", stderr: "gh: no\n" }
        : { status: 0, stdout: out, stderr: "" };
    }
    if (request.file !== "git" || request.args[0] !== "-C" || !inSandbox(request.args[1])) {
      throw new Error(`refused: ${request.file} ${request.args.join(" ")}`);
    }
    if (breakOn !== undefined && request.args[2] === breakOn) {
      return { status: 128, stdout: "", stderr: "fatal: broken\n" };
    }
    return spawnCommand({ ...request, env: { ...request.env, GIT_CONFIG_NOSYSTEM: "1" } });
  };
  return { run, calls };
}

let n = 0;

interface Setup {
  remote: string;
  main: string;
  worktree: string;
  target: ForgeTarget;
}

/** A remote with one commit (holding .github/), its main checkout, and a worktree on agg/t-<n>. */
function setUp(): Setup {
  n += 1;
  const root = join(sandbox, `r${n}`);
  const remote = join(root, "remote.git");
  const main = join(root, "main");
  mkdirSync(remote, { recursive: true });
  git(remote, "init", "--bare", "-q", "-b", "main");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  mkdirSync(join(main, ".github", "workflows"), { recursive: true });
  writeFileSync(join(main, ".github", "workflows", "ci.yml"), "on: push\n");
  writeFileSync(join(main, "README"), "one\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "one");
  git(main, "remote", "add", "origin", remote);
  git(main, "push", "-q", "origin", "main");
  git(main, "fetch", "-q", "origin");
  const task = `t-${n}`;
  const branch = `agg/${task}`;
  const worktree = join(root, "work", task);
  git(main, "worktree", "add", "-q", worktree, "-b", branch, "origin/main");
  const target = {
    task,
    branch,
    mainCheckout: main,
    defaultBranch: "main",
    pushRepo: join(root, "push", "app.git"),
  };
  return { remote, main, worktree, target };
}

/** The worker's side: one commit in the worktree writing `files`. */
function commit(worktree: string, files: Record<string, string>): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(worktree, path, ".."), { recursive: true });
    writeFileSync(join(worktree, path), text);
  }
  git(worktree, "add", ".");
  git(worktree, "commit", "-q", "-m", "work");
  return git(worktree, "rev-parse", "HEAD");
}

function remoteBranch(remote: string, branch: string): string {
  const out = spawnSync(
    "git",
    ["-C", remote, "rev-parse", "--verify", "-q", `refs/heads/${branch}`],
    {
      env: GIT_ENV,
      encoding: "utf8",
    },
  );
  return out.stdout.trim();
}

async function forge(setup: Setup, recorded = runner(() => null)): Promise<Forge> {
  const supervisorGit = new Git(recorded.run, ENV);
  expect(await ensurePushRepo(supervisorGit, setup.target.pushRepo)).toBeUndefined();
  return new Forge(supervisorGit, recorded.run, ENV, setup.target);
}

describe("push_branch", () => {
  it("pushes the branch's one commit to agg/<task>, the same commit it compared", async () => {
    const setup = setUp();
    const sha = commit(setup.worktree, { "src/a.txt": "work\n" });
    const tools = await forge(setup);
    expect(await tools.pushBranch()).toEqual({
      ok: true,
      text: FORGE_TEXT.pushed(sha, setup.target.branch),
    });
    expect(tools.pushed).toBe(sha);
    expect(tools.refusal).toBeUndefined();
    expect(remoteBranch(setup.remote, setup.target.branch)).toBe(sha);
    expect(remoteBranch(setup.remote, "main")).not.toBe(sha);
  });

  it.each([
    ["changes a workflow", { ".github/workflows/ci.yml": "on: push\npermissions: write-all\n" }],
    ["adds a workflow", { ".github/workflows/x.yml": "on: push\n" }],
    ["adds a local action", { ".github/actions/a/action.yml": "runs: {}\n" }],
  ])("refuses a branch that %s, and pushes nothing", async (_what, files) => {
    const setup = setUp();
    commit(setup.worktree, { "src/a.txt": "work\n", ...files });
    const tools = await forge(setup);
    expect(await tools.pushBranch()).toEqual({
      ok: false,
      text: FORGE_TEXT.refused(FORGE_TEXT.github),
    });
    expect(tools.refusal).toBe(FORGE_TEXT.refused(FORGE_TEXT.github));
    expect(tools.pushed).toBeUndefined();
    expect(remoteBranch(setup.remote, setup.target.branch)).toBe("");
  });

  it("refuses a branch with no history in common with the default branch", async () => {
    const setup = setUp();
    git(setup.worktree, "checkout", "-q", "--orphan", "lonely");
    git(setup.worktree, "rm", "-rq", "--cached", ".");
    writeFileSync(join(setup.worktree, "other"), "x\n");
    git(setup.worktree, "add", "other");
    git(setup.worktree, "commit", "-q", "-m", "orphan");
    git(setup.worktree, "branch", "-f", setup.target.branch, "HEAD");
    const tools = await forge(setup);
    expect((await tools.pushBranch()).text).toBe(FORGE_TEXT.refused(FORGE_TEXT.noHistory));
    expect(remoteBranch(setup.remote, setup.target.branch)).toBe("");
  });

  it("refuses when the default branch's tip cannot be fetched", async () => {
    const setup = setUp();
    commit(setup.worktree, { "src/a.txt": "work\n" });
    git(setup.main, "remote", "set-url", "origin", join(sandbox, "missing.git"));
    const tools = await forge(setup);
    expect((await tools.pushBranch()).text).toBe(FORGE_TEXT.refused(FORGE_TEXT.noTip));
  });

  it("refuses when the fetch after ls-remote fails", async () => {
    const setup = setUp();
    commit(setup.worktree, { "src/a.txt": "work\n" });
    const tools = await forge(
      setup,
      runner(() => null, "fetch"),
    );
    expect((await tools.pushBranch()).text).toBe(FORGE_TEXT.refused(FORGE_TEXT.noFetch));
  });

  it.each(["merge-base", "diff"])("refuses when %s itself fails", async (step) => {
    const setup = setUp();
    commit(setup.worktree, { "src/a.txt": "work\n" });
    const tools = await forge(
      setup,
      runner(() => null, step),
    );
    expect((await tools.pushBranch()).text).toBe(FORGE_TEXT.refused(FORGE_TEXT.compare));
    expect(remoteBranch(setup.remote, setup.target.branch)).toBe("");
  });

  it("does not trust a main checkout's refs/remotes/origin/main moved to the worker's commit", async () => {
    const setup = setUp();
    const sha = commit(setup.worktree, { ".github/workflows/x.yml": "on: push\n" });
    git(setup.main, "update-ref", "refs/remotes/origin/main", sha);
    const tools = await forge(setup);
    expect((await tools.pushBranch()).text).toBe(FORGE_TEXT.refused(FORGE_TEXT.github));
    expect(remoteBranch(setup.remote, setup.target.branch)).toBe("");
  });

  it("is not fooled by a replace ref the worker planted in the shared .git", async () => {
    const setup = setUp();
    const clean = commit(setup.worktree, { "src/a.txt": "work\n" });
    const dirty = commit(setup.worktree, { ".github/workflows/x.yml": "on: push\n" });
    git(setup.main, "replace", dirty, clean);
    const tools = await forge(setup);
    expect((await tools.pushBranch()).text).toBe(FORGE_TEXT.refused(FORGE_TEXT.github));
    expect(remoteBranch(setup.remote, setup.target.branch)).toBe("");
  });

  it("is not fooled by an object the worker rewrote in the shared .git", async () => {
    const setup = setUp();
    const clean = commit(setup.worktree, { "src/a.txt": "work\n" });
    const dirty = commit(setup.worktree, { ".github/workflows/x.yml": "on: push\n" });
    const objects = join(setup.main, ".git", "objects");
    const path = (sha: string) => join(objects, sha.slice(0, 2), sha.slice(2));
    unlinkSync(path(dirty));
    copyFileSync(path(clean), path(dirty));
    const shown = git(setup.main, "diff", "--name-only", "origin/main", dirty, "--", ".github/");
    expect(shown).toBe("");
    const tools = await forge(setup);
    expect((await tools.pushBranch()).text).toBe(FORGE_TEXT.refused(FORGE_TEXT.noBranch));
    expect(remoteBranch(setup.remote, setup.target.branch)).toBe("");
  });

  it("refuses an origin git would run a program for", async () => {
    const setup = setUp();
    commit(setup.worktree, { "src/a.txt": "work\n" });
    git(setup.main, "remote", "set-url", "origin", "ext::sh -c touch% /tmp/x");
    const tools = await forge(setup);
    expect((await tools.pushBranch()).text).toBe(FORGE_TEXT.refused(FORGE_TEXT.remote));
  });

  it("refuses a branch that does not exist", async () => {
    const setup = setUp();
    git(setup.main, "worktree", "remove", "--force", setup.worktree);
    git(setup.main, "branch", "-D", setup.target.branch);
    const tools = await forge(setup);
    expect((await tools.pushBranch()).text).toBe(FORGE_TEXT.refused(FORGE_TEXT.noBranch));
  });

  it("clears an earlier refusal once a push goes through", async () => {
    const setup = setUp();
    commit(setup.worktree, { ".github/workflows/x.yml": "on: push\n" });
    const tools = await forge(setup);
    await tools.pushBranch();
    git(setup.worktree, "reset", "-q", "--hard", "origin/main");
    const sha = commit(setup.worktree, { "src/a.txt": "work\n" });
    expect((await tools.pushBranch()).text).toBe(FORGE_TEXT.pushed(sha, setup.target.branch));
    expect(tools.refusal).toBeUndefined();
  });
});

describe("open_pr", () => {
  const PR = "https://github.com/owner/app/pull/7";

  it("opens nothing before a push went through", async () => {
    const setup = setUp();
    const recorded = runner(() => PR);
    const tools = await forge(setup, recorded);
    expect((await tools.openPr("t", "b")).text).toBe(FORGE_TEXT.notPushed);
    expect(recorded.calls.filter((call) => call.file === "gh")).toEqual([]);
  });

  it("runs gh pr create for the pushed branch into the default branch, and keeps gh's URL", async () => {
    const setup = setUp();
    commit(setup.worktree, { "src/a.txt": "work\n" });
    const recorded = runner(() => `Creating pull request\n${PR}\n`);
    const tools = await forge(setup, recorded);
    await tools.pushBranch();
    git(setup.main, "remote", "set-url", "origin", "https://github.com/owner/app.git");
    expect((await tools.openPr("標題", "內文")).text).toBe(FORGE_TEXT.opened(PR));
    expect(tools.prUrl).toBe(PR);
    const [call] = recorded.calls.filter((each) => each.file === "gh");
    expect(call?.args).toEqual([
      "pr",
      "create",
      "--repo",
      "owner/app",
      "--base",
      "main",
      "--head",
      setup.target.branch,
      "--title",
      "標題",
      "--body",
      "內文",
    ]);
    expect(call?.env).toEqual({ ...ENV, GH_PROMPT_DISABLED: "1" });
  });

  it("opens no PR for an origin that is not on GitHub", async () => {
    const setup = setUp();
    commit(setup.worktree, { "src/a.txt": "work\n" });
    const recorded = runner(() => PR);
    const tools = await forge(setup, recorded);
    await tools.pushBranch();
    expect((await tools.openPr("t", "b")).text).toBe(FORGE_TEXT.notGithub);
  });

  it("says what gh said when it fails", async () => {
    const setup = setUp();
    commit(setup.worktree, { "src/a.txt": "work\n" });
    const tools = await forge(
      setup,
      runner(() => null),
    );
    await tools.pushBranch();
    git(setup.main, "remote", "set-url", "origin", "git@github.com:owner/app.git");
    expect((await tools.openPr("t", "b")).text).toBe(FORGE_TEXT.prFailed("gh: no"));
    expect(tools.prUrl).toBeUndefined();
  });
});

describe("githubRepo and tipOf", () => {
  it.each([
    ["https://github.com/o/r.git", "o/r"],
    ["https://github.com/o/r", "o/r"],
    ["git@github.com:o/r.git", "o/r"],
    ["ssh://git@github.com/o/r.git", "o/r"],
    ["https://gitlab.com/o/r.git", undefined],
    ["/srv/r.git", undefined],
  ])("reads %s as %s", (url, repo) => {
    expect(githubRepo(url)).toBe(repo);
  });

  it("takes exactly the one line for the ref", () => {
    const sha = "a".repeat(40);
    expect(tipOf(`${sha}\trefs/heads/main\n`, "main")).toBe(sha);
    expect(tipOf(`${sha}\trefs/heads/other\n`, "main")).toBeUndefined();
    expect(tipOf(`${sha}\trefs/heads/main\n${sha}\trefs/heads/main\n`, "main")).toBeUndefined();
    expect(tipOf(`zz\trefs/heads/main\n`, "main")).toBeUndefined();
    expect(tipOf("", "main")).toBeUndefined();
  });
});
