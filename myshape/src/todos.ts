// The hands-on items the board keeps for the captain (要你動手): what an
// aggregator puts on the page, where each item stands, and every way it leaves.
// Pure: each operation takes the store and returns the next one with the
// records and notices the change calls for; store.ts commitChange saves them.
import type { Draft, Frozen, RecordKind } from "./records.js";
import { GOAL_MAX, oneLine, resolveTopicId } from "./topics.js";
import type { TodoMark, TodoState, TopicState } from "./topics.js";

export type ItemState = "open" | TodoState;

/** One hands-on item, as `data/myshape/todos.json` stores it. */
export interface TodoItem {
  title: string;
  /**
   * The topic it was put under (merges followed when shown); null only for an
   * item an older board adopted from before it kept items, which had none.
   */
  topic: string | null;
  action: string;
  guidance: string;
  commands: string[];
  state: ItemState;
  /** Why the aggregator rejected the claim or no longer needs the item. */
  reason: string | null;
  /** When the state last changed. */
  at: string;
  /** The aggregator's name when the item was put on the board. */
  by: string;
  /** Opaque text the aggregator chose; the board only hands it back in notices. */
  ref: string;
  /** Only the captain's own press takes it down when it is no longer needed. */
  captain_closes: boolean;
  created_at: string;
}

export interface TodoStore {
  v: 1;
  items: Record<string, TodoItem>;
  /** Marks carried over from topics.json's `todos` at the board's first start of this file. */
  marks: Record<string, TodoMark>;
}

export type CloseWords = "不做了" | "撤下";

/** How an item left the page, on a closing record. */
export type Outcome = "done" | "dropped" | "taken_down";

/**
 * One record about an item: every step writes one, under the item's topic
 * (none for an item without one). `text` is the line the page shows, with its
 * actor suffix; commitChange adds who made it.
 */
export type TodoRecord = Draft & { outcome?: Outcome };

export interface TodoNotice {
  event: "todo.claimed" | "todo.closed";
  id: string;
  title: string;
  ref: string;
  topic: string | null;
  text: string;
  by?: "captain" | "aggregator";
  words?: string;
}

/** What a hands-on operation did; a change carries at least one record, like a topic change. */
export type TodoResult =
  | {
      ok: true;
      changed: true;
      store: TodoStore;
      line: string;
      records: readonly [TodoRecord, ...TodoRecord[]];
      notices: TodoNotice[];
    }
  | { ok: true; changed: false; store: Frozen<TodoStore>; line: string }
  | { ok: false; code: "refused" | "usage"; line: string };

/** What `todo add` asks for. */
export interface TodoInput {
  id: string;
  title: string;
  /** Required: null is refused. */
  topic: string | null;
  action: string;
  guidance: string;
  commands: string[];
  ref: string;
  captainCloses: boolean;
}

/** Who made a change: the captain on the page, or the aggregator, by its label, through a command. */
export interface Actor {
  by: "captain" | "aggregator";
  label: string;
}

const ID_MAX = 128;
const REF_MAX = 128;
const ACTION_MAX = 1000;
const TEXT_MAX = 20_000;
const COMMANDS_MAX = 50;

export function emptyTodos(): TodoStore {
  return { v: 1, items: {}, marks: {} };
}

/** The id grammar topic ids and task ids share, at most 128 characters. */
export function isValidItemId(id: string): boolean {
  // Assigning to "__proto__" would set the store's prototype instead of an item.
  return id.length <= ID_MAX && /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(id) && id !== "__proto__";
}

function refused(line: string): TodoResult {
  return { ok: false, code: "refused", line };
}

function usage(line: string): TodoResult {
  return { ok: false, code: "usage", line };
}

function unchanged(store: Frozen<TodoStore>, line: string): TodoResult {
  return { ok: true, changed: false, store, line };
}

function changed(
  store: TodoStore,
  line: string,
  records: readonly [TodoRecord, ...TodoRecord[]],
  notices: TodoNotice[] = [],
): TodoResult {
  return { ok: true, changed: true, store, line, records, notices };
}

function itemOf(store: Frozen<TodoStore>, id: string): Frozen<TodoItem> | undefined {
  return Object.hasOwn(store.items, id) ? store.items[id] : undefined;
}

