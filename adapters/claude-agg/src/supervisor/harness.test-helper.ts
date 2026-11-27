// Test doubles for the supervisor: a scripted `query()` that never calls a
// model, a command runner that plays git, the board's command and gh in
// memory, and a scratch board home. Nothing here starts a process.

import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { HookJSONOutput, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

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

// --- hooks ---------------------------------------------------------------------

/** The input the SDK gives a PreToolUse hook for this tool call. */
export function preToolUseInput(tool: string, input: unknown, cwd: string): PreToolUseHookInput {
  return {
    hook_event_name: "PreToolUse",
    session_id: "s",
    transcript_path: "/nowhere/transcript.jsonl",
    cwd,
    tool_name: tool,
    tool_input: input,
    tool_use_id: "toolu_test",
  };
}

/** The reason a hook's output denies the call with, or undefined when it does not. */
export function denyReason(output: HookJSONOutput | undefined): string | undefined {
  if (output === undefined || !("hookSpecificOutput" in output)) return undefined;
  const decision = output.hookSpecificOutput;
  if (decision?.hookEventName !== "PreToolUse" || decision.permissionDecision !== "deny") {
    return undefined;
  }
  return decision.permissionDecisionReason;
}

/** The text of a user message the supervisor sent: always a string. */
export function promptText(message: UserMessage): string {
  const { content } = message.message;
  if (typeof content !== "string") throw new Error("the supervisor sends text prompts only");
  return content;
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
  /** Every user message the session took from its streaming input, in order. */
  prompts: string[];
  /** The script the session took, if one was left. */
  script: Script | undefined;
  /** Every message the session produced: its transcript. */
  transcript: object[];
  /** The tool calls the session tried, and whether its rules or hook let them run. */
  tools: {
    tool: string;
    input: Record<string, unknown>;
    ran: boolean;
    /** The deny rule that matched, or undefined. */
    rule: string | undefined;
    /** The hook's refusal, or undefined; the hook is asked even when a rule matched. */
    hook: string | undefined;
  }[];
}

/** A tool call a scripted session tries; the double checks it as the SDK would, never runs it. */
export interface ToolAttempt {
  tool: string;
  input: Record<string, unknown>;
}

/** A step of a script: a message the session yields, or a tool call it tries. */
export type Step = object | { attempt: ToolAttempt };

/** What one session does: its first message (the start), then the rest once its gate opens. */
export interface Script {
  messages: Step[];
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
    const call: Call = { options, prompts: [], script, transcript: [], tools: [] };
    this.calls.push(call);
    options.abortController.signal.addEventListener("abort", () => (this.aborted += 1));
    return run(script, prompt, call, this.active);
  };
}

