// Everything the board hands the aggregator on the captain's behalf: messages,
// direct messages to agents, answers to decisions, filings under a topic, and
// notices of what happened on the board. Each write is one action record
// (contracts section 7.2), recorded in the audit log before it runs and at
// every state change, retried only when the deliverer says so, and resumed
// after a restart from the audit log alone. While the deliverer may not run,
// writes wait; they are handed over in record order, oldest first, when it may
// again: at the next start, at the page's confirmation of the deliverer,
// after a good read of the root home, and before any newer write is sent.
import crypto from "node:crypto";
import type { CommandResult, CommandRunner } from "./commands.js";
import { appendLine, isRecord, readCompleteLines, stringField } from "./files.js";
import type { Draft, RecordKind } from "./records.js";

export type WriteState =
  | "waiting"
  | "sending"
  | "retrying"
  | "delivered"
  | "handled_elsewhere"
  | "failed"
  | "undelivered"
  | "unknown"
  | "ignored";

export interface TopicRef {
  id: string;
  name: string;
}

export type NoticeEvent =
  | "topic.dispatchable"
  | "topic.merged"
  | "topic.archived"
  | "topic.kept"
  | "topic.confirmed"
  | "todo.claimed"
  | "todo.closed";

export interface NoticeItem {
  id: string;
  title: string;
  ref: string;
}

/** What a write asks the aggregator to do: the action record without its envelope (v, id, attempt). */
export type Action =
  | { kind: "message"; topic: TopicRef; text: string }
  | { kind: "direct"; home: string; task: string; text: string }
  | {
      kind: "answer";
      home: string;
      task: string;
      answer: string;
      label: string;
      mode: "done" | "release";
      question_sha256: string;
      topic: TopicRef | null;
    }
  | { kind: "tag"; home: string; task: string; topic: string; last_tag_line: string }
  | {
      kind: "notice";
      event: NoticeEvent;
      text: string;
      topic?: TopicRef;
      item?: NoticeItem;
      /** todo.closed: who closed the item, and the words it was closed with. */
      by?: "captain" | "aggregator";
      words?: string;
    };

export interface WriteRecord {
  id: string;
  channel: "browser" | "socket" | "auto";
  /** The home the write is about: "main" or a further home's id. */
  home: string;
  task: string | null;
  topic: string | null;
  /** The captain's own words, or the notice, shown next to the write's status. */
  text: string;
  action: Action;
  state: WriteState;
  attempt: number;
  error: string | null;
  nextAt: number | null;
  createdAt: number;
}

export interface WriteTimings {
  retryDelaysMs: number[];
  /** A write left unfinished by a restart is resumed only this long after it was created. */
  resumeWindowMs: number;
  commandTimeoutMs: number;
}

export const DEFAULT_WRITE_TIMINGS: WriteTimings = {
  retryDelaysMs: [10_000, 30_000, 60_000, 300_000, 900_000],
  resumeWindowMs: 30 * 60_000,
  commandTimeoutMs: 400_000,
};

export type Outcome =
  | { kind: "wait" }
  | { kind: "delivered" }
  | { kind: "handled_elsewhere" }
  | { kind: "failed"; error: string }
  | { kind: "retry"; error: string };

/** What the engine needs from the rest of the service. */
export interface WriteHost {
  run: CommandRunner;
  /** Why the deliverer may not run now, or null when it may (binding.ts). */
  blocked: () => string | null;
  /**
   * Saves the record of handing these waiting writes over, oldest first;
   * false when it could not be saved, and then they keep waiting.
   */
  onRelease: (ids: string[]) => boolean;
  /** Reads `home` afresh and returns the task's tag text, or null when the read failed. */
  readTags: (home: string, task: string) => Promise<string | null>;
  /** Called when a write changes what the board shows. */
  onChange: () => void;
  /**
   * Called once when a write is delivered or turns out to be handled
   * elsewhere, so the service can record how it ended (deliveryRecord) and refresh.
   */
  onFinished: (record: WriteRecord) => void;
}

