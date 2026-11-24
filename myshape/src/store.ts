// Loads the board's state files and is their only writer. A change and its
// records are saved together: commitChange renames the change's one commit
// file (topics.json, todos.json or confirmations.json) with the records in
// its `outbox`, then appends them to events.jsonl,
// and every later commit (and every start) first saves any outbox record the
// journal still lacks.
import fs from "node:fs";
import {
  isRecord,
  readJsonFile,
  stringField,
  stringRecord,
  textField,
  writeFileAtomic,
} from "./files.js";
import type { BoardPaths } from "./layout.js";
import { OPTIONAL_TEXT_FIELDS, stampRecord } from "./records.js";
import type { Actor, Draft, Frozen, Records, StoredRecord } from "./records.js";
import {
  GOAL_MAX,
  HISTORY_ACTORS,
  HISTORY_KINDS,
  QUEUES,
  QUEUE_LABEL,
  TODO_STATES,
  emptyState,
  isQueue,
  oneLine,
} from "./topics.js";
import type {
  ArchiveDoc,
  ArchivedTopic,
  HistoryEntry,
  Queue,
  TodoMark,
  Topic,
  TopicState,
  TopicsDoc,
} from "./topics.js";
import { emptyConfirmations } from "./confirmations.js";
import type { Confirmation, ConfirmationStore } from "./confirmations.js";
import { carryMarks, emptyTodos, isValidItemId, withProjection } from "./todos.js";
import type { ItemState, TodoItem, TodoStore } from "./todos.js";

const FILE_MODE = 0o644;

function parseCloseProposal(raw: unknown): Topic["close_proposal"] {
  if (!isRecord(raw) || typeof raw["at"] !== "string" || typeof raw["reason"] !== "string")
    return undefined;
  return { at: raw["at"], reason: raw["reason"] };
}

/**
 * A topic that board code from before every topic was confirmed at once left
 * waiting for the captain, and the queue it was proposed for.
 */
export interface LeftoverProposal {
  id: string;
  name: string;
  queue: Queue;
}

interface ParsedTopic {
  topic: Topic;
  /** The queue a leftover proposal asked for (normal when it named none); null for a confirmed topic. */
  proposedFor: Queue | null;
}

function parseTopic(id: string, raw: unknown): ParsedTopic {
  if (!isRecord(raw)) throw new Error(`topic ${id} is not an object`);
  const { name, goal, status } = raw;
  if (typeof name !== "string" || typeof goal !== "string")
    throw new Error(`topic ${id} lacks name or goal`);
  if (status !== "proposed" && status !== "confirmed")
    throw new Error(`topic ${id} has an unknown status`);
  const topic: Topic = {
    name,
    goal,
    status: "confirmed",
    created_at: textField(raw, "created_at"),
  };
  const close = parseCloseProposal(raw["close_proposal"]);
  if (close !== undefined) topic.close_proposal = close;
  const suggested = raw["suggested_queue"];
  const proposedFor = status === "confirmed" ? null : isQueue(suggested) ? suggested : "normal";
  return { topic, proposedFor };
}

/** A queue holds topics that were already confirmed on disk, each once. */
function parseQueue(raw: unknown, confirmed: Set<string>): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw)].filter(
    (id): id is string => typeof id === "string" && confirmed.has(id),
  );
}

function parseNextSeq(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) ? Math.max(1, raw) : 1;
}

function parseHistoryEntry(raw: unknown): HistoryEntry | null {
  if (!isRecord(raw)) return null;
  const kind = HISTORY_KINDS.find((name) => name === raw["kind"]);
  const at = stringField(raw, "at");
  const topic = stringField(raw, "topic");
  const name = stringField(raw, "name");
  if (kind === undefined || at === null || topic === null || name === null) return null;
  const entry: HistoryEntry = { at, kind, topic, name };
  const from = stringField(raw, "from");
  const fromName = stringField(raw, "from_name");
  if (from !== null) entry.from = from;
  if (fromName !== null) entry.from_name = fromName;
  // A reason someone edited into something that is not one line is dropped, not printed.
  const reason = oneLine(stringField(raw, "reason") ?? "", GOAL_MAX);
  const by = HISTORY_ACTORS.find((actor) => actor === raw["by"]);
  if (reason !== null) entry.reason = reason;
  if (by !== undefined) entry.by = by;
  return withPlace(entry, raw);
}

