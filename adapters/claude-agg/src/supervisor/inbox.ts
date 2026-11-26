// The actions the board delivered (spec/state-files.markdown, inbox/), parsed
// once where they come in, and a pure function that says what becomes of
// each one this pass (plan sections 3.5 and 4.1 step 3):
//   - `message`: to the topic's running worker, else to the planner;
//   - `direct`: to the running worker, else it resumes the worker's session;
//   - `answer`: a `close` hold is closed now; a `release` hold resumes the
//     worker's session with the answer;
//   - `notice` about a task's 要你動手 item: kept for that task's resume;
//   - `notice` about a schedule's occurrence (coming up, due, missed): kept
//     for the supervisor's schedule step; one the captain closed: handled;
//   - anything else: handled (the board files say what changed).
// An action stays in inbox/ until it has been handed on, so a restart
// finds it again; only then is it moved to inbox/handled/.

import type { HoldEntry, TaskEntry } from "#agg/state-files.js";

import { RT_VALUES, type Rt } from "./board-files.js";
import { isOccurrenceKey, keyAt, type ScheduleNotice } from "./occurrences.js";

type Json = Record<string, unknown>;

export interface TodoRef {
  id: string;
  title: string;
  ref: string;
}

export type Action =
  | { kind: "message"; topic: string; text: string }
  | { kind: "direct"; task: string; text: string }
  | { kind: "answer"; task: string }
  | { kind: "tag" }
  | {
      kind: "notice";
      event: string;
      item: TodoRef | null;
      by: string;
      /** The occurrence a schedule notice is about, or null for any other notice. */
      schedule: ScheduleNotice | null;
    };

/** One landed action: its file name in inbox/, when it landed, and what it says. */
export type InboxItem = { file: string; receivedMs: number } & Action;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseTodoRef(value: unknown): TodoRef | null {
  if (!isRecord(value)) return null;
  const [id, title, ref] = [str(value["id"]), str(value["title"]), str(value["ref"])];
  return id === undefined || title === undefined || ref === undefined ? null : { id, title, ref };
}

function parseMessage(record: Json): Action | undefined {
  const topic = isRecord(record["topic"]) ? str(record["topic"]["id"]) : undefined;
  const text = str(record["text"]);
  return topic === undefined || text === undefined ? undefined : { kind: "message", topic, text };
}

function parseDirect(record: Json): Action | undefined {
  const [task, text] = [str(record["task"]), str(record["text"])];
  return task === undefined || text === undefined ? undefined : { kind: "direct", task, text };
}

function parseAnswer(record: Json): Action | undefined {
  const task = str(record["task"]);
  return task === undefined ? undefined : { kind: "answer", task };
}

const SCHEDULE_EVENTS = [
  "schedule.upcoming",
  "schedule.due",
  "schedule.missed",
  "schedule.closed",
] as const;

type OccurrencePart = Omit<ScheduleNotice, "event" | "topic">;

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;

/**
 * A notice's `occurrence` object, or null when it is missing or unusable.
 * Its texts may reach a planner and a summary, so each is held to its
 * shape: `at` must be the key's own T, and a `local` time that is not one
 * is dropped.
 */
function parseOccurrence(raw: unknown): OccurrencePart | null {
  if (!isRecord(raw)) return null;
  const key = textOf(raw["key"]);
  const rt = RT_VALUES.find((value): value is Rt => value === raw["rt"]);
  if (!isOccurrenceKey(key) || rt === undefined) return null;
  const at = keyAt(key);
  if (timeOf(raw["at"]) !== Date.parse(at)) return null;
  const local = LOCAL_TIME.test(textOf(raw["local"])) ? textOf(raw["local"]) : "";
  return { key, at, local, rt, expiresAtMs: timeOf(raw["expires_at"]) };
}

function textOf(value: unknown): string {
  return str(value) ?? "";
}

/** A UTC ISO time in epoch milliseconds, or null when it is not one. */
function timeOf(value: unknown): number | null {
  const ms = Date.parse(textOf(value));
  return Number.isNaN(ms) ? null : ms;
}

/** A schedule notice's occurrence, or null for another notice or an unusable occurrence. */
function parseScheduleNotice(event: string, record: Json): ScheduleNotice | null {
  const known = SCHEDULE_EVENTS.find((name) => name === event);
  const topic = isRecord(record["topic"]) ? str(record["topic"]["id"]) : undefined;
  const occurrence = parseOccurrence(record["occurrence"]);
  if (known === undefined || topic === undefined || occurrence === null) return null;
  return { event: known, topic, ...occurrence };
}

function parseNotice(record: Json): Action | undefined {
  const event = str(record["event"]);
  if (event === undefined) return undefined;
  return {
    kind: "notice",
    event,
    item: parseTodoRef(record["item"]),
    by: str(record["by"]) ?? "",
    schedule: parseScheduleNotice(event, record),
  };
}

const PARSERS: Readonly<Record<string, (record: Json) => Action | undefined>> = {
  message: parseMessage,
  direct: parseDirect,
  answer: parseAnswer,
  tag: () => ({ kind: "tag" }),
  notice: parseNotice,
};

function parseAction(record: Json): Action | undefined {
  const kind = str(record["kind"]) ?? "";
  return Object.hasOwn(PARSERS, kind) ? PARSERS[kind]?.(record) : undefined;
}

/** The action in an inbox file's text, or undefined when it is not one `deliver` landed. */
export function parseInboxFile(file: string, text: string): InboxItem | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(doc) || doc["v"] !== 1 || !isRecord(doc["record"])) return undefined;
  const receivedMs = doc["received_ms"];
  if (typeof receivedMs !== "number" || !Number.isFinite(receivedMs)) return undefined;
  const action = parseAction(doc["record"]);
  return action === undefined ? undefined : { file, receivedMs, ...action };
}

