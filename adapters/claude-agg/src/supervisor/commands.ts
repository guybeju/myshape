// The commands the supervisor runs, each through one injected runner: the
// board's command (bin/myshape.sh: summary, todo, close-propose, hashtag,
// status, open), git (worktrees) and
// gh (a pull request's state). Each command gets an environment built here
// from a few names; none of them ever gets the subscription token.

import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import { SUMMARY_MAX } from "./session-options.js";

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface CommandRequest {
  file: string;
  args: readonly string[];
  env: Record<string, string>;
  input?: string;
}

/** Runs one program, no shell, and resolves with how it ended. */
export type RunCommand = (request: CommandRequest) => Promise<CommandResult>;

/**
 * The production runner: `spawn` with exactly the given environment. stdin is
 * a pipe only when there is input; a program that exits before reading it
 * (EPIPE) is not an error, its exit status says how it went.
 */
export const spawnCommand: RunCommand = (request) =>
  new Promise((resolve, reject) => {
    const child = spawn(request.file, [...request.args], {
      env: request.env,
      stdio: [request.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin?.end(request.input);
  });

/** The few names every command's environment is built from. */
export interface PlainEnv {
  PATH: string;
  HOME: string;
  LANG: string;
  TMPDIR: string;
}

export type SummaryKind = "ready" | "report" | "failed" | "landed";

/** A 要你動手 item as `todo add` takes it, already within the board's limits. */
export interface BoardTodo {
  /** The item id: the task id, a dash, and the worker's own id for it. */
  id: string;
  title: string;
  topic: string;
  do: string;
  cmds: string[];
  /** Handed back in the board's notices about the item: the task id. */
  ref: string;
}

/** `text` cut to at most `max` Unicode code points, ending in … when cut. */
export function clip(text: string, max = SUMMARY_MAX): string {
  const points = [...text.trim()];
  return points.length <= max ? points.join("") : `${points.slice(0, max - 1).join("")}…`;
}

/** The board's command for one board home. */
export class BoardCommand {
  private readonly run: RunCommand;
  private readonly path: string;
  private readonly env: Record<string, string>;

  constructor(run: RunCommand, path: string, home: string, env: PlainEnv) {
    if (!isAbsolute(path)) throw new Error(`the board's command must be an absolute path: ${path}`);
    this.run = run;
    this.path = path;
    this.env = { MYSHAPE_HOME: home, ...env };
  }

  private call(args: string[], input?: string): Promise<CommandResult> {
    const request: CommandRequest = { file: this.path, args, env: this.env };
    if (input !== undefined) request.input = input;
    return this.run(request);
  }

  /**
   * Stores a summary of the task (`myshape.sh summary <task> <kind> -`). Exit 3
   * (sent, no answer) is repeated once; a repeat of the same text is safe.
   *
   * Returns:
   *   undefined when stored, else the board's one-line reason.
   */
  async summary(task: string, kind: SummaryKind, text: string): Promise<string | undefined> {
    const args = ["summary", task, kind, "-"];
    let result = await this.call(args, clip(text));
    if (result.status === 3) result = await this.call(args, clip(text));
    return result.status === 0 ? undefined : failure("summary", result);
  }

  /**
   * Runs one board write. Exit 3 (sent, no answer) is repeated once: every
   * write here is safe to repeat unchanged.
   *
   * Returns:
   *   undefined when the board took it, else its one-line reason.
   */
  private async write(args: string[]): Promise<string | undefined> {
    let result = await this.call(args);
    if (result.status === 3) result = await this.call(args);
    return result.status === 0
      ? undefined
      : failure(args[0] === "todo" ? `todo ${args[1]}` : `${args[0]}`, result);
  }

  /** Puts a 要你動手 item on the board, or rewrites it (`myshape.sh todo add`). */
  todoAdd(item: BoardTodo): Promise<string | undefined> {
    const cmds = item.cmds.flatMap((cmd) => ["--cmd", cmd]);
    return this.write([
      "todo",
      "add",
      item.id,
      item.title,
      "--topic",
      item.topic,
      "--do",
      item.do,
      ...cmds,
      "--ref",
      item.ref,
    ]);
  }

  /** Closes an item the captain did and the worker found done (`myshape.sh todo done`). */
  todoDone(id: string): Promise<string | undefined> {
    return this.write(["todo", "done", id]);
  }

  /** Puts a claimed item back in front of the captain with the reason (`myshape.sh todo failed`). */
  todoFailed(id: string, reason: string): Promise<string | undefined> {
    return this.write(["todo", "failed", id, "--reason", reason]);
  }

  /** Takes an item no longer needed off the board (`myshape.sh todo obsolete`). */
  todoObsolete(id: string, reason: string): Promise<string | undefined> {
    return this.write(["todo", "obsolete", id, "--reason", reason]);
  }

  /** Proposes closing a topic whose tasks have all landed (`myshape.sh close-propose`). */
  closePropose(topic: string, reason: string): Promise<string | undefined> {
    return this.write(["close-propose", topic, "--reason", reason]);
  }

  /** Puts one hashtag on a topic or takes it off (`myshape.sh hashtag`). */
  hashtag(topic: string, change: "add" | "remove", name: string): Promise<string | undefined> {
    const args = change === "add" ? [`+${name}`] : ["--remove", name];
    return this.write(["hashtag", topic, ...args]);
  }

  /** Starts the board service when `myshape.sh status` does not say it runs. */
  async ensureRunning(): Promise<string | undefined> {
    const status = await this.call(["status"]);
    if (status.status === 0 && status.stdout.includes("看板服務：在跑")) return undefined;
    const open = await this.call(["open"]);
    return open.status === 0 ? undefined : failure("open", open);
  }
}

function failure(what: string, result: CommandResult): string {
  const line = result.stderr.trim().split("\n").at(-1) ?? "";
  return `myshape.sh ${what} exited ${String(result.status)}${line === "" ? "" : `: ${line}`}`;
}

/** Git, always with `-C <absolute path>`, never relying on the working directory. */
export class Git {
  private readonly run: RunCommand;
  private readonly env: Record<string, string>;

  constructor(run: RunCommand, env: PlainEnv) {
    this.run = run;
    this.env = { ...env, GIT_TERMINAL_PROMPT: "0" };
  }

  async git(dir: string, ...args: string[]): Promise<CommandResult> {
    if (!isAbsolute(dir)) throw new Error(`git needs an absolute directory: ${dir}`);
    return this.run({ file: "git", args: ["-C", dir, ...args], env: this.env });
  }

  /** `git worktree add <path> -b <branch> <base>` in the repository `repo`. */
  async addWorktree(
    repo: string,
    path: string,
    branch: string,
    base: string,
  ): Promise<string | undefined> {
    const result = await this.git(repo, "worktree", "add", path, "-b", branch, base);
    return result.status === 0 ? undefined : oneLine(result);
  }

  /** How many commits HEAD of the worktree has that no remote-tracking branch has, or undefined. */
  async unpushedCommits(worktree: string): Promise<number | undefined> {
    const result = await this.git(worktree, "rev-list", "--count", "HEAD", "--not", "--remotes");
    const count = Number(result.stdout.trim());
    return result.status === 0 && Number.isInteger(count) ? count : undefined;
  }

  /** `git worktree remove <path>`, never with --force: a worktree with changes stays. */
  async removeWorktree(repo: string, path: string): Promise<string | undefined> {
    const result = await this.git(repo, "worktree", "remove", path);
    return result.status === 0 ? undefined : oneLine(result);
  }

  /** The paths `git worktree list --porcelain` lists for `repo`, or undefined when it fails. */
  async worktrees(repo: string): Promise<string[] | undefined> {
    const result = await this.git(repo, "worktree", "list", "--porcelain");
    if (result.status !== 0) return undefined;
    return result.stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
  }
}

function oneLine(result: CommandResult): string {
  return result.stderr.trim().split("\n").at(-1) ?? `exit ${String(result.status)}`;
}

export type PullRequestState = "OPEN" | "MERGED" | "CLOSED";

/** A pull request's state through `gh pr view <url> --json state`, or undefined when unknown. */
export async function pullRequestState(
  run: RunCommand,
  env: PlainEnv,
  url: string,
): Promise<PullRequestState | undefined> {
  const result = await run({
    file: "gh",
    args: ["pr", "view", url, "--json", "state"],
    env: { ...env },
  });
  if (result.status !== 0) return undefined;
  try {
    const state = (JSON.parse(result.stdout) as { state?: unknown }).state;
    return state === "OPEN" || state === "MERGED" || state === "CLOSED" ? state : undefined;
  } catch {
    return undefined;
  }
}