function notOpen(id: string): TodoResult {
  return refused(`${id} 不是看板上還開著的「要你動手」項目，沒有改任何東西。`);
}

/** The record of one step: `what` follows the item's name, the actor's suffix ends it. */
function record(
  kind: RecordKind,
  item: Frozen<TodoItem>,
  id: string,
  actor: Actor,
  what: string,
  extra: { outcome?: Outcome; reason?: string } = {},
): TodoRecord {
  const suffix = actor.by === "captain" ? "（你在頁面上）" : `（${actor.label} 用指令）`;
  return {
    kind,
    topic: item.topic,
    item: id,
    ...extra,
    text: `要你動手「${item.title}」${what}${suffix}`,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** MM-DD HH:mm in this machine's time, the way the page prints times. */
export function shortTime(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The topic an item goes under: a live topic, a merged id followed. */
function placeItem(topics: Frozen<TopicState>, input: TodoInput): { topic: string } | string {
  if (input.topic === null) return "需要 --topic <議題 id>。";
  const id = resolveTopicId(topics.doc, input.topic);
  if (topics.doc.topics[id] !== undefined) return { topic: id };
  return `${input.topic} 不是看板上還開著的議題，沒有放上任何東西。`;
}

/** The input's problem as a usage line, or null when it is well formed. */
function inputProblem(input: TodoInput): string | null {
  if (!isValidItemId(input.id)) return `task id 格式不對：${input.id}`;
  if (oneLine(input.title, GOAL_MAX) === null) return `標題要是一行，最多 ${GOAL_MAX} 個字。`;
  if (oneLine(input.action, ACTION_MAX) === null) return "--do 要是一行。";
  if (input.guidance.length > TEXT_MAX) return "--note 太長。";
  if (input.commands.length > COMMANDS_MAX) return `--cmd 最多 ${COMMANDS_MAX} 個。`;
  if (input.commands.some((command) => command.trim() === "" || command.length > TEXT_MAX))
    return "--cmd 後面要有內容。";
  if (input.ref.length > REF_MAX || /[\n\r]/.test(input.ref))
    return "--ref 要是一行，最多 128 個字。";
  return null;
}

function sameText(item: Frozen<TodoItem>, input: TodoInput, topic: string | null): boolean {
  return (
    item.title === input.title.trim() &&
    item.topic === topic &&
    item.action === input.action.trim() &&
    item.guidance === input.guidance &&
    JSON.stringify(item.commands) === JSON.stringify(input.commands)
  );
}

function addedLine(id: string, topic: string | null): string {
  return `ok ${id} 已放上看板的「要你動手」（${topic === null ? "沒有議題" : `議題 ${topic}`}）`;
}

/** What the record of an add says: a new item or a rewrite. */
function addRecord(next: TodoItem, id: string, actor: Actor, rewrite: boolean): TodoRecord {
  if (rewrite) return record("todo.rewritten", next, id, actor, "內容已改寫，回到還沒做");
  return record("todo.opened", next, id, actor, `已開：${next.action}`);
}

/**
 * Puts an item on the board, or rewrites it. A rewrite of different text
 * starts over at "open": what was said about the old text no longer holds.
 * Repeating the same text changes nothing.
 */
export function addItem(
  store: Frozen<TodoStore>,
  topics: Frozen<TopicState>,
  input: TodoInput,
  now: string,
  agent: { name: string; label: string },
): TodoResult {
  const problem = inputProblem(input);
  if (problem !== null) return usage(problem);
  const placed = placeItem(topics, input);
  if (typeof placed === "string") return input.topic === null ? usage(placed) : refused(placed);
  const current = itemOf(store, input.id);
  const line = addedLine(input.id, placed.topic);
  if (current !== undefined && sameText(current, input, placed.topic))
    return unchanged(store, line);
  const next = structuredClone(store) as TodoStore;
  delete next.marks[input.id];
  const item: TodoItem = {
    title: input.title.trim(),
    topic: placed.topic,
    action: input.action.trim(),
    guidance: input.guidance,
    commands: input.commands,
    state: "open",
    reason: null,
    at: now,
    by: agent.name,
    ref: input.ref !== "" ? input.ref : (current?.ref ?? ""),
    captain_closes: input.captainCloses || (current?.captain_closes ?? false),
    created_at: current?.created_at ?? now,
  };
  next.items[input.id] = item;
  const actor: Actor = { by: "aggregator", label: agent.label };
  return changed(next, line, [addRecord(item, input.id, actor, current !== undefined)]);
}

function withState(
  store: Frozen<TodoStore>,
  id: string,
  state: ItemState,
  now: string,
  reason: string | null,
): TodoStore {
  const next = structuredClone(store) as TodoStore;
  next.items[id] = { ...(next.items[id] as TodoItem), state, reason, at: now };
  return next;
}

/** The store without the item. */
function without(store: Frozen<TodoStore>, id: string): TodoStore {
  const next = structuredClone(store) as TodoStore;
  delete next.items[id];
  return next;
}

function closing(
  item: Frozen<TodoItem>,
  id: string,
  text: string,
  by: "captain" | "aggregator",
  words: string,
): TodoNotice {
  return {
    event: "todo.closed",
    id,
    title: item.title,
    ref: item.ref,
    topic: item.topic,
    text,
    by,
    words,
  };
}

/** The captain's 做完了 on the page: the aggregator is told, and checks. */
export function claimItem(
  store: Frozen<TodoStore>,
  id: string,
  now: string,
  label: string,
): TodoResult {
  const item = itemOf(store, id);
  if (item === undefined) return notOpen(id);
  if (item.state === "obsolete") return refused(`${id} 已經被 ${label} 標成不再需要，請直接撤下。`);
  if (item.state === "claimed") return unchanged(store, `ok ${id} 本來就已記下做完了，等驗證`);
  const failed = `bin/myshape.sh todo failed ${id} --reason <一行>`;
  const text = `使用者在看板上：「${item.title}」做完了（${id}）。驗證後跑 bin/myshape.sh todo done ${id}；沒成功就跑 ${failed}`;
  const notice: TodoNotice = {
    event: "todo.claimed",
    id,
    title: item.title,
    ref: item.ref,
    topic: item.topic,
    text,
  };
  const event = record("todo.claimed", item, id, { by: "captain", label }, "：你按了做完了");
  return changed(
    withState(store, id, "claimed", now, null),
    `ok ${id} 已記下做完了，等驗證`,
    [event],
    [notice],
  );
}

/** The aggregator checked and it was not done: back in front of the captain with the reason. */
export function rejectItem(
  store: Frozen<TodoStore>,
  id: string,
  reason: string,
  now: string,
  label: string,
): TodoResult {
  const item = itemOf(store, id);
  if (item === undefined) return notOpen(id);
  const line = oneLine(reason, GOAL_MAX);
  if (line === null) return refused(`原因要是一行，最多 ${GOAL_MAX} 個字。`);
  if (item.state === "rejected" && item.reason === line)
    return unchanged(store, `ok ${id} 本來就已標成驗證沒過，回到要使用者動手`);
  const actor: Actor = { by: "aggregator", label };
  const event = record("todo.rejected", item, id, actor, `：${label} 驗證沒過：${line}`, {
    reason: line,
  });
  return changed(
    withState(store, id, "rejected", now, line),
    `ok ${id} 已標成驗證沒過，回到要使用者動手`,
    [event],
  );
}

/**
 * The aggregator no longer needs the item: it leaves the page at once, with
 * the reason in its topic's updates. An item only the captain may close waits
 * for the captain's 好，撤下 instead.
 */
export function obsoleteItem(
  store: Frozen<TodoStore>,
  id: string,
  reason: string,
  now: string,
  label: string,
): TodoResult {
  const item = itemOf(store, id);
  if (item === undefined) return notOpen(id);
  const line = oneLine(reason, GOAL_MAX);
  if (line === null) return refused(`原因要是一行，最多 ${GOAL_MAX} 個字。`);
  const actor: Actor = { by: "aggregator", label };
  if (item.captain_closes) {
    if (item.state === "obsolete" && item.reason === line)
      return unchanged(store, `ok ${id} 本來就已標成不再需要，等使用者撤下`);
    const event = record("todo.obsolete", item, id, actor, `：${label} 標成不再需要：${line}`, {
      reason: line,
    });
    return changed(
      withState(store, id, "obsolete", now, line),
      `ok ${id} 已標成不再需要，等使用者撤下`,
      [event],
    );
  }
  const event = record("todo.taken_down", item, id, actor, `已撤下：不再需要，${line}`, {
    outcome: "taken_down",
    reason: line,
  });
  const notice = closing(
    item,
    id,
    `「${item.title}」已撤下：不再需要，${line}（${id}）`,
    "aggregator",
    "撤下",
  );
  return changed(without(store, id), `ok ${id} 已撤下（不再需要）`, [event], [notice]);
}

/** The aggregator checked that the captain did it: the item is closed. */
export function doneItem(store: Frozen<TodoStore>, id: string, label: string): TodoResult {
  const item = itemOf(store, id);
  if (item === undefined)
    return refused(`${id} 不是開著的「要你動手」項目，沒有關任何東西（已經關過的話不用再跑）。`);
  const actor: Actor = { by: "aggregator", label };
  const event = record("todo.done", item, id, actor, `已關：做完了，${label} 已驗證`, {
    outcome: "done",
  });
  const notice = closing(
    item,
    id,
    `「${item.title}」已關：做完了，${label} 已驗證（${id}）`,
    "aggregator",
    "做完了",
  );
  return changed(without(store, id), `ok ${id} 已關（做完了，${label} 已驗證）`, [event], [notice]);
}

/**
 * The captain's 不做了, or 好，撤下 on an item the aggregator no longer needs:
 * the item leaves the page with the captain's words in its topic's updates.
 */
export function closeByCaptain(
  store: Frozen<TodoStore>,
  id: string,
  words: CloseWords,
  label: string,
): TodoResult {
  const item = itemOf(store, id);
  if (item === undefined) return notOpen(id);
  if (words === "撤下" && item.state !== "obsolete")
    return refused(`${id} 沒有被標成不再需要，不能撤下。`);
  if (words === "不做了" && (item.state === "obsolete" || item.state === "claimed"))
    return refused(`${id} 現在不能按不做了。`);
  const actor: Actor = { by: "captain", label };
  const event =
    words === "撤下"
      ? record("todo.taken_down", item, id, actor, "已撤下", { outcome: "taken_down" })
      : record("todo.dropped", item, id, actor, "已關：你選了不做了", { outcome: "dropped" });
  const notice = closing(
    item,
    id,
    `使用者在看板上：「${item.title}」${words}（${id}）`,
    "captain",
    words,
  );
  return changed(without(store, id), `ok ${id} 已拿掉（${words}）`, [event], [notice]);
}

/**
 * The first start of a board that keeps items itself: topics.json's marks
 * become waiting marks in a new store, with a record that says so.
 */
export function carryMarks(marks: Frozen<Record<string, TodoMark>>): TodoResult {
  const ids = Object.keys(marks);
  const store: TodoStore = {
    ...emptyTodos(),
    marks: structuredClone(marks) as Record<string, TodoMark>,
  };
  if (ids.length === 0) return unchanged(store, "ok 沒有舊狀態要帶過來");
  const text = `看板開始自己存「要你動手」：從 topics.json 帶過來 ${ids.length} 個舊狀態（${ids.join("、")}）`;
  return changed(store, `ok 帶過來 ${ids.length} 個舊狀態`, [
    { kind: "todo.marks_carried", topic: null, text },
  ]);
}

/** The topics with topics.json's `todos` rewritten as the projection of `store`. */
export function withProjection(topics: Frozen<TopicState>, store: Frozen<TodoStore>): TopicState {
  const next = structuredClone(topics) as TopicState;
  next.doc.todos = projectMarks(store);
  return next;
}

/**
 * What topics.json's `todos` keeps publishing: the mark of every item that is
 * not "open", plus every waiting mark, so a reader of that file (or an older
 * board after a rollback) still sees them.
 */
export function projectMarks(store: Frozen<TodoStore>): Record<string, TodoMark> {
  const marks: Record<string, TodoMark> = { ...store.marks };
  for (const [id, item] of Object.entries(store.items)) {
    if (item.state === "open") continue;
    marks[id] =
      item.reason === null
        ? { state: item.state, at: item.at }
        : { state: item.state, at: item.at, reason: item.reason };
  }
  return marks;
}

/** Where an item shows now: its topic with merges followed, or none. */
export function itemTopic(topics: Frozen<TopicState>, item: Frozen<TodoItem>): string | null {
  return item.topic === null ? null : resolveTopicId(topics.doc, item.topic);
}
