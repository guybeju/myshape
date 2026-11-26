// The PreToolUse guard every worker and planner session runs: a second layer
// behind the `disallowedTools` rules (plan section 5.3). It refuses
//   - running myshape.sh (only the supervisor writes the board),
//   - touching the board home, including state/myshape/** and the agent's own
//     state files, by path or by naming it in a command,
//   - merging a pull request,
//   - pushing to the repository's default branch, or a push that does not
//     name its branch,
//   - requests to the board's port.
// A shell command can be written in more ways than any check can follow, so
// this is a guard rail, not a boundary. Anything it cannot read is refused.

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { PreToolUseHook, PreToolUseOutput } from "./sdk.js";

export interface GuardContext {
  /** The board home, as an absolute path with symbolic links resolved. */
  home: string;
  /** The board's TCP port. */
  port: number;
  /**
   * The default branch of the repository the session works in, such as
   * `main`; null for a session that may push nothing (the planner).
   */
  defaultBranch: string | null;
  /** An absolute path with every symbolic link in it resolved, as far as it exists. */
  realPath: (path: string) => string;
}

export type GuardDecision = { allow: true } | { allow: false; reason: string };

const ALLOW: GuardDecision = { allow: true };

export const REASONS = {
  unreadable: "看不懂這個工具呼叫的參數，不執行。",
  board: "只有 supervisor 會寫看板：worker 不跑 myshape.sh。",
  home: "worker 不碰看板的 home（包括 state/myshape/ 與 agg/）。",
  merge: "worker 不合併 PR：推分支、開 PR，合併由 captain 決定。",
  pushDefault: "worker 不推預設分支：推自己的 agg/<task> 分支。",
  pushUnnamed: "要寫明推哪個分支，例如 git push origin agg/<task>。",
  port: "worker 不連看板的埠。",
  noPush: "這個 session 不推任何東西。",
} as const;

const PATH_TOOLS: Readonly<Record<string, readonly string[]>> = {
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"],
  Glob: ["path", "pattern"],
  Grep: ["path"],
  LS: ["path"],
};

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0", "[::1]", "::1"]);

/**
 * `path` (absolute) with its symbolic links resolved: the longest part of it
 * that exists, resolved, with the rest appended. The guard's `realPath` in a
 * real session.
 */
export function existingRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(existingRealPath(parent), basename(path));
  }
}

