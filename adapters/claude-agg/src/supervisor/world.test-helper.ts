// One scratch world for supervisor tests: a board home, a worktree root, the
// fake commands, the scripted query, a clock, and the supervisor's settings.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runProgram } from "#agg/test-home.js";

import type { LedgerEvent, TaskEntry } from "#agg/state-files.js";

import { existingRealPath } from "./guard.js";
import { keyAt } from "./occurrences.js";
import {
  boardHome,
  CANARY,
  ENV,
  FakeCommands,
  ScriptedQuery,
  type Topics,
} from "./harness.test-helper.js";
import type { Settings } from "./settings.js";
import type { PlannedTask } from "./state-store.js";
import { PLANNER_DIR, Supervisor, type Deps } from "./supervisor.js";

export const BOARD_COMMAND = "/opt/board/bin/myshape.sh";
export const REPO = "/repos/app";
export const START_MS = Date.parse("2026-11-27T02:00:00Z");

function jsonNames(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : [];
}

export interface HoldView {
  state: string;
  title: string;
  question: string;
  on_answer: string;
  hold_set: string;
  hold_until?: string | null;
}

export class World {
  readonly home: string;
  readonly root: string;
  readonly agg: string;
  readonly commands = new FakeCommands(BOARD_COMMAND, () => this.nowMs);
  readonly query: ScriptedQuery;
  readonly logs: string[] = [];
  nowMs = START_MS;
  model: string | undefined = undefined;
  /** The listed repository's main checkout. */
  repoPath = REPO;
  alive = new Set<number>();
  pid = 4242;

  constructor(queues: Topics, hashtags: Record<string, string[]> = {}) {
    const { home, root } = boardHome(queues, hashtags);
    this.home = home;
    this.root = root;
    this.agg = join(home, "agg");
    this.query = new ScriptedQuery(root);
  }

  /** The planner's own working directory. */
  get plannerDir(): string {
    return join(this.root, PLANNER_DIR);
  }

  settings(): Settings {
    return {
      home: this.home,
      worktreeRoot: this.root,
      boardCommand: BOARD_COMMAND,
      port: 47_829,
      repos: { app: { path: this.repoPath, base: "origin/main", defaultBranch: "main" } },
      model: this.model,
      credentialFile: `${this.root}-credential`,
      readPaths: [],
    };
  }

  deps(): Deps {
    return {
      query: this.query.query,
      run: this.commands.run,
      credential: { mode: "subscription-token", secret: CANARY },
      env: ENV,
      nowMs: () => this.nowMs,
      log: (line) => this.logs.push(line),
      realPath: existingRealPath,
      pid: this.pid,
      isAlive: (pid) => this.alive.has(pid),
      tmpRoot: this.root,
    };
  }

  start(): Promise<Supervisor> {
    return Supervisor.start(this.settings(), this.deps());
  }