/** What the supervisor's state says, as the sorting needs it. */
export interface InboxView {
  tasks: ReadonlyMap<string, TaskEntry>;
  holds: ReadonlyMap<string, HoldEntry>;
  /** A topic id with merges followed. */
  current: (topic: string) => string;
  /** The task whose running session takes input now, on this topic; undefined when none. */
  liveWorkerOn: (topic: string) => string | undefined;
  /** Whether the task's running session takes input now. */
  takesInput: (task: string) => boolean;
  /** The title of the quota hold, whose answer the quota stop reads itself. */
  quotaTitle: string;
}

export interface Sorted {
  /** Handled now: moved to inbox/handled/, with a log line when there is one. */
  retire: { item: InboxItem; log?: string }[];
  /** Answers to `close` holds: the hold closes now. */
  close: (InboxItem & { kind: "answer" })[];
  /** Messages and directs that go into a running session now. */
  push: { task: string; item: InboxItem & { kind: "message" | "direct" } }[];
  /** Messages for the planner, by topic (merges followed). */
  messages: Map<string, (InboxItem & { kind: "message" })[]>;
  /** Input that resumes a task's session: directs, `release` answers, todo notices. */
  inputs: Map<string, InboxItem[]>;
  /** Notices that an occurrence is coming up, is due, or was missed, oldest first. */
  schedule: ScheduleItem[];
}

/** A landed notice about an occurrence the supervisor acts on. */
export type ScheduleItem = InboxItem & { kind: "notice"; schedule: ScheduleNotice };

export const INBOX_LOG = {
  ended: (task: string) => `direct for ${task} came after its worker ended; not passed on`,
  notHandled: (event: string) => `notice ${event} is not handled in this version`,
  noOccurrence: (event: string) => `notice ${event} names no occurrence it can use; not acted on`,
  closed: (key: string) => `the captain ended occurrence ${key} on the page`,
} as const;

const ENDED = new Set(["done", "failed"]);
const TOPIC_EVENTS = new Set([
  "topic.dispatchable",
  "topic.merged",
  "topic.archived",
  "topic.kept",
  "topic.confirmed",
]);

function add<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  map.set(key, [...(map.get(key) ?? []), value]);
}

function sortScheduleNotice(item: InboxItem & { kind: "notice" }, sorted: Sorted): void {
  const { schedule } = item;
  if (schedule === null) sorted.retire.push({ item, log: INBOX_LOG.noOccurrence(item.event) });
  else if (schedule.event === "schedule.closed")
    sorted.retire.push({ item, log: INBOX_LOG.closed(schedule.key) });
  else sorted.schedule.push({ ...item, schedule });
}

/** Whether a notice is the captain's about a 要你動手 item of a task that has not ended. */
function isTodoInput(item: InboxItem & { kind: "notice" }, view: InboxView): boolean {
  const task = item.item === null ? undefined : view.tasks.get(item.item.ref);
  return task !== undefined && !ENDED.has(task.state) && item.by !== "aggregator";
}

function sortNotice(item: InboxItem & { kind: "notice" }, view: InboxView, sorted: Sorted): void {
  const todo = item.event === "todo.claimed" || item.event === "todo.closed";
  if (todo && isTodoInput(item, view)) {
    add(sorted.inputs, item.item?.ref ?? "", item);
  } else if (todo || TOPIC_EVENTS.has(item.event)) {
    sorted.retire.push({ item });
  } else {
    sorted.retire.push({ item, log: INBOX_LOG.notHandled(item.event) });
  }
}

function sortAnswer(item: InboxItem & { kind: "answer" }, view: InboxView, sorted: Sorted): void {
  const hold = view.holds.get(item.task);
  if (hold === undefined || hold.state !== "open" || hold.title === view.quotaTitle) {
    sorted.retire.push({ item });
  } else if (hold.on_answer === "close") {
    sorted.close.push(item);
  } else {
    add(sorted.inputs, item.task, item);
  }
}

function sortMessage(item: InboxItem & { kind: "message" }, view: InboxView, sorted: Sorted) {
  const topic = view.current(item.topic);
  const worker = view.liveWorkerOn(topic);
  if (worker === undefined) add(sorted.messages, topic, item);
  else sorted.push.push({ task: worker, item });
}

function sortDirect(item: InboxItem & { kind: "direct" }, view: InboxView, sorted: Sorted) {
  const task = view.tasks.get(item.task);
  if (task === undefined || ENDED.has(task.state)) {
    sorted.retire.push({ item, log: INBOX_LOG.ended(item.task) });
  } else if (view.takesInput(item.task)) {
    sorted.push.push({ task: item.task, item });
  } else {
    add(sorted.inputs, item.task, item);
  }
}

function sortOne(item: InboxItem, view: InboxView, sorted: Sorted): void {
  switch (item.kind) {
    case "message":
      return sortMessage(item, view, sorted);
    case "direct":
      return sortDirect(item, view, sorted);
    case "answer":
      return sortAnswer(item, view, sorted);
    case "notice":
      return item.event.startsWith("schedule.")
        ? sortScheduleNotice(item, sorted)
        : sortNotice(item, view, sorted);
    case "tag":
      sorted.retire.push({ item });
  }
}

/** What becomes of each landed action this pass, oldest first. */
export function sortInbox(items: readonly InboxItem[], view: InboxView): Sorted {
  const sorted: Sorted = {
    retire: [],
    close: [],
    push: [],
    messages: new Map(),
    inputs: new Map(),
    schedule: [],
  };
  const ordered = items.toSorted(
    (a, b) => a.receivedMs - b.receivedMs || a.file.localeCompare(b.file),
  );
  for (const item of ordered) sortOne(item, view, sorted);
  return sorted;
}