/**
 * The record a delivered write leaves, by its kind: an answer and a tag change
 * the aggregator's side, so the board records them; a message, a direct
 * message and a notice are communication, not a change, and leave none. A new
 * kind does not compile until it is listed here.
 */
export const ON_DELIVERED = {
  answer: "hold.answered",
  tag: "agent.tagged",
  message: null,
  direct: null,
  notice: null,
} as const satisfies Record<Action["kind"], RecordKind | null>;

/**
 * The record a write handled elsewhere leaves: an answer found its decision
 * already ended, which the board records; a tag found the task filed by
 * someone else, which is that filing's own record.
 */
export const ON_HANDLED_ELSEWHERE = {
  answer: "hold.closed",
  tag: null,
  message: null,
  direct: null,
  notice: null,
} as const satisfies Record<Action["kind"], RecordKind | null>;

/** The record of how a write ended, or null when it leaves none. */
export function deliveryRecord(record: WriteRecord): Draft | null {
  const kinds = record.state === "delivered" ? ON_DELIVERED : ON_HANDLED_ELSEWHERE;
  const kind =
    record.state === "delivered" || record.state === "handled_elsewhere"
      ? kinds[record.action.kind]
      : null;
  if (kind === null) return null;
  const where = { topic: record.topic, home: record.home, task: record.task };
  const who = `${record.home}/${record.task ?? ""}`;
  if (record.action.kind !== "answer") return { kind, ...where, text: `${who} ${record.text}` };
  const outcome = record.action.label === "" ? record.action.answer : record.action.label;
  if (kind === "hold.answered")
    return { kind, ...where, outcome, text: `在看板回答 ${who}：${record.text}` };
  return {
    kind,
    ...where,
    outcome: "elsewhere",
    text: `待決事項 ${who} 已在別處結束，看板上的回答「${record.text}」沒有送出`,
  };
}

const AUDIT_MODE = 0o600;
const ERROR_MAX = 600;
const UNFINISHED: WriteState[] = ["sending", "retrying"];
export const NEEDS_ATTENTION: WriteState[] = ["failed", "undelivered", "unknown"];
const OUTCOMES = ["delivered", "handled_elsewhere", "retry", "failed"];

function errorText(result: CommandResult): string {
  return (result.stderr.trim() || result.stdout.trim() || `exit ${result.code ?? "?"}`).slice(
    0,
    ERROR_MAX,
  );
}

/** The deliverer's outcome: its last stdout line; anything else is a failure with its stderr. */
export function parseOutcome(result: CommandResult): Outcome {
  const lines = result.stdout.split("\n").filter((line) => line.trim() !== "");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(lines[lines.length - 1] ?? "");
  } catch {
    parsed = null;
  }
  const outcome = isRecord(parsed) ? parsed["outcome"] : undefined;
  if (typeof outcome !== "string" || !OUTCOMES.includes(outcome))
    return { kind: "failed", error: errorText(result) };
  if (outcome === "delivered" || outcome === "handled_elsewhere") return { kind: outcome };
  const error = isRecord(parsed) ? stringField(parsed, "error") : null;
  return {
    kind: outcome as "retry" | "failed",
    error: (error ?? errorText(result)).slice(0, ERROR_MAX),
  };
}

/** True when handing the same record over again cannot make it take effect twice. */
export function isDedupable(action: Action): boolean {
  return action.kind !== "direct";
}

/** The one line the deliverer reads on stdin. */
export function actionRecord(record: WriteRecord): string {
  return JSON.stringify({ v: 1, id: record.id, attempt: record.attempt, ...record.action });
}

function lastLine(text: string): string {
  const lines = text.trimEnd().split("\n");
  return lines[lines.length - 1] as string;
}

/** One audit line about a write; lines about rejected requests carry no write id and yield null. */
function parseAuditLine(
  line: string,
): { id: string; state: WriteState; fields: Record<string, unknown> } | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(entry)) return null;
  const id = stringField(entry, "write_id");
  const state = stringField(entry, "state") as WriteState | null;
  return id === null || state === null ? null : { id, state, fields: entry };
}

