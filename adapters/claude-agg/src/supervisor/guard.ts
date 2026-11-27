// The PreToolUse guard every worker and planner session runs: a second layer
// behind the `disallowedTools` rules (plan section 5.3). It refuses
//   - running myshape.sh (only the supervisor writes the board),
//   - touching the board home, including state/myshape/** and the agent's own
//     state files, by path or by naming it in a command (also as ~/…,
//     $HOME/… or ${HOME}/…),
//   - merging a pull request (gh pr merge, the REST merge route, or a GraphQL
//     merge mutation),
//   - pushing to the repository's default branch, or a push that does not
//     name its branch (HEAD and @ alike),
//   - requests to the board's port,
//   - a Bash call that asks to run outside the sandbox (dangerouslyDisableSandbox).
// A shell command can be written in more ways than any check can follow, so
// this is a guard rail, not a boundary. Anything it cannot read is refused.
//
// In a worker session it also approves Bash (`approvesSandboxedBash`):
// Claude Code's own sandbox auto-allow is off whenever the subprocess scrub is
// set, so the guard answers `allow` for a Bash call that passes every check
// above and is not one of the shapes that auto-allow never covers
// (sandboxApprovable). Such a call runs in the sandbox, which is mandatory.
// Everything else gets no decision, so the session's rules decide and, with no
// approval surface, deny what would need approval.

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { HookInput } from "@anthropic-ai/claude-agent-sdk";

import type { PreToolUseOutput } from "./sdk.js";

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
  /** The session's HOME, which `~` and `$HOME` stand for in a command or path. */
  userHome: string;
  /**
   * Whether the guard approves a sandbox-approvable Bash call (a worker, whose
   * Bash always runs in the sandbox); false where there is no sandbox (the
   * planner).
   */
  approvesSandboxedBash: boolean;
}

export type GuardDecision = { allow: true } | { allow: false; reason: string };

const ALLOW: GuardDecision = { allow: true };

export const REASONS = {
  unreadable: "看不懂這個工具呼叫的參數，不執行。",
  board: "只有 supervisor 會寫看板：worker 不跑 myshape.sh。",
  home: "worker 不碰看板的 home（包括 state/myshape/ 與 agg/）。",
  merge: "worker 不合併 PR：推分支、開 PR，合併由 captain 決定。",
  pushDefault: "worker 不推預設分支：用 push_branch 工具推自己的 agg/<task> 分支。",
  pushUnnamed: "worker 不自己推送：用 push_branch 工具推自己的 agg/<task> 分支。",
  port: "worker 不連看板的埠。",
  noPush: "這個 session 不推任何東西。",
  unsandboxed: "Bash 只在 sandbox 裡跑：不接受 dangerouslyDisableSandbox。",
  sandboxed: "在 sandbox 裡跑，supervisor 的 guard 核准。",
} as const;

/**
 * First words that Claude Code 2.1.332's sandbox auto-allow never covers:
 * programs that run another program, and the awk family.
 */
const NEVER_APPROVED = new Set([
  "env",
  "time",
  "nohup",
  "timeout",
  "nice",
  "stdbuf",
  "command",
  "builtin",
  "noglob",
  "eval",
  "awk",
  "gawk",
  "mawk",
  "nawk",
]);

/** An `rm`/`rmdir` operand the guard approves: a plain relative path below the cwd. */
function plainRemovable(operand: string): boolean {
  if (operand.startsWith("-")) return true;
  if (operand.startsWith("/") || operand.startsWith("~") || operand.includes("$")) return false;
  const parts = operand.split("/").filter((part) => part !== "");
  return parts.length > 0 && parts.every((part) => part !== ".." && part !== "." && part !== "*");
}

/** Whether one simple command's words are a shape the guard may approve. */
function approvableWords(words: readonly string[]): boolean {
  const [first = "", ...rest] = words;
  if (/^[A-Za-z_]\w*\+?=/.test(first)) return false;
  const name = first.replace(/^.*\//, "");
  if (NEVER_APPROVED.has(name)) return false;
  if (name === "rm" || name === "rmdir") {
    return rest.some((word) => !word.startsWith("-")) && rest.every(plainRemovable);
  }
  return true;
}

/**
 * Whether a Bash command is a shape the guard may approve: never wider than
 * Claude Code's own sandbox auto-allow. Refused shapes: a first word in
 * NEVER_APPROVED, a leading VAR=, a here-document, ${!…} or ${ |…}, anything
 * naming /proc/…/environ or /dev/tcp|udp, command substitution, a background
 * `&`, and rm/rmdir of anything but plain relative paths.
 */
export function sandboxApprovable(command: string): boolean {
  if (/<</.test(command)) return false;
  if (/\$\{[!\s|]/.test(command)) return false;
  if (/\/proc\/\S*environ/.test(command) || /\/dev\/(tcp|udp)\//.test(command)) return false;
  if (/`|\$\(/.test(command)) return false;
  const withoutRedirects = command.replaceAll(/&&|\d*>&\d*-?|&>>?|<&\d*-?/g, "");
  if (withoutRedirects.includes("&")) return false;
  return segments(command).every(approvableWords);
}

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

/** Where a Glob pattern starts: its part before the first wildcard, under `path` when given. */
function globBase(pattern: string, path: unknown): string {
  const wildcard = pattern.search(/[*?[{]/);
  const literal = wildcard === -1 ? pattern : pattern.slice(0, wildcard);
  if (isAbsolute(literal)) return literal;
  return join(typeof path === "string" ? path : ".", literal);
}

/** The command with quotes and backslashes taken out and runs of spaces made one. */
function normalize(command: string): string {
  return command.replaceAll(/["'\\`]/g, "").replaceAll(/\s+/g, " ");
}

/** `text` with a leading ~ and every $HOME or ${HOME} spelled out as the session's HOME. */
function expandHome(text: string, userHome: string): string {
  return text
    .replaceAll(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, userHome)
    .replaceAll(/(^|[\s=:])~(?=\/|$)/g, `$1${userHome}`);
}

function checkPaths(tool: string, input: Record<string, unknown>, cwd: string, ctx: GuardContext) {
  const fields = PATH_TOOLS[tool] ?? [];
  const paths = [cwd];
  for (const field of fields) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== "string") return deny(REASONS.unreadable);
    const path = expandHome(value, ctx.userHome);
    paths.push(field === "pattern" ? globBase(path, input["path"]) : path);
  }
  for (const path of paths) {
    if (inside(ctx.realPath(resolve(cwd, path)), ctx.home)) return deny(REASONS.home);
  }
  return ALLOW;
}