  /** Writes queued.json as a supervisor that planned these tasks would have. */
  seedQueued(entries: { id: string; topic: string }[]): void {
    const queued: PlannedTask[] = entries.map(({ id, topic }) => ({
      id,
      kind: "ship",
      title: `做 ${id}`,
      hold: null,
      captain: false,
      blockers: [],
      topic_hint: topic,
      repo: "app",
      prompt: `prompt ${id}`,
    }));
    mkdirSync(this.agg, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.agg, "queued.json"), JSON.stringify({ v: 1, queued }));
  }

  /** Rewrites data/topics.json with these queues. */
  moveTopics(queues: Topics): void {
    const path = join(this.home, "data", "topics.json");
    const doc = JSON.parse(readFileSync(path, "utf8")) as { queues: Topics };
    doc.queues = { high: [], normal: [], later: [], ...queues };
    writeFileSync(path, JSON.stringify(doc));
  }

  tasks(): Record<string, TaskEntry> {
    return (
      JSON.parse(readFileSync(join(this.agg, "tasks.json"), "utf8")) as {
        tasks: Record<string, TaskEntry>;
      }
    ).tasks;
  }

  queued(): PlannedTask[] {
    return (
      JSON.parse(readFileSync(join(this.agg, "queued.json"), "utf8")) as { queued: PlannedTask[] }
    ).queued;
  }

  holds(): Record<string, HoldView> {
    if (!existsSync(join(this.agg, "holds.json"))) return {};
    return (
      JSON.parse(readFileSync(join(this.agg, "holds.json"), "utf8")) as {
        holds: Record<string, HoldView>;
      }
    ).holds;
  }

  /** Hands one action record to bin/agg-board.mjs deliver, as the board does; returns its outcome. */
  deliver(record: Record<string, unknown>): { outcome: string; error?: string } {
    this.writes += 1;
    const full = { v: 1, id: `w-${this.writes}`, attempt: 0, ...record };
    const run = runProgram(this.home, ["deliver"], `${JSON.stringify(full)}\n`);
    if (run.status !== 0) throw new Error(`deliver exited ${String(run.status)}: ${run.stderr}`);
    return JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "") as { outcome: string };
  }

  private writes = 0;

  /** The captain's answer to `task`'s open hold, given on the page in two steps. */
  answer(task: string, answer: string): { outcome: string } {
    const hold = this.holds()[task];
    if (hold === undefined) throw new Error(`no hold on ${task}`);
    const sha = createHash("sha256").update(hold.question).digest("hex");
    const mode = hold.on_answer === "close" ? "done" : "release";
    return this.deliver({
      kind: "answer",
      home: "main",
      task,
      answer,
      label: answer,
      mode,
      question_sha256: sha,
      topic: null,
    });
  }

  /**
   * Writes the board's data/myshape/schedules.json as its clock would have:
   * these schedules (on, captain's, locked) and these open occurrences.
   */
  writeSchedules(
    series: Record<string, { topic: string; rt?: string; state?: string }>,
    occurrences: Record<string, { at: string; state?: string; closes_by?: string }> = {},
    settings: Record<string, unknown> = {},
  ): void {
    const full = Object.fromEntries(
      Object.entries(occurrences).map(([key, o]) => [
        key,
        {
          series: key.split(":")[0],
          state: "upcoming",
          closes_by: new Date(Date.parse(o.at) + 3_600_000).toISOString(),
          ...o,
        },
      ]),
    );
    const doc = this.schedulesDoc();
    doc.settings = settings;
    doc.series = Object.fromEntries(
      Object.entries(series).map(([id, entry]) => [
        id,
        { rt: "none", state: "on", by: "captain", locked: true, ...entry },
      ]),
    );
    doc.occurrences = { ...doc.occurrences, ...full };
    writeFileSync(join(this.home, "data", "myshape", "schedules.json"), JSON.stringify(doc));
  }

  /** Takes an occurrence out of schedules.json, as the clock or the captain ending it does. */
  endOccurrence(key: string): void {
    const doc = this.schedulesDoc();
    delete doc.occurrences[key];
    writeFileSync(join(this.home, "data", "myshape", "schedules.json"), JSON.stringify(doc));
  }

  schedulesDoc(): {
    settings: Record<string, unknown>;
    series: Record<string, unknown>;
    occurrences: Record<string, Record<string, unknown>>;
    recent: Record<string, unknown[]>;
  } {
    const path = join(this.home, "data", "myshape", "schedules.json");
    const empty = { settings: {}, series: {}, occurrences: {}, recent: {} };
    return existsSync(path) ? { ...empty, ...JSON.parse(readFileSync(path, "utf8")) } : empty;
  }

  /** Lands a schedule notice about `key`, as the board's clock sends it. */
  notice(
    event: "schedule.upcoming" | "schedule.due" | "schedule.missed" | "schedule.closed",
    key: string,
    topic: string,
    extra: { rt?: string; expires_at?: string } = {},
  ): { outcome: string } {
    const iso = keyAt(key);
    const phase =
      { "schedule.upcoming": "pre", "schedule.due": "start" }[event as string] ?? event.slice(9);
    return this.deliver({
      kind: "notice",
      event,
      text: `排程「${topic}」…（議題 ${topic}，這一場 ${key}）`,
      topic: { id: topic, name: topic },
      occurrence: { key, at: iso, local: iso, phase, rt: extra.rt ?? "none", ...extra },
    });
  }

  /** Writes the board's data/myshape/todos.json with these items. */
  boardTodos(items: Record<string, { state: string; ref: string; title?: string }>): void {
    const full = Object.fromEntries(
      Object.entries(items).map(([id, item]) => [id, { title: id, ...item }]),
    );
    writeFileSync(
      join(this.home, "data", "myshape", "todos.json"),
      JSON.stringify({ v: 1, items: full }),
    );
  }

  /** The arguments of every board write the supervisor ran: all but status, open and summary. */
  boardWrites(): string[][] {
    return this.commands.calls
      .filter((call) => call.file === BOARD_COMMAND)
      .map((call) => [...call.args])
      .filter((args) => !["status", "open", "summary"].includes(args[0] ?? ""));
  }

  /** Names in inbox/ and inbox/handled/. */
  inbox(): { waiting: string[]; handled: string[] } {
    return {
      waiting: jsonNames(join(this.agg, "inbox")),
      handled: jsonNames(join(this.agg, "inbox", "handled")),
    };
  }

  ledger(): LedgerEvent[] {
    return readFileSync(join(this.agg, "ledger.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LedgerEvent);
  }

  /** `task`'s ledger lines as short strings: event, then state and text or pr. */
  events(task: string): string[] {
    return this.ledger()
      .filter((event) => event.task === task)
      .map((event) => {
        if (event.event === "task.status") return `status ${event.state} ${event.text}`;
        if (event.event === "task.pr_ready" || event.event === "task.merged")
          return `${event.event} ${event.pr}`;
        return event.event;
      });
  }

  /** Every file under the home and the worktree root, with its text. */
  everyFile(): string[] {
    const texts: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else texts.push(readFileSync(path, "utf8"));
      }
    };
    walk(this.home);
    walk(this.root);
    return texts;
  }
}
