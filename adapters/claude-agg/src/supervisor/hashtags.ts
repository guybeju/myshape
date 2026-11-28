// Hashtags on the topics the planner plans (plan section 3.7, D11; the tag
// list's design, sections 5.2 to 5.4). The board's list goes into the
// planner's prompt (hashtagList), with other topics' names as examples cut to
// a plain line of at most 40 code points. The planner may ask for at most
// three changes to the topic it plans; pickHashtags turns those into changes
// to send, for the topic the supervisor names and never one the model
// names: a name put on is one the board lists unless the model said it is
// new, a name taken off is the topic's own spelling, and a change the
// captain reverted on the page (revertedChanges) is not made again. Each one
// then goes through the Tagger, guarded on the agent's own side before
// anything goes to the board: the name's grammar, the captain's settings
// (aggregator_may_tag, aggregator_may_create, per_topic_max, board_max,
// aggregator_hourly_max) and the lock, all read from
// data/myshape/hashtags.json, with the hourly count read from
// data/myshape/events.jsonl the way the board counts it. The change itself
// goes only through `bin/myshape.sh hashtag`, so the board records it
// `by: aggregator` and checks the same rules again. claude-agg never creates
// a topic or a schedule. These guards are rails against a careless or misled
// planner, not a boundary: the board's socket checks no identity.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { readBoard, type Board, type HashtagsFile } from "./board-files.js";
import type { BoardCommand } from "./commands.js";
import { followMerges } from "./dispatch-order.js";
import type { HashtagAsk } from "./outputs.js";

export const HOUR_SECONDS = 3600;
const NAME = /^[\p{L}\p{M}\p{N}_]{1,32}$/u;
const WATCHED = new Set(["hashtag.added", "hashtag.removed"]);

export type HashtagChange = "add" | "remove";

/** The form two spellings of a hashtag are compared in: NFKC, then lower case. */
export function hashtagKey(name: string): string {
  return name.normalize("NFKC").toLowerCase();
}

export interface HashtagSituation {
  hashtags: HashtagsFile;
  /** The topic's id, merges followed. */
  topic: string;
  /** Whether the topic is on the board now. */
  live: boolean;
  /** Old topic id to new, as data/topics.json has it. */
  merged: ReadonlyMap<string, string>;
  /** The aggregator's hashtag changes the board recorded in the last hour. */
  lastHour: number;
}

export type HashtagCheck =
  | { send: true }
  /** Nothing to send: `skip` when the topic already is that way, else refused. */
  | { send: false; skip: boolean; reason: string };

export const HASHTAG_REASON = {
  name: (name: string) => `#${name} 不是 hashtag 的名稱：只能是文字、數字與底線，1 到 32 個字。`,
  topic: (topic: string) => `議題 ${topic} 不在看板上。`,
  mayTag: "captain 在頁面上關掉了 aggregator 貼撕 hashtag。",
  locked: (name: string) => `#${name} 鎖上了，只有 captain 能在頁面上貼撕。`,
  hourly: (made: number, cap: number) => `一小時內已經改了 ${made} 次，上限是 ${cap} 次。`,
  already: (name: string) => `議題已經有 #${name}。`,
  absent: (name: string) => `議題沒有 #${name}。`,
  perTopic: (cap: number) => `議題已經有 ${cap} 個 hashtag，到上限了。`,
  mayCreate: (name: string) =>
    `#${name} 還不存在，captain 在頁面上關掉了 aggregator 開新的 hashtag。`,
  boardMax: (cap: number) => `看板已經有 ${cap} 個 hashtag，到上限了。`,
} as const;

/**
 * The hashtags on `topic`, counting those left on ids merged into it: each
 * key to the spelling the topic carries it in.
 */
function onTopic(
  hashtags: HashtagsFile,
  merged: ReadonlyMap<string, string>,
  topic: string,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const [id, carried] of hashtags.topics) {
    if (followMerges(merged, id) !== topic) continue;
    for (const name of carried) {
      const key = hashtags.keys.get(name) ?? hashtagKey(name);
      if (!names.has(key)) names.set(key, name);
    }
  }
  return names;
}

