// The actions the board delivered (spec/state-files.markdown, inbox/), parsed
// once where they come in, and a pure function that says what becomes of
// each one this pass (plan sections 3.5 and 4.1 step 3):
//   - `message`: to the topic's running worker, else to the planner;
//   - `direct`: to the running worker, else it resumes the worker's session;
//   - `answer`: a `close` hold is closed now; a `release` hold resumes the
//     worker's session with the answer;
//   - `notice` about a task's 要你動手 item: kept for that task's resume;
//   - anything else: handled (the board files say what changed).
// An action stays in inbox/ until it has been handed on, so a restart
// finds it again; only then is it moved to inbox/handled/.

import type { HoldEntry, TaskEntry } from "#agg/state-files.js";

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
  | { kind: "notice"; event: string; item: TodoRef | null; by: string };

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

function parseAction(record: Json): Action | undefined {
  const text = str(record["text"]);
  const task = str(record["task"]);
  switch (record["kind"]) {
    case "message": {
      const topic = isRecord(record["topic"]) ? str(record["topic"]["id"]) : undefined;
      return topic === undefined || text === undefined
        ? undefined
        : { kind: "message", topic, text };
    }
    case "direct":
      return task === undefined || text === undefined ? undefined : { kind: "direct", task, text };
    case "answer":
      return task === undefined ? undefined : { kind: "answer", task };
    case "tag":
      return { kind: "tag" };
    case "notice": {
      const event = str(record["event"]);
      if (event === undefined) return undefined;
      return {
        kind: "notice",
        event,
        item: parseTodoRef(record["item"]),
        by: str(record["by"]) ?? "",
      };
    }
    default:
      return undefined;
  }
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
}

export const INBOX_LOG = {
  ended: (task: string) => `direct for ${task} came after its worker ended; not passed on`,
  notHandled: (event: string) => `notice ${event} is not handled in this version`,
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

function sortNotice(item: InboxItem & { kind: "notice" }, view: InboxView, sorted: Sorted): void {
  const task = item.item === null ? undefined : view.tasks.get(item.item.ref);
  const todo = item.event === "todo.claimed" || item.event === "todo.closed";
  if (todo && task !== undefined && !ENDED.has(task.state) && item.by !== "aggregator") {
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

function sortOne(item: InboxItem, view: InboxView, sorted: Sorted): void {
  switch (item.kind) {
    case "message": {
      const topic = view.current(item.topic);
      const worker = view.liveWorkerOn(topic);
      if (worker === undefined) add(sorted.messages, topic, item);
      else sorted.push.push({ task: worker, item });
      return;
    }
    case "direct": {
      const task = view.tasks.get(item.task);
      if (task === undefined || ENDED.has(task.state)) {
        sorted.retire.push({ item, log: INBOX_LOG.ended(item.task) });
      } else if (view.takesInput(item.task)) {
        sorted.push.push({ task: item.task, item });
      } else {
        add(sorted.inputs, item.task, item);
      }
      return;
    }
    case "answer":
      return sortAnswer(item, view, sorted);
    case "notice":
      return sortNotice(item, view, sorted);
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
  };
  const ordered = items.toSorted(
    (a, b) => a.receivedMs - b.receivedMs || a.file.localeCompare(b.file),
  );
  for (const item of ordered) sortOne(item, view, sorted);
  return sorted;
}