/** Whether a `Tool(pattern)` rule of `disallowedTools` names this Bash command, `*` matching anything. */
function ruleDenies(rule: string, attempt: ToolAttempt): boolean {
  const match = /^(\w+)\((.*)\)$/s.exec(rule);
  if (match === null || match[1] !== attempt.tool || attempt.tool !== "Bash") return false;
  const pattern = (match[2] ?? "")
    .split("*")
    .map((part) => part.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${pattern.join(".*")}$`, "s").test(String(attempt.input["command"]));
}

/**
 * Checks a tool call against the session's deny rules and its PreToolUse
 * hooks. The SDK stops at whichever denies first; the double asks both, so a
 * test sees each layer's answer.
 */
async function tryTool(attempt: ToolAttempt, call: Call): Promise<object[]> {
  const id = `toolu_${call.tools.length + 1}`;
  const rule = call.options.disallowedTools.find((each) => ruleDenies(each, attempt));
  let hook: string | undefined;
  for (const matcher of call.options.hooks.PreToolUse) {
    for (const each of matcher.hooks) {
      const input = preToolUseInput(attempt.tool, attempt.input, call.options.cwd);
      const out = await each(input, id, { signal: new AbortController().signal });
      hook ??= denyReason(out);
    }
  }
  const ran = rule === undefined && hook === undefined;
  call.tools.push({ ...attempt, ran, rule, hook });
  const reason = rule === undefined ? (hook ?? "ok") : `denied by rule ${rule}`;
  const use = { type: "tool_use", id, name: attempt.tool, input: attempt.input };
  const answer = { type: "tool_result", tool_use_id: id, is_error: !ran, content: reason };
  return [
    { type: "assistant", message: { role: "assistant", content: [use] } },
    { type: "user", message: { role: "user", content: [answer] } },
  ];
}

/** Takes every user message from the stream as the SDK does, recording each. */
async function readPrompts(prompt: AsyncIterable<UserMessage>, call: Call): Promise<void> {
  for await (const message of prompt) call.prompts.push(promptText(message));
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
    if (!first.done) call.prompts.push(promptText(first.value));
    void readPrompts({ [Symbol.asyncIterator]: () => reader }, call);
    if (script === undefined) throw new Error("no script left for this session");
    const [start, ...rest] = script.messages;
    for (const step of start === undefined ? [] : [start]) yield* emit(step, call);
    await script.gate?.opened;
    for (const step of rest) yield* emit(step, call);
    if (script.error !== undefined) throw script.error;
  } finally {
    active.delete(call);
  }
}

async function* emit(step: Step, call: Call) {
  const messages =
    "attempt" in step ? await tryTool((step as { attempt: ToolAttempt }).attempt, call) : [step];
  for (const message of messages) {
    call.transcript.push(message);
    yield message;
  }
}

// --- commands ------------------------------------------------------------------

type Json = Record<string, unknown>;

/** The parts of a home's schedules.json the fake board's take and close change. */
interface ScheduleDoc {
  occurrences: Record<string, Json>;
  recent: Record<string, Json[]>;
  save: () => void;
}

/**
 * Plays git (worktree add, remove, list; rev-list), the board's command
 * (status, open, summary, and schedule take and close against the home's
 * schedules.json, as the board does) and gh (pr view) in memory, and records
 * each call.
 */
export class FakeCommands {
  readonly calls: CommandRequest[] = [];
  readonly worktrees = new Map<string, Set<string>>();
  readonly unpushed = new Map<string, number>();
  readonly prStates = new Map<string, string>();
  readonly summaries: { task: string; kind: string; text: string }[] = [];
  failAdd = false;
  summaryStatus = 0;
  /** The exit status of `schedule close` while it is not 0; the board does nothing then. */
  closeStatus = 0;
  /** The exit status of `schedule take` while it is not 0; the board does nothing then. */
  takeStatus = 0;
  /** While true, running a `schedule` command throws, as a runner that cannot start it does. */
  throwOnSchedule = false;

  constructor(
    private readonly boardCommand: string,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

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
    if (command === "schedule" && this.throwOnSchedule) throw new Error("spawn failed");
    if (command === "schedule") return this.schedule(request);
    if (command === "summary" && this.summaryStatus === 0) {
      this.summaries.push({ task, kind, text: request.input ?? "" });
      const file = `${request.env["MYSHAPE_HOME"] ?? ""}/data/myshape/summaries.jsonl`;
      const line = { ts: 0, home: "main", task, kind, text: request.input ?? "" };
      if (existsSync(dirname(file))) appendFileSync(file, `${JSON.stringify(line)}\n`);
    }
    return done(this.summaryStatus, "", this.summaryStatus === 0 ? "" : "refused");
  }

  /** `schedule take <key> --note <n>` and `schedule close <key> done|skipped --note <n>`. */
  private schedule(request: CommandRequest): CommandResult {
    const [, sub, key = "", ...rest] = request.args;
    const path = `${request.env["MYSHAPE_HOME"] ?? ""}/data/myshape/schedules.json`;
    const doc = {
      occurrences: {},
      recent: {},
      ...(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}),
    } as Json;
    const file: ScheduleDoc = {
      occurrences: doc["occurrences"] as Record<string, Json>,
      recent: doc["recent"] as Record<string, Json[]>,
      save: () =>
        writeFileSync(
          path,
          JSON.stringify({ ...doc, occurrences: file.occurrences, recent: file.recent }),
        ),
    };
    const note = rest[rest.indexOf("--note") + 1] ?? "";
    if (sub === "take") return this.take(file, key, note);
    if (sub === "close") return this.close(file, key, rest[0] ?? "", note);
    return done(2, "", `unplayed schedule ${String(sub)}`);
  }

  private isOpen(file: ScheduleDoc, key: string): boolean {
    const occurrence = file.occurrences[key];
    return occurrence !== undefined && Date.parse(String(occurrence["closes_by"])) > this.nowMs();
  }

  private take(file: ScheduleDoc, key: string, note: string): CommandResult {
    if (this.takeStatus !== 0) return done(this.takeStatus, "", "看板拒絕了");
    const occurrence = file.occurrences[key];
    if (occurrence === undefined || !this.isOpen(file, key))
      return done(1, "", `${key} 不是開著的一場。`);
    if (occurrence["state"] === "taken") return done(0, `ok ${key} 本來就已接下\n`);
    file.occurrences[key] = { ...occurrence, state: "taken", taken_at: "now", note };
    file.save();
    return done(0, `ok ${key} 已接下\n`);
  }

  private close(file: ScheduleDoc, key: string, outcome: string, note: string): CommandResult {
    if (this.closeStatus !== 0) return done(this.closeStatus, "", "沒有回答");
    const series = key.split(":")[0] ?? "";
    const recent = file.recent[series] ?? [];
    if (recent.some((entry) => entry["key"] === key)) return done(0, `ok ${key} 本來就已結束\n`);
    if (!this.isOpen(file, key)) return done(1, "", `${key} 不是開著的一場。`);
    delete file.occurrences[key];
    file.recent[series] = [...recent, { key, outcome, by: "aggregator", note }];
    file.save();
    return done(0, `ok ${key} 已結束\n`);
  }

  /** The arguments of every `schedule` command the supervisor ran. */
  scheduleCalls(): string[][] {
    return this.calls
      .filter((call) => call.file === this.boardCommand && call.args[0] === "schedule")
      .map((call) => [...call.args]);
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