function topicKeys(situation: HashtagSituation): Set<string> {
  return new Set(onTopic(situation.hashtags, situation.merged, situation.topic).keys());
}

function refuse(reason: string, skip = false): HashtagCheck {
  return { send: false, skip, reason };
}

function checkAdd(name: string, key: string, situation: HashtagSituation): HashtagCheck {
  const { settings } = situation.hashtags;
  const on = topicKeys(situation);
  if (on.has(key)) return refuse(HASHTAG_REASON.already(name), true);
  if (on.size >= settings.per_topic_max)
    return refuse(HASHTAG_REASON.perTopic(settings.per_topic_max));
  const known = new Set(situation.hashtags.keys.values());
  if (known.has(key)) return { send: true };
  if (!settings.aggregator_may_create) return refuse(HASHTAG_REASON.mayCreate(name));
  if (known.size >= settings.board_max) return refuse(HASHTAG_REASON.boardMax(settings.board_max));
  return { send: true };
}

/** Whether the change may go to the board, as a pure function of what the board files say. */
export function checkHashtag(
  change: HashtagChange,
  raw: string,
  situation: HashtagSituation,
): HashtagCheck {
  const name = raw.replace(/^#/, "");
  if (!NAME.test(name)) return refuse(HASHTAG_REASON.name(name));
  if (!situation.live) return refuse(HASHTAG_REASON.topic(situation.topic));
  const { settings } = situation.hashtags;
  if (!settings.aggregator_may_tag) return refuse(HASHTAG_REASON.mayTag);
  const key = hashtagKey(name);
  if (situation.hashtags.locked.has(key)) return refuse(HASHTAG_REASON.locked(name));
  if (situation.lastHour >= settings.aggregator_hourly_max) {
    return refuse(HASHTAG_REASON.hourly(situation.lastHour, settings.aggregator_hourly_max));
  }
  if (change === "add") return checkAdd(name, key, situation);
  return topicKeys(situation).has(key) ? { send: true } : refuse(HASHTAG_REASON.absent(name), true);
}

type EventRecord = Record<string, unknown>;

/** The lines of data/myshape/events.jsonl in `home` that are JSON objects; none when it is missing. */
function hashtagRecords(home: string): EventRecord[] {
  let text: string;
  try {
    text = readFileSync(join(home, "data", "myshape", "events.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: EventRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("hashtag.")) continue;
    try {
      const record = JSON.parse(line) as unknown;
      if (typeof record === "object" && record !== null) records.push(record as EventRecord);
    } catch {
      continue;
    }
  }
  return records;
}

/** Whether a record is a hashtag change the aggregator made on a topic. */
function isAggregatorChange(record: EventRecord): boolean {
  return record["by"] === "aggregator" && WATCHED.has(String(record["kind"]));
}

/**
 * How many `hashtag.added` and `hashtag.removed` records by the aggregator
 * data/myshape/events.jsonl holds from the hour before `nowSeconds`, as the
 * board counts its hourly cap; a missing file holds none, a line that is not
 * JSON is skipped.
 */
export function hashtagChangesInLastHour(home: string, nowSeconds: number): number {
  const since = nowSeconds - HOUR_SECONDS;
  return hashtagRecords(home).filter(
    (record) =>
      typeof record["ts"] === "number" && record["ts"] > since && isAggregatorChange(record),
  ).length;
}

/**
 * The `by` the board writes on a change made on its page (myshape/src/ops.ts:
 * `request.fromPage ? "captain" : "aggregator"`); a revert is made only there.
 */
export const PAGE_BY = "captain";

/** The aggregator change `record` takes back on the page, or undefined when it is no such revert. */
function pageRevertOf(
  record: EventRecord,
  changes: ReadonlyMap<unknown, EventRecord>,
): EventRecord | undefined {
  if (record["kind"] !== "hashtag.reverted" || record["by"] !== PAGE_BY) return undefined;
  return typeof record["ref"] === "string" ? changes.get(record["ref"]) : undefined;
}

/** One change of one hashtag on one topic, as a set of them holds it. */
export function changeKey(topic: string, key: string, change: HashtagChange): string {
  return `${topic}\t${key}\t${change}`;
}

function words(value: unknown): string[] {
  return typeof value === "string" ? value.split(" ").filter((name) => name !== "") : [];
}

/** What one aggregator change did: the names it put on and those it took off. */
function changesOf(record: EventRecord): { change: HashtagChange; name: string }[] {
  const before = words(record["before"]);
  const after = words(record["after"]);
  return [
    ...after.filter((name) => !before.includes(name)).map((name) => ({ change: "add", name })),
    ...before.filter((name) => !after.includes(name)).map((name) => ({ change: "remove", name })),
  ] as { change: HashtagChange; name: string }[];
}

/**
 * The aggregator's hashtag changes the captain took back on the page, as
 * changeKey sets them out: the topic (merges followed), the hashtag's key and
 * the kind of change, read from the `hashtag.reverted` records whose `by` is
 * the page's and the aggregator's record each one's `ref` names. A revert
 * from anywhere else does not count; a missing file holds none, a line that
 * is not JSON is skipped.
 */
export function revertedChanges(
  home: string,
  merged: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  const records = hashtagRecords(home);
  const changes = new Map<unknown, EventRecord>();
  for (const record of records) {
    if (isAggregatorChange(record) && typeof record["topic"] === "string") {
      changes.set(record["rid"], record);
    }
  }
  const reverted = new Set<string>();
  for (const record of records) {
    const taken = pageRevertOf(record, changes);
    if (taken === undefined) continue;
    const topic = followMerges(merged, String(taken["topic"]));
    for (const { change, name } of changesOf(taken)) {
      reverted.add(changeKey(topic, hashtagKey(name), change));
    }
  }
  return reverted;
}

export type HashtagOutcome = { sent: true } | { sent: false; reason: string };

/** The guarded hashtag operation for one board home. */
export class Tagger {
  constructor(
    private readonly home: string,
    private readonly board: BoardCommand,
    private readonly nowMs: () => number,
  ) {}

  /**
   * Puts `name` on `topic` (`add`) or takes it off (`remove`), when every
   * guard allows it. `opening` says a name put on is meant as a new hashtag:
   * the board opens a name it does not have only when told so.
   */
  async change(
    topic: string,
    change: HashtagChange,
    name: string,
    opening = false,
  ): Promise<HashtagOutcome> {
    const board = readBoard(this.home);
    const current = followMerges(board.topics.merged, topic);
    const check = checkHashtag(change, name, {
      hashtags: board.hashtags,
      topic: current,
      live: board.topics.topics.has(current),
      merged: board.topics.merged,
      lastHour: hashtagChangesInLastHour(this.home, Math.floor(this.nowMs() / 1000)),
    });
    if (!check.send) return { sent: false, reason: check.reason };
    const problem = await this.board.hashtag(current, change, name.replace(/^#/, ""), opening);
    return problem === undefined ? { sent: true } : { sent: false, reason: problem };
  }
}

// --- what the planner is shown, and what it may ask for ---------------------

/**
 * What a line shown to a model or written to a log may not carry as it is:
 * controls (C0, DEL and C1, so newlines too), the line and paragraph
 * separators, and the marks and controls that change the text's direction.
 * The board keeps the controls and the bidi embeddings and isolates out of
 * one-line fields; this also takes the marks and the separators.
 */
const UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** The most code points of an example topic name the planner is shown. */
export const EXAMPLE_MAX = 40;
/** The most hashtags the planner is shown; the rest are only counted. */
export const LIST_MAX = 200;
const EXAMPLES_PER_HASHTAG = 3;

/** `name` as one plain line of at most EXAMPLE_MAX code points, with `…` when it was cut. */
export function exampleName(name: string): string {
  const points = [...name.replace(UNSAFE, " ")];
  if (points.length <= EXAMPLE_MAX) return points.join("");
  return `${points.slice(0, EXAMPLE_MAX).join("")}…`;
}

/** `text` as a JSON string with every UNSAFE character written as `\uXXXX`, for a log line. */
export function quoted(text: string): string {
  return JSON.stringify(text).replace(
    UNSAFE,
    (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
}

export interface ListedHashtag {
  name: string;
  /** How many topics carry it, live or archived, merges followed. */
  topics: number;
  /** The names of up to three live topics that carry it, as exampleName makes them. */
  examples: string[];
  locked: boolean;
}

/** The board's hashtags and the captain's settings, as the planner is shown them. */
export interface HashtagList {
  hashtags: ListedHashtag[];
  /** How many more the board has than are listed. */
  unlisted: number;
  may_tag: boolean;
  may_create: boolean;
  per_topic_max: number;
}

/** The topics (merges followed) on the board or archived that carry `name`, by id. */
function carriers(board: Pick<Board, "topics" | "archived" | "hashtags">, name: string): string[] {
  const ids = new Set<string>();
  for (const [id, names] of board.hashtags.topics) {
    if (!names.includes(name)) continue;
    const topic = followMerges(board.topics.merged, id);
    if (board.topics.topics.has(topic) || board.archived.has(topic)) ids.add(topic);
  }
  return [...ids].toSorted();
}

/**
 * The board's hashtags as `myshape.sh hashtags` lists them: most-used first,
 * then by key, at most LIST_MAX. Examples are taken only from topics still on
 * the board (in a queue or 待辦), never archived ones.
 */
export function hashtagList(board: Pick<Board, "topics" | "archived" | "hashtags">): HashtagList {
  const { keys, locked, settings } = board.hashtags;
  const rows = [...keys].map(([name, key]) => {
    const ids = carriers(board, name);
    const live = ids.filter((id) => board.topics.topics.has(id)).slice(0, EXAMPLES_PER_HASHTAG);
    const examples = live.map((id) => exampleName(board.topics.topics.get(id)?.name ?? ""));
    return { key, row: { name, topics: ids.length, examples, locked: locked.has(key) } };
  });
  rows.sort((a, b) => b.row.topics - a.row.topics || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    hashtags: rows.slice(0, LIST_MAX).map((entry) => entry.row),
    unlisted: Math.max(0, rows.length - LIST_MAX),
    may_tag: settings.aggregator_may_tag,
    may_create: settings.aggregator_may_create,
    per_topic_max: settings.per_topic_max,
  };
}

/**
 * The model's name as a hashtag name: trimmed, one leading `#` dropped,
 * NFKC; when that is not a name, each run of spaces, `-`, `.` or `/` becomes
 * one `_` and `_` at either end is dropped. Undefined when it still is not one.
 */
export function normalizeName(raw: string): string | undefined {
  const name = raw.trim().replace(/^#/, "").normalize("NFKC");
  if (NAME.test(name)) return name;
  const joined = name.replace(/[\s\-./]+/gu, "_").replace(/^_+|_+$/gu, "");
  return NAME.test(joined) ? joined : undefined;
}

/** One change to send: the spelling the board gets, and whether it is meant as new. */
export interface HashtagSend {
  change: HashtagChange;
  name: string;
  /** Put on as a new hashtag (`--new`). */
  opening: boolean;
}

/** The changes to send, in the planner's order, and why each other one was dropped. */
export interface Picked {
  send: HashtagSend[];
  /** One line each, every name in it written by `quoted`. */
  dropped: string[];
}

export interface PickSituation {
  hashtags: HashtagsFile;
  /** The topic the supervisor plans, merges followed. */
  topic: string;
  merged: ReadonlyMap<string, string>;
  /** The changes the captain reverted, as changeKey sets them out. */
  reverted: ReadonlySet<string>;
}

export const PICK_REASON = {
  name: (raw: string) => `${quoted(raw)} is not a hashtag name, even normalized`,
  unlisted: (raw: string) =>
    `${quoted(raw)} was asked as listed but matches no hashtag on the board; nothing new is opened for it`,
  twoMatches: (raw: string, names: readonly string[]) =>
    `${quoted(raw)} matches ${names.map(quoted).join(" and ")} once underscores are dropped`,
  locked: (name: string) => `${quoted(name)} is locked`,
  notOnTopic: (raw: string) => `${quoted(raw)} is not on the topic`,
  both: (name: string) => `${quoted(name)} was asked to be put on and taken off in one plan`,
  reverted: (change: HashtagChange, name: string) =>
    `the captain reverted ${change === "add" ? "putting on" : "taking off"} ${quoted(name)} on this topic`,
} as const;

/** A change resolved to the board's spelling, with its key, or why it was dropped. */
type Resolved = (HashtagSend & { key: string }) | { dropped: string };

/** The board's hashtag `name` (normalized) matches: its key, else its key without underscores. */
function listedMatch(hashtags: HashtagsFile, name: string): string[] {
  const key = hashtagKey(name);
  for (const [listed, listedKey] of hashtags.keys) if (listedKey === key) return [listed];
  const loose = key.replaceAll("_", "");
  return [...hashtags.keys]
    .filter(([, listedKey]) => listedKey.replaceAll("_", "") === loose)
    .map(([listed]) => listed);
}

function resolvePutOn(ask: HashtagAsk, name: string, situation: PickSituation): Resolved {
  const matches = listedMatch(situation.hashtags, name);
  if (matches.length > 1) return { dropped: PICK_REASON.twoMatches(ask.name, matches) };
  const [listed] = matches;
  if (listed === undefined) {
    if (ask.change === "listed") return { dropped: PICK_REASON.unlisted(ask.name) };
    return { change: "add", name, opening: true, key: hashtagKey(name) };
  }
  const key = situation.hashtags.keys.get(listed) ?? hashtagKey(listed);
  if (situation.hashtags.locked.has(key)) return { dropped: PICK_REASON.locked(listed) };
  return { change: "add", name: listed, opening: false, key };
}

function resolveTakeOff(ask: HashtagAsk, name: string, situation: PickSituation): Resolved {
  const key = hashtagKey(name);
  const carried = onTopic(situation.hashtags, situation.merged, situation.topic).get(key);
  if (carried === undefined) return { dropped: PICK_REASON.notOnTopic(ask.name) };
  if (situation.hashtags.locked.has(key)) return { dropped: PICK_REASON.locked(carried) };
  return { change: "remove", name: carried, opening: false, key };
}

function resolve(ask: HashtagAsk, situation: PickSituation): Resolved {
  const name = normalizeName(ask.name);
  if (name === undefined) return { dropped: PICK_REASON.name(ask.name) };
  return ask.change === "remove"
    ? resolveTakeOff(ask, name, situation)
    : resolvePutOn(ask, name, situation);
}

/**
 * The planner's asks for the topic `situation.topic` as changes to send. A
 * put-on matches the board's list by key, then by key without underscores
 * (exactly one); `listed` that matches nothing is dropped, never opened, and
 * `new` that matches one uses it. A take-off matches only the topic's own
 * hashtags by key and sends the topic's spelling. Locked ones are dropped,
 * both changes of a key asked for both ways are dropped, and so is a change
 * the captain reverted.
 */
export function pickHashtags(asks: readonly HashtagAsk[], situation: PickSituation): Picked {
  const resolved = asks.map((ask) => resolve(ask, situation));
  const both = askedBothWays(resolved);
  const picked: Picked = { send: [], dropped: [] };
  for (const entry of resolved) {
    const final = finalOf(entry, both, situation);
    if ("dropped" in final) picked.dropped.push(final.dropped);
    else picked.send.push(final);
  }
  return picked;
}

/** The keys among `resolved` asked to be put on and taken off both. */
function askedBothWays(resolved: readonly Resolved[]): Set<string> {
  const ways = new Map<string, Set<HashtagChange>>();
  for (const entry of resolved) {
    if ("dropped" in entry) continue;
    ways.set(entry.key, (ways.get(entry.key) ?? new Set()).add(entry.change));
  }
  return new Set([...ways].filter(([, changes]) => changes.size > 1).map(([key]) => key));
}

/** The change to send, or why it is dropped after all: asked both ways, or reverted. */
function finalOf(
  entry: Resolved,
  both: ReadonlySet<string>,
  situation: PickSituation,
): HashtagSend | { dropped: string } {
  if ("dropped" in entry) return entry;
  if (both.has(entry.key)) return { dropped: PICK_REASON.both(entry.name) };
  if (situation.reverted.has(changeKey(situation.topic, entry.key, entry.change)))
    return { dropped: PICK_REASON.reverted(entry.change, entry.name) };
  return { change: entry.change, name: entry.name, opening: entry.opening };
}