/** A move's queue and 1-based place, and a goal change's new goal, when the entry has them. */
function withPlace(entry: HistoryEntry, raw: Record<string, unknown>): HistoryEntry {
  const position = raw["position"];
  const goal = oneLine(stringField(raw, "goal") ?? "", GOAL_MAX);
  if (isQueue(raw["queue"])) entry.queue = raw["queue"];
  if (typeof position === "number" && Number.isInteger(position) && position > 0)
    entry.position = position;
  if (goal !== null) entry.goal = goal;
  return entry;
}

function parseHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseHistoryEntry).filter((entry): entry is HistoryEntry => entry !== null);
}

function parseTodos(raw: unknown): Record<string, TodoMark> {
  const todos: Record<string, TodoMark> = {};
  if (!isRecord(raw)) return todos;
  for (const [task, value] of Object.entries(raw)) {
    if (!isRecord(value) || task === "__proto__") continue;
    const state = TODO_STATES.find((name) => name === value["state"]);
    const at = stringField(value, "at");
    if (state === undefined || at === null) continue;
    const reason = stringField(value, "reason");
    todos[task] = reason === null ? { state, at } : { state, at, reason };
  }
  return todos;
}

interface ParsedDoc {
  doc: TopicsDoc;
  /** Leftover proposals, now confirmed and last in their queues, oldest first. */
  confirmed: LeftoverProposal[];
}

/**
 * Reads the live topics. A leftover proposal is confirmed here, at the end of
 * the queue it was proposed for, so no topic is ever left waiting.
 */
function parseDoc(raw: unknown): ParsedDoc {
  if (!isRecord(raw) || raw["v"] !== 1) throw new Error("expected an object with v: 1");
  const topics = raw["topics"];
  if (!isRecord(topics)) throw new Error("topics is not an object");
  const doc = emptyState().doc;
  // Keyed by creation time, then id, so sorting the keys puts the oldest first.
  const waiting = new Map<string, LeftoverProposal>();
  const confirmed = new Set<string>();
  for (const [id, value] of Object.entries(topics)) {
    const { topic, proposedFor } = parseTopic(id, value);
    doc.topics[id] = topic;
    if (proposedFor === null) confirmed.add(id);
    else
      waiting.set(`${topic.created_at}\u0000${id}`, { id, name: topic.name, queue: proposedFor });
  }
  const queues = isRecord(raw["queues"]) ? raw["queues"] : {};
  for (const queue of QUEUES) doc.queues[queue] = parseQueue(queues[queue], confirmed);
  const oldestFirst = [...waiting.keys()]
    .toSorted()
    .map((key) => waiting.get(key) as LeftoverProposal);
  for (const proposal of oldestFirst) doc.queues[proposal.queue].push(proposal.id);
  doc.merged = stringRecord(raw["merged"]);
  doc.history = parseHistory(raw["history"]);
  doc.todos = parseTodos(raw["todos"]);
  doc.next_seq = parseNextSeq(raw["next_seq"]);
  return { doc, confirmed: oldestFirst };
}

interface ParsedArchive {
  archive: ArchiveDoc;
  /** Archived topics stored as proposals, which the file will no longer hold once rewritten. */
  proposals: { id: string; name: string }[];
}

