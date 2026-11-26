// Test doubles for the supervisor: a scripted `query()` that never calls a
// model, a command runner that plays git, the board's command and gh in
// memory, and a scratch board home. Nothing here starts a process.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandRequest, CommandResult, PlainEnv, RunCommand } from "./commands.js";
import { removeHomes, writeHome } from "./fixtures.test-helper.js";
import type { QueryFn, QueryOptions, UserMessage } from "./sdk.js";

export const CANARY = "sk-ant-oat01-CANARY-not-a-real-token";

export const ENV: PlainEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/tester",
  LANG: "C.UTF-8",
  TMPDIR: "/tmp",
};

// --- messages ------------------------------------------------------------------

export function init(session: string, mode = "auto", apiKeySource = "none", model = "test-model") {
  return {
    type: "system",
    subtype: "init",
    session_id: session,
    permissionMode: mode,
    apiKeySource,
    model,
  };
}

export function result(output: unknown, cost = 0.25) {
  return {
    type: "result",
    subtype: "success",
    session_id: "s",
    is_error: false,
    num_turns: 3,
    total_cost_usd: cost,
    structured_output: output,
  };
}

export function maxTurns(cost = 1.5) {
  return {
    type: "result",
    subtype: "error_max_turns",
    session_id: "s",
    is_error: true,
    num_turns: 200,
    total_cost_usd: cost,
    errors: [],
  };
}

export function rejected(resetsAt?: number) {
  const info: Record<string, unknown> = { status: "rejected" };
  if (resetsAt !== undefined) info["resetsAt"] = resetsAt;
  return { type: "rate_limit_event", session_id: "s", rate_limit_info: info };
}

export function errorResult(errors: string[], status?: number) {
  const message: Record<string, unknown> = {
    type: "result",
    subtype: "error_during_execution",
    session_id: "s",
    is_error: true,
    num_turns: 1,
    total_cost_usd: 0.1,
    errors,
  };
  if (status !== undefined) message["api_error_status"] = status;
  return message;
}

export function workerOutput(outcome: string, extra: Record<string, unknown> = {}) {
  return {
    outcome,
    summary: `worker ${outcome}`,
    pr_url: null,
    todos: [],
    question: null,
    ...extra,
  };
}

export function plan(tasks: { title: string; repo: string; kind: string; prompt: string }[]) {
  return { tasks, question: null, nothing: tasks.length === 0 };
}

// --- query ---------------------------------------------------------------------

/** A gate a script waits on, opened by the test. */
export class Gate {
  readonly opened: Promise<void>;
  open!: () => void;
  constructor() {
    this.opened = new Promise((resolve) => (this.open = resolve));
  }
}

export interface Call {
  options: QueryOptions;
  prompts: string[];
  /** The script the session took, if one was left. */
  script: Script | undefined;
}

/** What one session does: the messages it sends, after waiting on its gate. */
export interface Script {
  messages: object[];
  gate?: Gate;
  /** Thrown after the messages. */
  error?: Error;
}

/**
 * A `query()` double. Each call takes the next script for its kind (worker
 * sessions run in the worktree root's task directories, the planner in the
 * root itself) and records its options and prompts.
 */
export class ScriptedQuery {
  readonly calls: Call[] = [];
  /** The sessions that started and have not ended. */
  readonly active = new Set<Call>();
  readonly worker: Script[] = [];
  readonly planner: Script[] = [];
  aborted = 0;

  constructor(private readonly root: string) {}

  readonly query: QueryFn = ({ prompt, options }) => {
    const queue = options.cwd === this.root ? this.planner : this.worker;
    const script = queue.shift();
    const call: Call = { options, prompts: [], script };
    this.calls.push(call);
    options.abortController.signal.addEventListener("abort", () => (this.aborted += 1));
    return run(script, prompt, call, this.active);
  };
}

async function* run(
  script: Script | undefined,
  prompt: AsyncIterable<UserMessage>,
  call: Call,
  active: Set<Call>,
) {
  active.add(call);
  try {
    const reader = prompt[Symbol.asyncIterator]();
    const first = await reader.next();
    if (!first.done) call.prompts.push(first.value.message.content);
    if (script === undefined) throw new Error("no script left for this session");
    await script.gate?.opened;
    for (const message of script.messages) yield message;
    if (script.error !== undefined) throw script.error;
  } finally {
    active.delete(call);
  }
}