export class WriteEngine {
  readonly records = new Map<string, WriteRecord>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly auditFile: string,
    private readonly host: WriteHost,
    private readonly timings: WriteTimings,
  ) {
    for (const line of readCompleteLines(this.auditFile)) this.replay(line);
  }

  /** True when writes go to the deliverer now; false when they wait. */
  get connected(): boolean {
    return this.host.blocked() === null;
  }

  /** The waiting writes, oldest first. */
  private waiting(): WriteRecord[] {
    return [...this.records.values()].filter((record) => record.state === "waiting");
  }

  /**
   * Hands over, in record order, every write a restart left waiting or
   * unfinished. Called once, before the service answers anyone, so nothing
   * submitted afterwards can overtake them.
   */
  resumeUnfinished(): void {
    const released = this.connected && this.recordRelease();
    for (const record of this.records.values()) {
      if (record.state === "waiting") {
        if (released) this.release(record);
      } else if (UNFINISHED.includes(record.state)) {
        this.resume(record);
      }
    }
  }

  /**
   * Hands every waiting write over, oldest first, when the deliverer may run
   * and the record of it was saved; returns how many went.
   */
  releaseWaiting(): number {
    const waiting = this.waiting();
    if (waiting.length === 0 || !this.connected || !this.recordRelease()) return 0;
    for (const record of waiting) this.release(record);
    return waiting.length;
  }

  /** Saves the record of releasing the waiting writes; true when there are none. */
  private recordRelease(): boolean {
    const ids = this.waiting().map((record) => record.id);
    return ids.length === 0 || this.host.onRelease(ids);
  }

  /** Records a new write and starts delivering it, or leaves it waiting. */
  submit(
    input: Pick<WriteRecord, "channel" | "home" | "task" | "topic" | "text" | "action">,
  ): WriteRecord {
    // Older writes waiting for the deliverer go first, or this one would overtake them.
    const connected = this.connected && (this.waiting().length === 0 || this.releaseWaiting() > 0);
    const record: WriteRecord = {
      ...input,
      id: `w-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
      state: connected ? "sending" : "waiting",
      attempt: 0,
      error: null,
      nextAt: null,
      createdAt: Date.now(),
    };
    this.records.set(record.id, record);
    this.audit(record, { sending: record });
    if (connected) this.enqueue(record, false);
    // A waiting write changes nothing else later, so the page must hear of it now.
    else this.host.onChange();
    return record;
  }

  /** Sends a failed write again under the same id. */
  resend(id: string, confirmed: boolean): string | null {
    const record = this.records.get(id);
    if (record === undefined) return "沒有這筆寫入。";
    if (!NEEDS_ATTENTION.includes(record.state)) return "這筆寫入不需要重送。";
    if (record.state === "unknown" && !confirmed)
      return "這筆寫入結果不明，重送可能會重複，需要先確認。";
    record.attempt = 0;
    if (!this.connected) {
      this.setState(record, "waiting", null);
      return null;
    }
    this.setState(record, "sending", null);
    this.enqueue(record, true);
    return null;
  }

  ignore(id: string): string | null {
    const record = this.records.get(id);
    if (record === undefined) return "沒有這筆寫入。";
    if (!NEEDS_ATTENTION.includes(record.state)) return "這筆寫入不需要忽略。";
    this.setState(record, "ignored", null);
    return null;
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private audit(record: WriteRecord, extra: Record<string, unknown>): void {
    const line = {
      ts: new Date().toISOString(),
      write_id: record.id,
      state: record.state,
      attempt: record.attempt,
      ...extra,
    };
    appendLine(this.auditFile, JSON.stringify(line), AUDIT_MODE);
  }

  private setState(
    record: WriteRecord,
    state: WriteState,
    error: string | null,
    nextAt: number | null = null,
  ): void {
    record.state = state;
    record.error = error;
    record.nextAt = nextAt;
    this.audit(record, {
      ...(error === null ? {} : { error }),
      ...(nextAt === null ? {} : { next_at: new Date(nextAt).toISOString() }),
    });
    this.host.onChange();
  }

  private enqueue(record: WriteRecord, reconcileFirst: boolean): void {
    void this.deliver(record, reconcileFirst).catch((error: unknown) => {
      this.setState(record, "failed", `看板內部錯誤：${(error as Error).message}`);
    });
  }

  /**
   * Runs `task` after every earlier run for the same home has finished. Only
   * runs are serialized; a write waiting for its next retry does not hold up
   * the other writes to that home.
   */
  private exclusive<T>(home: string, task: () => Promise<T>): Promise<T> {
    const queued = this.queues.get(home);
    const previous = queued === undefined ? Promise.resolve() : queued;
    const result = previous.then(task);
    this.queues.set(
      home,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, ms);
      this.timers.add(timer);
    });
  }

  /** Runs a write to a final state, waiting out the retry delays in between. */
  private async deliver(record: WriteRecord, reconcileFirst: boolean): Promise<void> {
    let reconcile = reconcileFirst;
    for (;;) {
      const outcome = await this.exclusive(record.home, () => this.attempt(record, reconcile));
      reconcile = true;
      if (outcome.kind === "wait") {
        this.setState(record, "waiting", null);
        return;
      }
      if (outcome.kind !== "retry") {
        this.setState(record, outcome.kind, outcome.kind === "failed" ? outcome.error : null);
        if (outcome.kind !== "failed") this.host.onFinished(record);
        return;
      }
      const delay = this.timings.retryDelaysMs[record.attempt];
      if (delay === undefined) {
        this.setState(record, "undelivered", outcome.error);
        return;
      }
      record.attempt += 1;
      this.setState(record, "retrying", outcome.error, Date.now() + delay);
      await this.sleep(delay);
    }
  }

  private async attempt(record: WriteRecord, reconcile: boolean): Promise<Outcome> {
    if (record.action.kind === "tag" && reconcile) {
      const settled = await this.reconcileTag(record.action);
      if (settled !== null) return settled;
    }
    const result = await this.host.run(
      { kind: "deliver", record: actionRecord(record) },
      this.timings.commandTimeoutMs,
    );
    return result.blocked === undefined ? parseOutcome(result) : { kind: "wait" };
  }

  /**
   * Before any attempt to file a task after the first, the home is read
   * afresh: the tag may already be in place, or someone else may have filed
   * the task under another topic since, in which case it is left alone.
   */
  private async reconcileTag(action: Extract<Action, { kind: "tag" }>): Promise<Outcome | null> {
    const tags = await this.host.readTags(action.home, action.task);
    if (tags === null) return { kind: "retry", error: "對帳時讀不到那個 home。" };
    const current = lastLine(tags);
    if (current.split(" ")[0] === action.topic) return { kind: "delivered" };
    return current === action.last_tag_line ? null : { kind: "handled_elsewhere" };
  }

  private replay(line: string): void {
    const entry = parseAuditLine(line);
    if (entry === null) return;
    const sending = entry.fields["sending"];
    // A write a board recorded before action records existed carries a plan
    // instead; it is not loaded, so it is neither resumed nor shown.
    if (isRecord(sending) && isRecord(sending["action"]))
      this.records.set(entry.id, sending as unknown as WriteRecord);
    const record = this.records.get(entry.id);
    if (record === undefined) return;
    const attempt = entry.fields["attempt"];
    record.state = entry.state;
    record.attempt = typeof attempt === "number" ? attempt : record.attempt;
    record.error = stringField(entry.fields, "error");
    record.nextAt = null;
  }

  /** A waiting write never ran: it starts from attempt 0 whatever its age. */
  private release(record: WriteRecord): void {
    record.attempt = 0;
    this.setState(record, "sending", null);
    this.enqueue(record, false);
  }

  private resume(record: WriteRecord): void {
    if (!isDedupable(record.action)) {
      this.setState(record, "unknown", "看板在送出途中重啟，不知道有沒有送到。");
    } else if (Date.now() - record.createdAt > this.timings.resumeWindowMs) {
      this.setState(record, "undelivered", "看板重啟時這筆已經放太久，沒有自動接著送。");
    } else if (!this.connected) {
      this.setState(record, "waiting", null);
    } else {
      this.enqueue(record, true);
    }
  }
}