function parseArchive(raw: unknown): ParsedArchive {
  if (!isRecord(raw) || raw["v"] !== 1 || !isRecord(raw["topics"])) {
    throw new Error("expected an object with v: 1 and topics");
  }
  const archive: ArchiveDoc = { v: 1, topics: {} };
  const proposals: { id: string; name: string }[] = [];
  for (const [id, value] of Object.entries(raw["topics"])) {
    const { topic, proposedFor } = parseTopic(id, value);
    if (proposedFor !== null) proposals.push({ id, name: topic.name });
    const archived: ArchivedTopic = {
      ...topic,
      archived_at: textField(value as Record<string, unknown>, "archived_at"),
    };
    archive.topics[id] = archived;
  }
  return { archive, proposals };
}

function readFile(file: string): unknown {
  try {
    return readJsonFile(file);
  } catch (error) {
    throw new Error(`${file} 讀不懂：${(error as Error).message}`, { cause: error });
  }
}

function parseFile<T>(file: string, raw: unknown, parse: (raw: unknown) => T): T {
  try {
    return parse(raw);
  } catch (error) {
    throw new Error(`${file} 讀不懂：${(error as Error).message}`, { cause: error });
  }
}

const OPTIONAL_RECORD_FIELDS = ["item", ...OPTIONAL_TEXT_FIELDS] as const;

function parseRecord(raw: unknown): StoredRecord | null {
  if (!isRecord(raw) || raw["src"] !== "board") return null;
  const rid = stringField(raw, "rid");
  const kind = stringField(raw, "kind");
  const by = stringField(raw, "by");
  const ts = raw["ts"];
  if (rid === null || kind === null || by === null || typeof ts !== "number") return null;
  const record: StoredRecord = {
    src: "board",
    rid,
    ts,
    kind,
    topic: stringField(raw, "topic"),
    home: stringField(raw, "home"),
    task: stringField(raw, "task"),
    by,
    label: textField(raw, "label"),
    text: textField(raw, "text"),
  };
  for (const name of OPTIONAL_RECORD_FIELDS) {
    const value = stringField(raw, name);
    if (value !== null) record[name] = value;
  }
  return record;
}

/** The records a commit file says it saved last; anything that is not a whole record is skipped. */
function parseOutbox(raw: unknown): StoredRecord[] {
  if (!isRecord(raw) || !Array.isArray(raw["outbox"])) return [];
  return raw["outbox"].flatMap((entry: unknown) => {
    const parsed = parseRecord(entry);
    return parsed === null ? [] : [parsed];
  });
}

/** The three files a change can commit through; each holds the records of its last commit. */
export type CommitFile = "topics" | "todos" | "confirmations";

/** What the board keeps on disk, as the service holds it. */
export interface StoredBoard {
  topics: Frozen<TopicState>;
  todos: Frozen<TodoStore>;
  confirmations: Frozen<ConfirmationStore>;
  outbox: Readonly<Record<CommitFile, readonly StoredRecord[]>>;
}

/** Where records are saved: the journal, or a stand-in in a test. */
export interface RecordSink {
  has: (rid: string) => boolean;
  /** Saves one record durably; throws when it cannot. */
  append: (record: StoredRecord) => void;
}

/** What commitChange needs besides the change: the files, the journal, record ids and the clock. */
export interface CommitTarget {
  paths: BoardPaths;
  sink: RecordSink;
  nextRid: () => string;
  nowSeconds: () => number;
}

/** One change: its commit file, the next state of that file's family, and its records. */
export type Change =
  | { file: "topics"; next: Frozen<TopicState>; records: Records }
  | { file: "todos"; next: Frozen<TodoStore>; records: Records }
  | { file: "confirmations"; next: Frozen<ConfirmationStore>; records: Records };

export type Committed =
  | {
      ok: true;
      board: StoredBoard;
      records: StoredRecord[];
      /** Why the records could not be appended after the change was saved; they wait in the outbox. */
      appendError: string | null;
    }
  | { ok: false; line: string };

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Writes `text` to `file` unless the file already holds exactly that; a
 * missing file counts as holding `absent`, the text of an empty one.
 */
function writeIfChanged(file: string, text: string, absent: string): void {
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : absent;
  if (current !== text) writeFileAtomic(file, text, FILE_MODE);
}

