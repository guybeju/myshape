// The supervisor's side of the agent's state files (spec/state-files.markdown):
// it is the only writer of tasks.json, holds.json, queued.json and
// ledger.jsonl, and it writes the first line of each tags/<task-id>. Whole
// files are written to a new temporary file in the same directory (opened
// with `wx`, so it never follows or reuses a name) and renamed over the old
// one. Every byte written passes through `redact`, so the subscription token
// cannot reach a state file.

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import type {
  HoldEntry,
  HoldsFile,
  LedgerEvent,
  QueuedEntry,
  QueuedFile,
  TaskEntry,
  TasksFile,
} from "#agg/state-files.js";

/** A queued entry with the supervisor's own fields; the board reads only QueuedEntry's. */
export interface PlannedTask extends QueuedEntry {
  /** The topic the task was planned for. */
  topic_hint: string;
  /** The name of the target repository in the supervisor's settings. */
  repo: string;
  /** What the planner asked the worker to do. */
  prompt: string;
}

/** A ledger event as written, without `v` and `ts`, which the store adds. */
export type LedgerLine = LedgerEvent extends infer E
  ? E extends LedgerEvent
    ? Omit<E, "v" | "ts">
    : never
  : never;

/** A state file that exists but is not the format the spec describes. */
export class StateFileError extends Error {
  constructor(path: string, problem: string) {
    super(`${path}: ${problem}`);
    this.name = "StateFileError";
  }
}

const DIRS = ["inbox/handled", "answers/handled", "tags"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class StateStore {
  readonly agg: string;
  private readonly redact: (text: string) => string;
  private readonly nowSeconds: () => number;

  constructor(agg: string, redact: (text: string) => string, nowSeconds: () => number) {
    this.agg = agg;
    this.redact = redact;
    this.nowSeconds = nowSeconds;
  }

  /** Makes `agg/` and its directories, mode 0700, when they are missing. */
  setUp(): void {
    mkdirSync(this.agg, { recursive: true, mode: 0o700 });
    for (const dir of DIRS) mkdirSync(join(this.agg, dir), { recursive: true, mode: 0o700 });
  }

  private readFile(name: string, key: string): unknown {
    const path = join(this.agg, name);
    if (!existsSync(path)) return undefined;
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new StateFileError(path, `is not valid JSON (${(error as Error).message})`);
    }
    if (!isRecord(doc) || doc["v"] !== 1) throw new StateFileError(path, "is not a v 1 object");
    return doc[key];
  }

  private writeFile(name: string, doc: object): void {
    const path = join(this.agg, name);
    const temp = join(this.agg, `.tmp-${name}-${process.pid}-${randomBytes(6).toString("hex")}`);
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeSync(fd, this.redact(`${JSON.stringify(doc)}\n`));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  }

  readTasks(): Map<string, TaskEntry> {
    const tasks = this.readFile("tasks.json", "tasks") ?? {};
    if (!isRecord(tasks)) throw new StateFileError(join(this.agg, "tasks.json"), "bad tasks");
    return new Map(Object.entries(tasks as Record<string, TaskEntry>));
  }

  writeTasks(tasks: ReadonlyMap<string, TaskEntry>): void {
    const file: TasksFile = { v: 1, tasks: Object.fromEntries(tasks) };
    this.writeFile("tasks.json", file);
  }

  readHolds(): Map<string, HoldEntry> {
    const holds = this.readFile("holds.json", "holds") ?? {};
    if (!isRecord(holds)) throw new StateFileError(join(this.agg, "holds.json"), "bad holds");
    return new Map(Object.entries(holds as Record<string, HoldEntry>));
  }

  writeHolds(holds: ReadonlyMap<string, HoldEntry>): void {
    const file: HoldsFile = { v: 1, holds: Object.fromEntries(holds) };
    this.writeFile("holds.json", file);
  }

  readQueued(): PlannedTask[] {
    const queued = this.readFile("queued.json", "queued") ?? [];
    if (!Array.isArray(queued)) {
      throw new StateFileError(join(this.agg, "queued.json"), "bad queued");
    }
    return queued as PlannedTask[];
  }

  writeQueued(queued: readonly PlannedTask[]): void {
    const file: QueuedFile = { v: 1, queued: [...queued] };
    this.writeFile("queued.json", file);
  }

  /** Appends one ledger line, in one write. */
  appendLedger(line: LedgerLine): void {
    const event = { v: 1, ts: this.nowSeconds(), ...line };
    const text = this.redact(`${JSON.stringify(event)}\n`);
    appendFileSync(join(this.agg, "ledger.jsonl"), text, { mode: 0o600 });
  }

  /** Appends `<topic> <time>` to tags/<task>, in one write. */
  appendTag(task: string, topic: string, iso: string): void {
    appendFileSync(join(this.agg, "tags", task), `${topic} ${iso}\n`, { mode: 0o600 });
  }

  /** Each task's topic now: the first word of the last line of its tag file. */
  readTags(): Map<string, string> {
    const dir = join(this.agg, "tags");
    const tags = new Map<string, string>();
    if (!existsSync(dir)) return tags;
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const lines = readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean);
      const topic = lines.at(-1)?.split(" ")[0];
      if (topic !== undefined && topic !== "") tags.set(name, topic);
    }
    return tags;
  }

  /** The answer the captain gave to `task`'s hold, as deliver landed it, or undefined. */
  readAnswer(task: string): { id: string; answer: string; label: string } | undefined {
    const path = join(this.agg, "answers", `${task}.json`);
    if (!existsSync(path)) return undefined;
    const landed = JSON.parse(readFileSync(path, "utf8")) as {
      record?: { id?: unknown; answer?: unknown; label?: unknown };
    };
    const record = landed.record ?? {};
    return {
      id: String(record.id),
      answer: String(record.answer ?? ""),
      label: String(record.label ?? ""),
    };
  }

  /** Moves answers/<task>.json to answers/handled/<task>.<write-id>.json. */
  retireAnswer(task: string, writeId: string): void {
    renameSync(
      join(this.agg, "answers", `${task}.json`),
      join(this.agg, "answers", "handled", `${task}.${writeId}.json`),
    );
  }
}