function deny(reason: string): GuardDecision {
  return { allow: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/** The command with quotes and backslashes taken out and runs of spaces made one. */
function normalize(command: string): string {
  return command.replaceAll(/["'\\`]/g, "").replaceAll(/\s+/g, " ");
}

function checkPaths(tool: string, input: Record<string, unknown>, cwd: string, ctx: GuardContext) {
  const fields = PATH_TOOLS[tool] ?? [];
  const paths = [cwd];
  for (const field of fields) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== "string") return deny(REASONS.unreadable);
    if (field === "pattern" && !isAbsolute(value)) continue;
    paths.push(value);
  }
  for (const path of paths) {
    if (inside(ctx.realPath(resolve(cwd, path)), ctx.home)) return deny(REASONS.home);
  }
  return ALLOW;
}

/** The words of each simple command in `command`, split at ;, &, |, newlines and parentheses. */
function segments(command: string): string[][] {
  return command
    .split(/[;&|\n()]+/)
    .map((part) => part.trim().split(" ").filter(Boolean))
    .filter((words) => words.length > 0);
}

/** Git's options before the subcommand that take the next word as their value. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

/** The words after `push` when git's subcommand is `push`, or undefined when it is not. */
function pushArgs(words: readonly string[]): string[] | undefined {
  const git = words.findIndex((word) => word === "git" || word.endsWith("/git"));
  if (git === -1) return undefined;
  for (let at = git + 1; at < words.length; at += 1) {
    const word = words[at] ?? "";
    if (GIT_VALUE_OPTIONS.has(word)) at += 1;
    else if (!word.startsWith("-")) return word === "push" ? words.slice(at + 1) : undefined;
  }
  return undefined;
}

function refName(ref: string): string {
  return ref.replace(/^\+/, "").replace(/^refs\/heads\//, "");
}

function checkPush(args: readonly string[], defaultBranch: string | null): GuardDecision {
  if (defaultBranch === null) return deny(REASONS.noPush);
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "--all" || arg === "--mirror" || arg === "--branches") {
      return deny(REASONS.pushDefault);
    }
    if (!arg.startsWith("-")) positional.push(arg);
  }
  const refspecs = positional.slice(1);
  if (refspecs.length === 0) return deny(REASONS.pushUnnamed);
  for (const refspec of refspecs) {
    const [source = "", destination] = refspec.split(":");
    const target = refName(destination ?? source);
    if (destination === undefined && refName(source) === "HEAD") {
      return deny(REASONS.pushUnnamed);
    }
    if (target === defaultBranch || target === "HEAD") return deny(REASONS.pushDefault);
  }
  return ALLOW;
}

function checkCommand(command: string, ctx: GuardContext): GuardDecision {
  const plain = normalize(command);
  if (/myshape(-lib)?\.sh/.test(plain)) return deny(REASONS.board);
  if (plain.includes(ctx.home) || /MYSHAPE_|state\/myshape/.test(plain)) {
    return deny(REASONS.home);
  }
  if (/\bgh pr merge\b/.test(plain) || /\bgh api\b.*\/merge\b/.test(plain)) {
    return deny(REASONS.merge);
  }
  if (new RegExp(`:${ctx.port}(?!\\d)`).test(plain)) return deny(REASONS.port);
  for (const words of segments(plain)) {
    const args = pushArgs(words);
    if (args === undefined) continue;
    const decision = checkPush(args, ctx.defaultBranch);
    if (!decision.allow) return decision;
  }
  return ALLOW;
}

function checkUrl(url: unknown, ctx: GuardContext): GuardDecision {
  if (typeof url !== "string") return deny(REASONS.unreadable);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return deny(REASONS.unreadable);
  }
  const defaultPort = parsed.protocol === "https:" ? "443" : "80";
  const port = Number(parsed.port === "" ? defaultPort : parsed.port);
  return LOCAL_HOSTS.has(parsed.hostname) && port === ctx.port ? deny(REASONS.port) : ALLOW;
}

/**
 * Whether a session may make this tool call.
 *
 * Args:
 *   tool: the tool's name, such as `Bash` or `Read`.
 *   input: the tool's input, as the session sent it.
 *   cwd: the session's working directory.
 *   ctx: the board home, its port and the default branch.
 */
export function guardToolUse(
  tool: string,
  input: unknown,
  cwd: string,
  ctx: GuardContext,
): GuardDecision {
  if (!isRecord(input)) return deny(REASONS.unreadable);
  const where = checkPaths(tool, input, cwd, ctx);
  if (!where.allow) return where;
  if (tool === "Bash") {
    const { command } = input;
    return typeof command === "string" ? checkCommand(command, ctx) : deny(REASONS.unreadable);
  }
  if (tool === "WebFetch") return checkUrl(input["url"], ctx);
  return ALLOW;
}

/**
 * The PreToolUse callback for `hooks`. A refusal is a `deny` with its reason;
 * anything else returns no decision, so the session's permission mode and
 * rules still decide.
 */
export function preToolUseHook(ctx: GuardContext): PreToolUseHook {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const { tool_name: tool, tool_input: toolInput, cwd } = input;
    const decision =
      typeof tool === "string" && typeof cwd === "string" && isAbsolute(cwd)
        ? guardToolUse(tool, toolInput, cwd, ctx)
        : deny(REASONS.unreadable);
    if (decision.allow) return {};
    const output: PreToolUseOutput = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: decision.reason,
      },
    };
    return output;
  };
}