const EMPTY_ARCHIVE = serialize(emptyState().archive);
const EMPTY_DOC = serialize({ ...emptyState().doc, outbox: [] });

/** Appends every outbox record the journal lacks; returns why it could not, or null. */
function flushOutbox(sink: RecordSink, outbox: StoredBoard["outbox"]): string | null {
  for (const record of [...outbox.topics, ...outbox.todos, ...outbox.confirmations]) {
    if (sink.has(record.rid)) continue;
    try {
      sink.append(record);
    } catch (error) {
      return (error as Error).message;
    }
  }
  return null;
}

/**
 * Writes the files of a topic change. topics.json is the commit point: the
 * archive is written before it unless the change takes a topic out of the
 * archive (a reopen), so a crash before the commit point leaves the topic
 * live and nothing recorded, and one after it leaves a copy the loader drops.
 */
function writeTopics(
  paths: BoardPaths,
  previous: Frozen<TopicState>,
  next: Frozen<TopicState>,
  outbox: readonly StoredRecord[],
): void {
  const archiveText = serialize(next.archive);
  const losesTopic = Object.keys(previous.archive.topics).some(
    (id) => next.archive.topics[id] === undefined,
  );
  if (!losesTopic) writeIfChanged(paths.archive, archiveText, EMPTY_ARCHIVE);
  writeFileAtomic(paths.topics, serialize({ ...next.doc, outbox }), FILE_MODE);
  if (losesTopic) writeIfChanged(paths.archive, archiveText, EMPTY_ARCHIVE);
}

/**
 * Writes the files of a hands-on change. todos.json is the commit point;
 * topics.json's projection of it is written first and rebuilt from todos.json
 * at load, so a crash between the two leaves no change and nothing recorded.
 * topics.json keeps the outbox of the last topic change.
 */
function writeTodos(
  paths: BoardPaths,
  board: StoredBoard,
  next: Frozen<TodoStore>,
  outbox: readonly StoredRecord[],
): Frozen<TopicState> {
  const topics = withProjection(board.topics, next);
  writeIfChanged(
    paths.topics,
    serialize({ ...topics.doc, outbox: board.outbox.topics }),
    EMPTY_DOC,
  );
  fs.mkdirSync(paths.boardDataDir, { recursive: true });
  writeFileAtomic(paths.todos, serialize({ ...next, outbox }), FILE_MODE);
  return topics;
}

/** Writes the captain's confirmations; confirmations.json is its own commit point. */
function writeConfirmations(
  paths: BoardPaths,
  next: Frozen<ConfirmationStore>,
  outbox: readonly StoredRecord[],
): void {
  fs.mkdirSync(paths.boardDataDir, { recursive: true });
  writeFileAtomic(paths.confirmations, serialize({ ...next, outbox }), FILE_MODE);
}

/**
 * The only writer of the board's state files. First saves every earlier
 * record still waiting in an outbox, and refuses the change when it cannot.
 * Then saves the change with its records in the commit file's outbox, in the
 * same rename, and appends them to the journal. A failed append after the
 * rename does not undo the change: its records wait in the outbox for the
 * next commit or start.
 */
export function commitChange(
  target: CommitTarget,
  board: StoredBoard,
  change: Change,
  actor: Actor,
): Committed {
  const unsaved = flushOutbox(target.sink, board.outbox);
  if (unsaved !== null)
    return { ok: false, line: `看板寫不進紀錄（${unsaved}），這次的修改沒有做` };
  const ts = target.nowSeconds();
  const records = change.records.map((draft: Draft) =>
    stampRecord(draft, actor, target.nextRid(), ts),
  );
  fs.mkdirSync(target.paths.dataDir, { recursive: true });
  let next: StoredBoard;
  if (change.file === "topics") {
    writeTopics(target.paths, board.topics, change.next, records);
    next = { ...board, topics: change.next, outbox: { ...board.outbox, topics: records } };
  } else if (change.file === "todos") {
    const topics = writeTodos(target.paths, board, change.next, records);
    next = { ...board, topics, todos: change.next, outbox: { ...board.outbox, todos: records } };
  } else {
    writeConfirmations(target.paths, change.next, records);
    next = {
      ...board,
      confirmations: change.next,
      outbox: { ...board.outbox, confirmations: records },
    };
  }
  return { ok: true, board: next, records, appendError: flushOutbox(target.sink, next.outbox) };
}