/**
 * The words of each simple command in `command` (as the session sent it):
 * continued lines joined, then split at ;, &, |, newlines and parentheses,
 * then each part normalized.
 */
function segments(command: string): string[][] {
  return command
    .replaceAll(/\\\r?\n/g, " ")
    .split(/[;&|\r\n()]+/)
    .map((part) => normalize(part).trim().split(" ").filter(Boolean))
    .filter((words) => words.length > 0);
}

/** Git's options before the subcommand that take the next word as their value. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

/** The words after `push` when the git at `git` runs `push`, or undefined when it does not. */
function pushAt(words: readonly string[], git: number): string[] | undefined {
  for (let at = git + 1; at < words.length; at += 1) {
    const word = words[at] ?? "";
    if (GIT_VALUE_OPTIONS.has(word)) at += 1;
    else if (!word.startsWith("-")) return word === "push" ? words.slice(at + 1) : undefined;
  }
  return undefined;
}

/** The arguments of every `git … push` in one simple command, whichever `git` word starts it. */
function pushes(words: readonly string[]): string[][] {
  const found: string[][] = [];
  words.forEach((word, at) => {
    if (word !== "git" && !word.endsWith("/git")) return;
    const args = pushAt(words, at);
    if (args !== undefined) found.push(args);
  });
  return found;
}

/** A ref as a branch name; `@` is git's other spelling of HEAD. */
function refName(ref: string): string {
  const name = ref.replace(/^\+/, "").replace(/^refs\/heads\//, "");
  return name === "@" ? "HEAD" : name;
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
    if (refspec.includes("*")) return deny(REASONS.pushDefault);
    const [source = "", destination] = refspec.split(":");
    const target = refName(destination ?? source);
    if (destination === undefined && refName(source) === "HEAD") {
      return deny(REASONS.pushUnnamed);
    }
    if (target === defaultBranch || target === "HEAD") return deny(REASONS.pushDefault);
  }
  return ALLOW;
}

/** GraphQL mutations that merge a pull request or set it to merge by itself. */
const MERGE_MUTATION =
  /mergePullRequest|enablePullRequestAutoMerge|mergeBranch|enqueuePullRequest/i;

function namesHome(plain: string, ctx: GuardContext): boolean {
  const expanded = expandHome(plain, ctx.realPath(ctx.userHome));
  return [plain, expandHome(plain, ctx.userHome), expanded].some((text) => text.includes(ctx.home));
}

function checkCommand(command: string, ctx: GuardContext): GuardDecision {
  const plain = normalize(command);
  if (/myshape(-lib)?\.sh/.test(plain)) return deny(REASONS.board);
  if (namesHome(plain, ctx) || /MYSHAPE_|state\/myshape/.test(plain)) {
    return deny(REASONS.home);
  }
  if (/\bgh pr merge\b/.test(plain) || /\bgh api\b.*\/merge\b/.test(plain)) {
    return deny(REASONS.merge);
  }
  if (/\bgh api\b/.test(plain) && /\bgraphql\b/.test(plain) && MERGE_MUTATION.test(plain)) {
    return deny(REASONS.merge);
  }
  if (new RegExp(`:${ctx.port}(?!\\d)`).test(plain)) return deny(REASONS.port);
  for (const args of segments(command).flatMap(pushes)) {
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
    const { command, dangerouslyDisableSandbox: unsandboxed } = input;
    if (unsandboxed === true || unsandboxed === "true") return deny(REASONS.unsandboxed);
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
export function preToolUseHook(
  ctx: GuardContext,
): (input: HookInput, toolUseId: string | undefined) => Promise<PreToolUseOutput> {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const { tool_name: tool, tool_input: toolInput, cwd } = input;
    const decision =
      typeof tool === "string" && typeof cwd === "string" && isAbsolute(cwd)
        ? guardToolUse(tool, toolInput, cwd, ctx)
        : deny(REASONS.unreadable);
    if (!decision.allow) return answer("deny", decision.reason);
    if (approvesBash(tool, toolInput, ctx)) return answer("allow", REASONS.sandboxed);
    return {};
  };
}

/** Whether the guard approves this call: a worker's sandbox-approvable Bash command. */
function approvesBash(tool: unknown, input: unknown, ctx: GuardContext): boolean {
  if (!ctx.approvesSandboxedBash || tool !== "Bash" || !isRecord(input)) return false;
  const { command } = input;
  return typeof command === "string" && sandboxApprovable(command);
}

function answer(decision: "allow" | "deny", reason: string): PreToolUseOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}