// --- commands ------------------------------------------------------------------

/**
 * Plays git (worktree add, remove, list; rev-list), the board's command
 * (status, open, summary) and gh (pr view) in memory, and records each call.
 */
export class FakeCommands {
  readonly calls: CommandRequest[] = [];
  readonly worktrees = new Map<string, Set<string>>();
  readonly unpushed = new Map<string, number>();
  readonly prStates = new Map<string, string>();
  readonly summaries: { task: string; kind: string; text: string }[] = [];
  failAdd = false;
  summaryStatus = 0;

  constructor(private readonly boardCommand: string) {}

  readonly run: RunCommand = async (request) => {
    this.calls.push(request);
    if (request.file === this.boardCommand) return this.board(request);
    if (request.file === "git") return this.git(request.args);
    if (request.file === "gh") return this.gh(request.args);
    return done(127, "", `unknown program ${request.file}`);
  };

  private board(request: CommandRequest): CommandResult {
    const [command, task = "", kind = ""] = request.args;
    if (command === "status") return done(0, "看板服務：在跑\n");
    if (command === "open") return done(0, "http://127.0.0.1:1/\n");
    if (command === "summary" && this.summaryStatus === 0) {
      this.summaries.push({ task, kind, text: request.input ?? "" });
    }
    return done(this.summaryStatus, "", this.summaryStatus === 0 ? "" : "refused");
  }

  private git(args: readonly string[]): CommandResult {
    const [flag, dir = "", ...rest] = args;
    if (flag !== "-C") return done(2, "", "no -C");
    const sub = rest.join(" ");
    const listed = this.worktrees.get(dir) ?? new Set<string>();
    this.worktrees.set(dir, listed);
    if (sub.startsWith("worktree add ")) {
      if (this.failAdd) return done(128, "", "fatal: cannot add");
      listed.add(rest[2] ?? "");
      return done(0);
    }
    if (sub.startsWith("worktree remove ")) {
      listed.delete(rest[2] ?? "");
      return done(0);
    }
    if (sub === "worktree list --porcelain") {
      const lines = [dir, ...listed].map((path) => `worktree ${path}\n`);
      return done(0, lines.join("\n"));
    }
    if (sub === "rev-list --count HEAD --not --remotes") {
      return done(0, `${this.unpushed.get(dir) ?? 0}\n`);
    }
    return done(2, "", `unplayed git ${sub}`);
  }

  private gh(args: readonly string[]): CommandResult {
    const state = this.prStates.get(args[2] ?? "");
    return state === undefined ? done(1, "", "no such PR") : done(0, JSON.stringify({ state }));
  }

  /** Every worktree path the fake git holds, under any repository. */
  allWorktrees(): string[] {
    return [...this.worktrees.values()].flatMap((paths) => [...paths]);
  }
}

function done(status: number, stdout = "", stderr = ""): CommandResult {
  return { status, stdout, stderr };
}

// --- a board home ----------------------------------------------------------------

export interface Topics {
  high?: string[];
  normal?: string[];
  later?: string[];
}

/** A scratch board home with these topics in these queues, and a worktree root beside it. */
export function boardHome(queues: Topics, hashtags: Record<string, string[]> = {}) {
  const ids = [...(queues.high ?? []), ...(queues.normal ?? []), ...(queues.later ?? [])];
  const topics = Object.fromEntries(
    ids.map((id) => [
      id,
      { name: `議題 ${id}`, goal: `目標 ${id}`, created_at: "2026-11-27T00:00:00Z" },
    ]),
  );
  const home = writeHome({
    topics: {
      topics,
      queues: { high: queues.high ?? [], normal: queues.normal ?? [], later: queues.later ?? [] },
      merged: {},
    },
    hashtags: { topics: hashtags, hashtags: {} },
  });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-agg-work-")));
  roots.push(root);
  return { home: realpathSync(home), root };
}

const roots: string[] = [];

/** Removes every scratch home and worktree root; for `afterAll`. */
export function removeScratch(): void {
  removeHomes();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}