export interface ReadBoard {
  board: StoredBoard;
  /** Whether todos.json exists: a board that never kept items carries topics.json's marks over. */
  hasTodos: boolean;
  /** Leftover live proposals the read confirmed, oldest first. */
  confirmed: LeftoverProposal[];
  /** Archived topics stored as proposals. */
  archivedProposals: { id: string; name: string }[];
}

/**
 * Reads the state files without writing anything. A crash between the two
 * writes of an archive or reopen can leave a topic in both topic files; the
 * live copy wins (an interrupted archive is simply redone, an interrupted
 * reopen is already complete). topics.json's marks are rebuilt from
 * todos.json when it exists.
 */
export function readBoard(paths: BoardPaths): ReadBoard {
  const empty = emptyState();
  const rawTopics = readFile(paths.topics);
  const rawArchive = readFile(paths.archive);
  const rawTodos = readFile(paths.todos);
  const rawConfirmations = readFile(paths.confirmations);
  const live =
    rawTopics === null
      ? { doc: empty.doc, confirmed: [] }
      : parseFile(paths.topics, rawTopics, parseDoc);
  const gone =
    rawArchive === null
      ? { archive: empty.archive, proposals: [] }
      : parseFile(paths.archive, rawArchive, parseArchive);
  for (const id of Object.keys(gone.archive.topics)) {
    if (live.doc.topics[id] !== undefined) delete gone.archive.topics[id];
  }
  const state: TopicState = { doc: live.doc, archive: gone.archive };
  const store = rawTodos === null ? null : parseFile(paths.todos, rawTodos, parseTodoStore);
  const confirmations =
    rawConfirmations === null
      ? emptyConfirmations()
      : parseFile(paths.confirmations, rawConfirmations, parseConfirmations);
  return {
    board: {
      topics: store === null ? state : withProjection(state, store),
      todos: store ?? emptyTodos(),
      confirmations,
      outbox: {
        topics: parseOutbox(rawTopics),
        todos: parseOutbox(rawTodos),
        confirmations: parseOutbox(rawConfirmations),
      },
    },
    hasTodos: store !== null,
    confirmed: live.confirmed,
    archivedProposals: gone.proposals,
  };
}

export interface LoadedBoard {
  board: StoredBoard;
  /** Leftover live proposals this start confirmed; empty on every later start. */
  confirmed: LeftoverProposal[];
  /** Why records of this start could not be appended; they wait in the outbox. */
  appendErrors: string[];
}

/** The records of confirming leftover proposals, live and archived; null when there are none. */
function confirmRecords(read: ReadBoard): Records | null {
  const drafts: Draft[] = [
    ...read.confirmed.map((proposal) => ({
      kind: "topic.confirmed" as const,
      topic: proposal.id,
      text: `議題「${proposal.name}」已確認，排在「${QUEUE_LABEL[proposal.queue]}」最後`,
    })),
    ...read.archivedProposals.map((proposal) => ({
      kind: "topic.confirmed" as const,
      topic: proposal.id,
      text: `議題「${proposal.name}」已確認，留在已封存`,
    })),
  ];
  const [first, ...rest] = drafts;
  return first === undefined ? null : [first, ...rest];
}

function afterCommit(result: Committed, errors: string[]): StoredBoard {
  if (!result.ok) throw new Error(result.line);
  if (result.appendError !== null) errors.push(result.appendError);
  return result.board;
}

/**
 * Loads the board at startup. Saves every outbox record the journal lacks
 * (throwing when it cannot, since no change could be made), then makes the
 * start's own changes through commitChange as the board itself: leftover
 * proposals are confirmed, and the first start of a board that keeps items
 * carries topics.json's marks into todos.json.
 */
export function loadBoard(target: CommitTarget, label: string): LoadedBoard {
  const read = readBoard(target.paths);
  const unsaved = flushOutbox(target.sink, read.board.outbox);
  if (unsaved !== null) throw new Error(`看板寫不進紀錄（${unsaved}）`);
  const actor: Actor = { by: "board", label };
  const errors: string[] = [];
  let board = read.board;
  const confirms = confirmRecords(read);
  if (confirms !== null) {
    const change: Change = { file: "topics", next: board.topics, records: confirms };
    board = afterCommit(commitChange(target, board, change, actor), errors);
  }
  if (!read.hasTodos) {
    const carried = carryMarks(board.topics.doc.todos);
    if (carried.ok && carried.changed) {
      const change: Change = { file: "todos", next: carried.store, records: carried.records };
      board = afterCommit(commitChange(target, board, change, actor), errors);
    }
  }
  return { board, confirmed: read.confirmed, appendErrors: errors };
}

const ITEM_STATES: readonly ItemState[] = ["open", ...TODO_STATES];

function stringList(raw: unknown): string[] | null {
  return Array.isArray(raw) && raw.every((value) => typeof value === "string") ? raw : null;
}

/** One stored item, or null when it lacks what the page needs to show it. */
function parseItem(raw: unknown): TodoItem | null {
  if (!isRecord(raw)) return null;
  const title = stringField(raw, "title");
  const action = stringField(raw, "action");
  const state = ITEM_STATES.find((name) => name === raw["state"]);
  const commands = stringList(raw["commands"]);
  const topic = raw["topic"];
  if (title === null || action === null || state === undefined || commands === null) return null;
  if (topic !== null && typeof topic !== "string") return null;
  return {
    title,
    topic,
    action,
    guidance: textField(raw, "guidance"),
    commands,
    state,
    reason: stringField(raw, "reason"),
    at: textField(raw, "at"),
    by: textField(raw, "by"),
    ref: textField(raw, "ref"),
    captain_closes: raw["captain_closes"] === true,
    created_at: textField(raw, "created_at"),
  };
}

function parseTodoStore(raw: unknown): TodoStore {
  if (!isRecord(raw) || raw["v"] !== 1) throw new Error("expected an object with v: 1");
  const store = emptyTodos();
  const items = isRecord(raw["items"]) ? raw["items"] : {};
  for (const [id, value] of Object.entries(items)) {
    const item = parseItem(value);
    if (item !== null && isValidItemId(id)) store.items[id] = item;
  }
  store.marks = parseTodos(raw["marks"]);
  return store;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** One stored confirmation, or null when it is not a whole one: then it confirms nothing. */
function parseConfirmation(raw: unknown): Confirmation | null {
  if (!isRecord(raw)) return null;
  const program = stringField(raw, "path");
  const sha256 = stringField(raw, "sha256");
  const bindingSha256 = stringField(raw, "binding_sha256");
  if (program === null || !program.startsWith("/")) return null;
  if (sha256 === null || !SHA256.test(sha256)) return null;
  if (bindingSha256 === null || !SHA256.test(bindingSha256)) return null;
  return { path: program, sha256, binding_sha256: bindingSha256, at: textField(raw, "at") };
}

function parseConfirmations(raw: unknown): ConfirmationStore {
  if (!isRecord(raw) || raw["v"] !== 1) throw new Error("expected an object with v: 1");
  const entries = Array.isArray(raw["entries"]) ? raw["entries"] : [];
  return {
    v: 1,
    entries: entries.flatMap((entry: unknown) => {
      const parsed = parseConfirmation(entry);
      return parsed === null ? [] : [parsed];
    }),
  };
}
