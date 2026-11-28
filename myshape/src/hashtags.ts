// The hashtags the board keeps on topics, in data/myshape/hashtags.json: the
// registry of hashtags, which topics carry which, the captain's saved views,
// and the captain's settings for what the aggregator may do. Hashtags describe
// a topic's content only; nothing here moves a topic, changes the dispatch
// order, or sends anything. Pure: no I/O, no clock.
import { isRecord } from "./files.js";
import * as oversight from "./oversight.js";
import type { RecentChange, WatchedRecord } from "./oversight.js";
import type { Draft, Frozen, Records } from "./records.js";
import { isValidTopicId, oneLine, resolveTopicId } from "./topics.js";
import type { TopicState } from "./topics.js";

export const NAME_MAX = 32;
export const VIEW_NAME_MAX = 40;
export const VIEW_TEXT_MAX = 80;
/** The built-in view that shows every topic; no saved view may take its id. */
export const ALL_VIEW = "all";
export const COLORS = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"] as const;
export type Color = (typeof COLORS)[number];
/**
 * How the page lists the cards in a queue: in the queue's own order, or by
 * when each topic was created. Only what is shown; the queue never changes.
 */
export const CARD_ORDERS = ["priority", "newest", "oldest"] as const;
export type CardOrder = (typeof CARD_ORDERS)[number];

export function isCardOrder(value: unknown): value is CardOrder {
  return CARD_ORDERS.some((order) => order === value);
}

/**
 * One hashtag. The registry is keyed by the spelling first created, which is
 * the one shown; `key` (NFKC, then lower case) decides which spellings are the
 * same hashtag, so a reader without NFKC can still match it.
 */
export interface HashtagEntry {
  key: string;
  created_at: string;
  created_by: "captain" | "aggregator";
  color: Color;
  /** A locked hashtag is put on and taken off by the captain only. */
  locked: boolean;
}

/** A filter the captain saved: topics with any of `any`, none of `none`, and `text` in them. */
export interface SavedView {
  name: string;
  any: string[];
  none: string[];
  text: string;
  /** Only topics with no hashtag. */
  untagged: boolean;
  /** How the page lists the queues' cards while this view is chosen. */
  order: CardOrder;
}

export interface HashtagSettings {
  aggregator_may_tag: boolean;
  aggregator_may_create: boolean;
  /** The aggregator opens a new hashtag only when it says the name is new. */
  aggregator_must_mark_new: boolean;
  per_topic_max: number;
  board_max: number;
  aggregator_hourly_max: number;
  /** The view the page opens with: a saved view's id, or ALL_VIEW. */
  default_view: string;
}

export interface HashtagStore {
  v: 1;
  hashtags: Record<string, HashtagEntry>;
  /** Topic id to the hashtags it carries, in the order they were put on. */
  topics: Record<string, string[]>;
  views: Record<string, SavedView>;
  settings: HashtagSettings;
}

export const DEFAULT_SETTINGS: Readonly<HashtagSettings> = {
  aggregator_may_tag: true,
  aggregator_may_create: true,
  aggregator_must_mark_new: true,
  per_topic_max: 8,
  board_max: 50,
  aggregator_hourly_max: 20,
  default_view: ALL_VIEW,
};

type NumberSetting = "per_topic_max" | "board_max" | "aggregator_hourly_max";
export const SETTING_RANGES: Readonly<Record<NumberSetting, readonly [number, number]>> = {
  per_topic_max: [1, 32],
  board_max: [1, 500],
  aggregator_hourly_max: [0, 1000],
};
const NUMBER_SETTINGS = Object.keys(SETTING_RANGES) as NumberSetting[];
const FLAG_SETTINGS = [
  "aggregator_may_tag",
  "aggregator_may_create",
  "aggregator_must_mark_new",
] as const;

/** The aggregator's changes the hourly cap counts and the captain may take back. */
export const WATCHED: oversight.Watched = {
  changes: new Set(["hashtag.added", "hashtag.removed"]),
  reverted: "hashtag.reverted",
  seen: "hashtag.seen",
};

export function emptyHashtags(): HashtagStore {
  return { v: 1, hashtags: {}, topics: {}, views: {}, settings: { ...DEFAULT_SETTINGS } };
}

// Letters (any script), combining marks, digits and underscore.
const NAME_CHARS = /^[\p{L}\p{M}\p{N}_]+$/u;

/** The identity of a spelling: NFKC, then lower case. */
export function hashtagKey(name: string): string {
  return name.normalize("NFKC").toLowerCase();
}

/** `raw` as a hashtag name and its key, or why it is not one. */
export function checkName(raw: string): { name: string; key: string } | string {
  const name = raw.trim().replace(/^#/, "");
  const key = hashtagKey(name);
  const length = [...name].length;
  if (length === 0 || length > NAME_MAX || !NAME_CHARS.test(name) || !NAME_CHARS.test(key))
    return `hashtag 只能用文字、數字與底線，1 到 ${NAME_MAX} 個字：${raw}`;
  // A name every object already has (constructor, __proto__) could not be stored as a key.
  if (name in Object.prototype || key in Object.prototype)
    return `hashtag 不能叫 ${name}：這個名字是程式物件本來就有的屬性。`;
  return { name, key };
}

/** The shown spelling of the hashtag whose key is `key`, if the board has it. */
export function nameOfKey(store: Frozen<HashtagStore>, key: string): string | undefined {
  return Object.entries(store.hashtags).find(([, entry]) => entry.key === key)?.[0];
}

/** The hashtags on topic `id` in a topic map; none when it has none. */
function tagsIn(
  topics: Readonly<Record<string, readonly string[]>>,
  id: string,
): readonly string[] {
  const names = topics[id];
  return names === undefined ? [] : names;
}

/** The ids of every topic that carries `name`, sorted. */
export function topicsWith(store: Frozen<HashtagStore>, name: string): string[] {
  return Object.entries(store.topics)
    .filter(([, names]) => names.includes(name))
    .map(([id]) => id)
    .toSorted();
}

// ---- spellings close to a name ----

/** At most this many close hashtags are named in a reply. */
export const NEAR_MAX = 5;
/** At most this many of the most used hashtags are named in a refusal. */
export const MOST_USED_MAX = 20;

/** A hashtag named in a reply: its spelling, how many topics carry it, and its lock. */
export interface ListedHashtag {
  name: string;
  topics: number;
  locked: boolean;
}

/** `key` without its underscores, as code points. */
function bare(key: string): string[] {
  return [...key.replaceAll("_", "")];
}

/**
 * The edit distance of two code-point lists, counting a swap of two
 * neighbours as one edit (Damerau-Levenshtein, optimal string alignment).
 */
export function editDistance(a: readonly string[], b: readonly string[]): number {
  let before: number[] = [];
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min((row[j] as number) + 1, (next[j - 1] as number) + 1);
      best = Math.min(best, (row[j - 1] as number) + cost);
      const swapped = i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1];
      if (swapped) best = Math.min(best, (before[j - 2] as number) + 1);
      next.push(best);
    }
    before = row;
    row = next;
  }
  return row[b.length] as number;
}

/**
 * How close two keys are once their underscores are dropped: 0 when they are
 * the same, 1 when one holds the other and the shorter has at least 2 code
 * points, 2 when they are within 1 edit (the shorter has at most 5 code
 * points) or 2 edits (longer); null when none of these.
 */
export function nearTier(one: string, two: string): 0 | 1 | 2 | null {
  const a = bare(one);
  const b = bare(two);
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.join("") === long.join("")) return 0;
  if (short.length >= 2 && long.join("").includes(short.join(""))) return 1;
  if (short.length === 0) return null;
  return editDistance(a, b) <= (short.length <= 5 ? 1 : 2) ? 2 : null;
}

function byKey(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function listed(store: Frozen<HashtagStore>, name: string): ListedHashtag {
  const entry = store.hashtags[name] as Frozen<HashtagEntry>;
  return { name, topics: topicsWith(store, name).length, locked: entry.locked };
}

/**
 * The board's hashtags whose key is close to `key` (nearTier), at most
 * NEAR_MAX: the closest tier first, within a tier the most used first, then
 * by key. The hashtag whose key is `key` itself is never one of them. Only an
 * order to show; it decides nothing.
 */
export function nearHashtags(store: Frozen<HashtagStore>, key: string): ListedHashtag[] {
  const found: { tier: number; key: string; hashtag: ListedHashtag }[] = [];
  for (const [name, entry] of Object.entries(store.hashtags)) {
    const tier = entry.key === key ? null : nearTier(key, entry.key);
    if (tier !== null) found.push({ tier, key: entry.key, hashtag: listed(store, name) });
  }
  return found
    .toSorted(
      (a, b) => a.tier - b.tier || b.hashtag.topics - a.hashtag.topics || byKey(a.key, b.key),
    )
    .slice(0, NEAR_MAX)
    .map((entry) => entry.hashtag);
}

/** The hashtags on at least one topic, the most used first, then by key; at most `max`. */
export function mostUsedHashtags(store: Frozen<HashtagStore>, max: number): ListedHashtag[] {
  return Object.entries(store.hashtags)
    .map(([name, entry]) => ({ key: entry.key, hashtag: listed(store, name) }))
    .filter((entry) => entry.hashtag.topics > 0)
    .toSorted((a, b) => b.hashtag.topics - a.hashtag.topics || byKey(a.key, b.key))
    .slice(0, max)
    .map((entry) => entry.hashtag);
}

// ---- reading the file ----

function parseEntry(raw: unknown, key: string): HashtagEntry {
  const value = isRecord(raw) ? raw : {};
  const color = COLORS.find((name) => name === value["color"]) ?? "c1";
  return {
    key,
    created_at: typeof value["created_at"] === "string" ? value["created_at"] : "",
    created_by: value["created_by"] === "aggregator" ? "aggregator" : "captain",
    color,
    locked: value["locked"] === true,
  };
}

/** The registry, one entry per key: the earliest created spelling wins. */
function parseRegistry(raw: unknown): Record<string, HashtagEntry> {
  const found = new Map<string, [string, HashtagEntry]>();
  const entries = isRecord(raw) ? Object.entries(raw) : [];
  for (const [name, value] of entries) {
    const checked = checkName(name);
    if (typeof checked === "string" || checked.name !== name) continue;
    const entry = parseEntry(value, checked.key);
    const earlier = found.get(checked.key);
    if (earlier === undefined || entry.created_at < earlier[1].created_at)
      found.set(checked.key, [name, entry]);
  }
  return Object.fromEntries(found.values());
}

/** `names` as shown spellings the registry has, each once. */
function knownNames(registry: Record<string, HashtagEntry>, names: unknown): string[] {
  if (!Array.isArray(names)) return [];
  const keyed = new Map(Object.entries(registry).map(([name, entry]) => [entry.key, name]));
  const shown = names.flatMap((name: unknown) => {
    if (typeof name !== "string") return [];
    const known = keyed.get(hashtagKey(name));
    return known === undefined ? [] : [known];
  });
  return [...new Set(shown)];
}

function parseView(registry: Record<string, HashtagEntry>, raw: unknown): SavedView | null {
  if (!isRecord(raw)) return null;
  const name = oneLine(typeof raw["name"] === "string" ? raw["name"] : "", VIEW_NAME_MAX);
  if (name === null) return null;
  const text = oneLine(typeof raw["text"] === "string" ? raw["text"] : "", VIEW_TEXT_MAX);
  return {
    name,
    any: knownNames(registry, raw["any"]),
    none: knownNames(registry, raw["none"]),
    text: text ?? "",
    untagged: raw["untagged"] === true,
    order: isCardOrder(raw["order"]) ? raw["order"] : "priority",
  };
}

function inRange(value: unknown, [low, high]: readonly [number, number]): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;
}

function parseSettings(raw: unknown, views: Record<string, SavedView>): HashtagSettings {
  const value = isRecord(raw) ? raw : {};
  const settings: HashtagSettings = { ...DEFAULT_SETTINGS };
  for (const name of FLAG_SETTINGS) {
    if (typeof value[name] === "boolean") settings[name] = value[name];
  }
  for (const name of NUMBER_SETTINGS) {
    if (inRange(value[name], SETTING_RANGES[name])) settings[name] = value[name];
  }
  const view = value["default_view"];
  if (typeof view === "string" && Object.hasOwn(views, view)) settings.default_view = view;
  return settings;
}

function entriesOf(raw: unknown): [string, unknown][] {
  return isRecord(raw) ? Object.entries(raw) : [];
}

function parseTopics(
  registry: Record<string, HashtagEntry>,
  raw: unknown,
): Record<string, string[]> {
  const topics: Record<string, string[]> = {};
  for (const [id, names] of entriesOf(raw)) {
    const shown = knownNames(registry, names);
    if (isValidTopicId(id) && shown.length > 0) topics[id] = shown;
  }
  return topics;
}

function parseViews(
  registry: Record<string, HashtagEntry>,
  raw: unknown,
): Record<string, SavedView> {
  const views: Record<string, SavedView> = {};
  for (const [id, value] of entriesOf(raw)) {
    const view = parseView(registry, value);
    if (view !== null && isValidTopicId(id) && id !== ALL_VIEW) views[id] = view;
  }
  return views;
}

/** Reads hashtags.json; throws when it is not an object with v: 1. */
export function parseHashtags(raw: unknown): HashtagStore {
  if (!isRecord(raw) || raw["v"] !== 1) throw new Error("expected an object with v: 1");
  const registry = parseRegistry(raw["hashtags"]);
  const views = parseViews(registry, raw["views"]);
  return {
    v: 1,
    hashtags: registry,
    topics: parseTopics(registry, raw["topics"]),
    views,
    settings: parseSettings(raw["settings"], views),
  };
}

/**
 * The store as it applies to the topics now: hashtags of a topic merged away
 * (by any board, older ones included) belong to the topic it went into, and
 * hashtags of a topic the board no longer has are dropped, so no hashtag is
 * ever on a missing topic.
 */
export function reconcile(store: HashtagStore, topics: Frozen<TopicState>): HashtagStore {
  const next: Record<string, string[]> = {};
  // A topic's own hashtags first, then those of topics merged into it.
  const own = (id: string): number => (resolveTopicId(topics.doc, id) === id ? 0 : 1);
  const entries = Object.entries(store.topics).toSorted(([a], [b]) => own(a) - own(b));
  for (const [id, names] of entries) {
    const owner = resolveTopicId(topics.doc, id);
    const known =
      topics.doc.topics[owner] !== undefined || topics.archive.topics[owner] !== undefined;
    if (known) next[owner] = [...new Set([...tagsIn(next, owner), ...names])];
  }
  return { ...store, topics: next };
}

// ---- changes ----

/** A saved record as the rails and a revert read it. */
export type HashtagRecord = WatchedRecord & {
  topic?: string | null;
  before?: string;
  after?: string;
};

/** Who asks for a change, and what the rails read: the board's saved records, oldest first. */
export interface HashtagContext {
  store: Frozen<HashtagStore>;
  topics: Frozen<TopicState>;
  by: "captain" | "aggregator";
  records: readonly HashtagRecord[];
  now: string;
}

export type HashtagResult =
  | { ok: true; changed: true; store: HashtagStore; line: string; records: Records }
  | { ok: true; changed: false; store: Frozen<HashtagStore>; line: string }
  | { ok: false; code: "refused" | "usage"; line: string };

function refuse(line: string): HashtagResult {
  return { ok: false, code: "refused", line };
}

function unchanged(store: Frozen<HashtagStore>, line: string): HashtagResult {
  return { ok: true, changed: false, store, line };
}

function changed(store: HashtagStore, line: string, record: Draft): HashtagResult {
  return { ok: true, changed: true, store, line, records: [record] };
}

function clone(store: Frozen<HashtagStore>): HashtagStore {
  return structuredClone(store) as HashtagStore;
}

function tags(names: readonly string[]): string {
  return names.map((name) => `#${name}`).join("、");
}

/** A live topic for `rawId`, or why there is none. */
function liveTopic(
  topics: Frozen<TopicState>,
  rawId: string,
): { id: string; name: string } | string {
  const id = resolveTopicId(topics.doc, rawId);
  const topic = topics.doc.topics[id];
  if (topic !== undefined) return { id, name: topic.name };
  if (topics.archive.topics[id] !== undefined) return `議題 ${id} 已封存，要先 reopen。`;
  return `沒有 ${rawId} 這個議題。用 list --all 看有哪些。`;
}

function nowSeconds(ctx: HashtagContext): number {
  return Math.floor(Date.parse(ctx.now) / 1000);
}

/** Why the aggregator may not make this change at all, or null. */
function aggregatorProblem(ctx: HashtagContext, locked: readonly string[]): string | null {
  if (ctx.by !== "aggregator") return null;
  if (!ctx.store.settings.aggregator_may_tag)
    return "使用者在頁面上關掉了 aggregator 貼撕 hashtag，這次沒有改。";
  if (locked.length > 0) return `${tags(locked)} 鎖上了，只有使用者能在頁面上貼撕，這次沒有改。`;
  return oversight.capProblem(
    ctx.records,
    WATCHED,
    nowSeconds(ctx),
    ctx.store.settings.aggregator_hourly_max,
  );
}

/** Why the aggregator may not open `fresh`, new hashtags, or null. */
function creationProblem(ctx: HashtagContext, fresh: readonly string[]): string | null {
  if (ctx.by !== "aggregator" || fresh.length === 0) return null;
  const { settings } = ctx.store;
  if (!settings.aggregator_may_create)
    return `使用者在頁面上關掉了 aggregator 開新的 hashtag；${tags(fresh)} 還不存在，這次沒有改。`;
  const count = Object.keys(ctx.store.hashtags).length;
  if (count + fresh.length > settings.board_max)
    return `看板最多 ${settings.board_max} 個 hashtag，已經有 ${count} 個；${tags(fresh)} 開不了，這次沒有改。使用者可以在頁面上開，或調高上限。`;
  return null;
}

/**
 * Which of the names asked for the asker said are new (the socket's `new`
 * and a create's `new_hashtags`), and which command it asked with, so a
 * refusal can say how to ask again.
 */
export interface Opening {
  names: readonly string[];
  via: "hashtag" | "create";
}

const SAID_NOTHING_NEW: Opening = { names: [], via: "hashtag" };

/** `#NAME（N 個議題）`, with the lock when it has one. */
function listedText(entry: ListedHashtag): string {
  const lock = entry.locked ? "；鎖上：只有使用者能貼" : "";
  return `#${entry.name}（${entry.topics} 個議題${lock}）`;
}

/** The close hashtags of every name in `fresh`, each once, at most NEAR_MAX. */
function nearAll(store: Frozen<HashtagStore>, fresh: readonly string[]): ListedHashtag[] {
  const found = new Map<string, ListedHashtag>();
  for (const name of fresh)
    for (const entry of nearHashtags(store, hashtagKey(name))) found.set(entry.name, entry);
  return [...found.values()].slice(0, NEAR_MAX);
}

/** What the board has, for a refusal: the close ones, then the most used, then how many. */
function boardList(store: Frozen<HashtagStore>, fresh: readonly string[]): string {
  const count = Object.keys(store.hashtags).length;
  const near = nearAll(store, fresh);
  const shown = new Set(near.map((entry) => entry.name));
  const used = mostUsedHashtags(store, MOST_USED_MAX + shown.size)
    .filter((entry) => !shown.has(entry.name))
    .slice(0, MOST_USED_MAX);
  const parts = [
    near.length === 0 ? null : `看板上相近的：${near.map(listedText).join("、")}`,
    used.length === 0 ? null : `常用的：${used.map(listedText).join("、")}`,
    `共 ${count} 個，全部用 myshape.sh hashtags 看。`,
  ];
  return parts.filter((part) => part !== null).join("；");
}

function againText(opening: Opening, topic: { id: string }, fresh: readonly string[]): string {
  if (opening.via === "create")
    return `把這些名稱從 --hashtag 改成 --new-hashtag 再跑一次：${fresh.map((name) => `--new-hashtag ${name}`).join(" ")}`;
  return `加 --new 再跑一次：myshape.sh hashtag ${topic.id} +${fresh[0] as string} --new`;
}

/** Why the aggregator may not open `fresh` without saying they are new, or null. */
function unmarkedProblem(
  ctx: HashtagContext,
  topic: { id: string },
  fresh: readonly string[],
  opening: Opening,
): string | null {
  if (ctx.by !== "aggregator" || !ctx.store.settings.aggregator_must_mark_new) return null;
  const said = new Set(opening.names.map(hashtagKey));
  const unmarked = fresh.filter((name) => !said.has(hashtagKey(name)));
  if (unmarked.length === 0) return null;
  const head = `${tags(unmarked)} 是看板還沒有的 hashtag，這次沒有改。`;
  const again = againText(opening, topic, unmarked);
  if (Object.keys(ctx.store.hashtags).length === 0)
    return `${head}看板上還沒有任何 hashtag；確定要開新的，${again}`;
  return `${head}${boardList(ctx.store, unmarked)}意思相同就改貼那一個；只有確定意思不同、要開新的，才${again}`;
}

/** The names asked for, as the spellings to put on: known ones as shown, new ones as given. */
function wanted(
  store: Frozen<HashtagStore>,
  raw: readonly string[],
): { names: string[]; fresh: string[] } | string {
  const names: string[] = [];
  const fresh: string[] = [];
  for (const entry of raw) {
    const checked = checkName(entry);
    if (typeof checked === "string") return checked;
    const shown =
      nameOfKey(store, checked.key) ?? fresh.find((name) => hashtagKey(name) === checked.key);
    if (shown === undefined) fresh.push(checked.name);
    if (!names.includes(shown ?? checked.name)) names.push(shown ?? checked.name);
  }
  return { names, fresh };
}

function newEntry(ctx: HashtagContext, key: string, index: number): HashtagEntry {
  return {
    key,
    created_at: ctx.now,
    created_by: ctx.by,
    color: COLORS[index % COLORS.length] as Color,
    locked: false,
  };
}

function overMax(ctx: HashtagContext, topic: { id: string; name: string }, count: number): string {
  const max = ctx.store.settings.per_topic_max;
  return `議題「${topic.name}」（${topic.id}）已經有 ${count} 個 hashtag，上限 ${max} 個；先撕掉一些才能再貼，這次沒有改。`;
}

/** The names among `names` that are locked. */
function lockedOf(store: Frozen<HashtagStore>, names: readonly string[]): string[] {
  return names.filter((name) => store.hashtags[name]?.locked === true);
}

/** What a topic had and what is to go on it, with the names among them the board does not have. */
interface Adding {
  before: readonly string[];
  adding: readonly string[];
  fresh: readonly string[];
}

/** Why `change.adding` may not go on the topic, or null. */
function addProblem(
  ctx: HashtagContext,
  topic: { id: string; name: string },
  change: Adding,
  opening: Opening,
): string | null {
  const problem =
    aggregatorProblem(ctx, lockedOf(ctx.store, change.adding)) ??
    creationProblem(ctx, change.fresh) ??
    unmarkedProblem(ctx, topic, change.fresh, opening);
  if (problem !== null) return problem;
  const count = change.before.length;
  return count + change.adding.length > ctx.store.settings.per_topic_max
    ? overMax(ctx, topic, count)
    : null;
}

/** A copy of the store in which topic `id` carries `names`, and no entry when they are none. */
function withTopicTags(
  store: Frozen<HashtagStore>,
  id: string,
  names: readonly string[],
): HashtagStore {
  const next = clone(store);
  if (names.length === 0) delete next.topics[id];
  else next.topics[id] = [...names];
  return next;
}

/**
 * Puts `raw` hashtags on one topic, opening the ones the board does not have.
 * While aggregator_must_mark_new is on, the aggregator opens only the names
 * `opening` says are new. One record for the whole change, saying what the
 * topic had before and after.
 */
export function addHashtags(
  ctx: HashtagContext,
  rawTopic: string,
  raw: readonly string[],
  opening: Opening = SAID_NOTHING_NEW,
): HashtagResult {
  const topic = liveTopic(ctx.topics, rawTopic);
  if (typeof topic === "string") return refuse(topic);
  const asked = wanted(ctx.store, raw);
  if (typeof asked === "string") return refuse(asked);
  const before = tagsIn(ctx.store.topics, topic.id);
  const adding = asked.names.filter((name) => !before.includes(name));
  if (adding.length === 0)
    return unchanged(ctx.store, `ok ${topic.id} 本來就有 ${tags(asked.names)}`);
  const change = { before, adding, fresh: asked.fresh };
  const problem = addProblem(ctx, topic, change, opening);
  if (problem !== null) return refuse(problem);
  return putOn(ctx, topic, change);
}

/** `（新開的 hashtag：#X）` for the names opened, with the close ones the board had; empty for none. */
function openedText(store: Frozen<HashtagStore>, fresh: readonly string[]): string {
  if (fresh.length === 0) return "";
  const near = nearAll(store, fresh).map((entry) => entry.name);
  const close = near.length === 0 ? "" : `；看板上相近的有 ${tags(near)}`;
  return `（新開的 hashtag：${tags(fresh)}${close}）`;
}

/** The change that puts `adding` on a topic that had `before`, opening `fresh`. */
function putOn(
  ctx: HashtagContext,
  topic: { id: string; name: string },
  change: Adding,
): HashtagResult {
  const { before, adding, fresh } = change;
  const after = [...before, ...adding];
  const next = withTopicTags(ctx.store, topic.id, after);
  for (const name of fresh)
    next.hashtags[name] = newEntry(ctx, hashtagKey(name), Object.keys(next.hashtags).length);
  const opened = fresh.length === 0 ? "" : `（新開的 hashtag：${tags(fresh)}）`;
  const line = `ok ${topic.id} 已貼上 ${tags(adding)}${openedText(ctx.store, fresh)}`;
  return changed(next, line, {
    kind: "hashtag.added",
    topic: topic.id,
    before: before.join(" "),
    after: after.join(" "),
    ...(fresh.length === 0 ? {} : { outcome: "created" }),
    text: `議題「${topic.name}」貼上 ${tags(adding)}${opened}`,
  });
}

/** Takes one hashtag off one topic. */
export function removeHashtag(ctx: HashtagContext, rawTopic: string, raw: string): HashtagResult {
  const topic = liveTopic(ctx.topics, rawTopic);
  if (typeof topic === "string") return refuse(topic);
  const checked = checkName(raw);
  if (typeof checked === "string") return refuse(checked);
  const name = nameOfKey(ctx.store, checked.key);
  const before = tagsIn(ctx.store.topics, topic.id);
  if (name === undefined || !before.includes(name))
    return unchanged(ctx.store, `ok ${topic.id} 本來就沒有 #${checked.name}`);
  const problem = aggregatorProblem(ctx, lockedOf(ctx.store, [name]));
  if (problem !== null) return refuse(problem);
  const after = before.filter((entry) => entry !== name);
  return changed(withTopicTags(ctx.store, topic.id, after), `ok ${topic.id} 已撕掉 #${name}`, {
    kind: "hashtag.removed",
    topic: topic.id,
    before: before.join(" "),
    after: after.join(" "),
    text: `議題「${topic.name}」撕掉 #${name}`,
  });
}

/** The shown spelling for `raw`, or why the board has no such hashtag. */
function existing(store: Frozen<HashtagStore>, raw: string): string | { problem: string } {
  const checked = checkName(raw);
  if (typeof checked === "string") return { problem: checked };
  return nameOfKey(store, checked.key) ?? { problem: `看板沒有 #${checked.name} 這個 hashtag。` };
}

/** Replaces `from` with `to` (or drops it when `to` is null) on every topic and view. */
function replaceEverywhere(store: HashtagStore, from: string, to: string | null): void {
  const swap = (names: string[]): string[] => [
    ...new Set(names.flatMap((name) => (name !== from ? [name] : to === null ? [] : [to]))),
  ];
  for (const [id, names] of Object.entries(store.topics)) {
    const next = swap(names);
    if (next.length === 0) delete store.topics[id];
    else store.topics[id] = next;
  }
  for (const view of Object.values(store.views)) {
    view.any = swap(view.any);
    view.none = swap(view.none);
  }
}

function boardRecord(kind: Draft["kind"], before: string, after: string, text: string): Draft {
  return { kind, topic: null, before, after, text };
}

/** Gives a hashtag another spelling, on every topic and view that has it. */
export function renameHashtag(ctx: HashtagContext, raw: string, rawTo: string): HashtagResult {
  const to = checkName(rawTo);
  if (typeof to === "string") return refuse(to);
  const from = existing(ctx.store, raw);
  if (typeof from !== "string") {
    const done = typeof existing(ctx.store, to.name) === "string";
    return done ? unchanged(ctx.store, `ok 本來就叫 #${to.name}`) : refuse(from.problem);
  }
  if (to.name === from) return unchanged(ctx.store, `ok #${from} 名稱沒有變`);
  const taken = nameOfKey(ctx.store, to.key);
  if (taken !== undefined && taken !== from)
    return refuse(`已經有 #${taken}；要把兩個合在一起請用合併。`);
  const next = clone(ctx.store);
  const count = topicsWith(ctx.store, from).length;
  next.hashtags[to.name] = { ...(next.hashtags[from] as HashtagEntry), key: to.key };
  delete next.hashtags[from];
  replaceEverywhere(next, from, to.name);
  const text = `hashtag #${from} 改名為 #${to.name}（${count} 個議題）`;
  return changed(next, `ok ${text}`, boardRecord("hashtag.renamed", from, to.name, text));
}

/** Moves every topic and view from one hashtag to another, then drops the first. */
export function mergeHashtags(ctx: HashtagContext, raw: string, rawInto: string): HashtagResult {
  const into = existing(ctx.store, rawInto);
  if (typeof into !== "string") return refuse(into.problem);
  const from = existing(ctx.store, raw);
  if (typeof from !== "string")
    return unchanged(ctx.store, `ok ${from.problem}（可能已經併進 #${into}）`);
  if (from === into) return refuse("不能把 hashtag 併進它自己。");
  const next = clone(ctx.store);
  const count = topicsWith(ctx.store, from).length;
  delete next.hashtags[from];
  replaceEverywhere(next, from, into);
  const text = `hashtag #${from} 併入 #${into}（${count} 個議題）`;
  return changed(next, `ok ${text}`, boardRecord("hashtag.merged", from, into, text));
}

/** Takes a hashtag off every topic and view and out of the board. */
export function deleteHashtag(ctx: HashtagContext, raw: string): HashtagResult {
  const name = existing(ctx.store, raw);
  if (typeof name !== "string") return unchanged(ctx.store, `ok ${name.problem}`);
  const next = clone(ctx.store);
  const count = topicsWith(ctx.store, name).length;
  delete next.hashtags[name];
  replaceEverywhere(next, name, null);
  const text = `hashtag #${name} 已刪掉（${count} 個議題撕掉了它）`;
  return changed(next, `ok ${text}`, boardRecord("hashtag.deleted", name, "", text));
}

/** Locks or unlocks one hashtag against the aggregator. */
export function lockHashtag(ctx: HashtagContext, raw: string, locked: boolean): HashtagResult {
  const name = existing(ctx.store, raw);
  if (typeof name !== "string") return refuse(name.problem);
  if (ctx.store.hashtags[name]?.locked === locked)
    return unchanged(ctx.store, `ok #${name} 本來就${locked ? "鎖上了" : "沒有鎖"}`);
  const next = clone(ctx.store);
  (next.hashtags[name] as HashtagEntry).locked = locked;
  const text = `hashtag #${name} ${locked ? "鎖上：只有使用者能貼撕" : "解鎖"}`;
  return changed(
    next,
    `ok ${text}`,
    boardRecord("hashtag.lock_changed", String(!locked), String(locked), text),
  );
}

/** Gives one hashtag a colour from the fixed palette. */
export function colorHashtag(ctx: HashtagContext, raw: string, rawColor: string): HashtagResult {
  const name = existing(ctx.store, raw);
  if (typeof name !== "string") return refuse(name.problem);
  const color = COLORS.find((entry) => entry === rawColor);
  if (color === undefined) return refuse(`顏色只能是 ${COLORS.join("、")} 其中之一。`);
  const before = (ctx.store.hashtags[name] as Frozen<HashtagEntry>).color;
  if (before === color) return unchanged(ctx.store, `ok #${name} 本來就是這個顏色`);
  const next = clone(ctx.store);
  (next.hashtags[name] as HashtagEntry).color = color;
  return changed(
    next,
    `ok #${name} 換了顏色`,
    boardRecord("hashtag.color_changed", before, color, `hashtag #${name} 換了顏色`),
  );
}

/** One setting the captain changes, checked against its range. */
function settingValue(
  name: string,
  value: unknown,
  views: Frozen<HashtagStore>["views"],
): string | null {
  if ((FLAG_SETTINGS as readonly string[]).includes(name))
    return typeof value === "boolean" ? null : `${name} 要是 true 或 false。`;
  if (Object.hasOwn(SETTING_RANGES, name)) return numberProblem(name as NumberSetting, value);
  if (name !== "default_view") return `不認得的設定：${name}`;
  const known = value === ALL_VIEW || (typeof value === "string" && Object.hasOwn(views, value));
  return known ? null : "預設視圖要是「全部」或一個存下來的視圖。";
}

function numberProblem(name: NumberSetting, value: unknown): string | null {
  const range = SETTING_RANGES[name];
  return inRange(value, range) ? null : `${name} 要是 ${range[0]} 到 ${range[1]} 的整數。`;
}

/** Changes any of the captain's settings; each one is checked, and none changes when one is wrong. */
export function changeSettings(ctx: HashtagContext, input: Record<string, unknown>): HashtagResult {
  for (const [name, value] of Object.entries(input)) {
    const problem = settingValue(name, value, ctx.store.views);
    if (problem !== null) return { ok: false, code: "usage", line: problem };
  }
  const settings = { ...ctx.store.settings, ...input } as HashtagSettings;
  const before = JSON.stringify(ctx.store.settings);
  const after = JSON.stringify(settings);
  if (before === after) return unchanged(ctx.store, "ok hashtag 設定沒有變");
  const next = clone(ctx.store);
  next.settings = settings;
  return changed(
    next,
    "ok hashtag 設定已改",
    boardRecord("hashtag.settings_changed", before, after, "hashtag 設定已改"),
  );
}

/** What a view asks for, as stored; or why it cannot be stored. */
export interface ViewInput {
  id?: string;
  name: string;
  any: readonly string[];
  none: readonly string[];
  text: string;
  untagged: boolean;
  order: CardOrder;
}

function viewOf(store: Frozen<HashtagStore>, input: ViewInput): SavedView | string {
  const name = oneLine(input.name, VIEW_NAME_MAX);
  if (name === null) return `視圖的名稱要是一行、不能是空的、最多 ${VIEW_NAME_MAX} 個字。`;
  const text = input.text.trim() === "" ? "" : oneLine(input.text, VIEW_TEXT_MAX);
  if (text === null) return `關鍵字要是一行、最多 ${VIEW_TEXT_MAX} 個字。`;
  const any = shownNames(store, input.any);
  if (!Array.isArray(any)) return any.problem;
  const none = shownNames(store, input.none);
  if (!Array.isArray(none)) return none.problem;
  return { name, any, none, text, untagged: input.untagged, order: input.order };
}

/** The shown spellings of `raw`, each once, or why one of them is not a hashtag the board has. */
function shownNames(
  store: Frozen<HashtagStore>,
  raw: readonly string[],
): string[] | { problem: string } {
  const names: string[] = [];
  for (const entry of raw) {
    const found = existing(store, entry);
    if (typeof found !== "string") return found;
    if (!names.includes(found)) names.push(found);
  }
  return names;
}

/** The view's id: the one given, else the saved view of the same name, else a new one. */
function viewId(store: Frozen<HashtagStore>, input: ViewInput, name: string): string {
  if (input.id !== undefined) return input.id;
  const same = Object.keys(store.views).find((id) => store.views[id]?.name === name);
  if (same !== undefined) return same;
  return freshViewId(store, input.name);
}

/** A view id nobody uses: the name's slug when it has one, else v<n>. */
function freshViewId(store: Frozen<HashtagStore>, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const free = (id: string): boolean =>
    id !== ALL_VIEW && !Object.hasOwn(store.views, id) && isValidTopicId(id);
  if (free(slug)) return slug;
  for (let n = 1; ; n += 1) if (free(`v${n}`)) return `v${n}`;
}

/** Saves a named view, or rewrites the one with the same id. */
export function saveView(ctx: HashtagContext, input: ViewInput): HashtagResult {
  if (input.id !== undefined && (!isValidTopicId(input.id) || input.id === ALL_VIEW))
    return { ok: false, code: "usage", line: `視圖 id 格式不對：${input.id}` };
  const view = viewOf(ctx.store, input);
  if (typeof view === "string") return refuse(view);
  const id = viewId(ctx.store, input, view.name);
  const before = ctx.store.views[id];
  if (before !== undefined && JSON.stringify(before) === JSON.stringify(view))
    return unchanged(ctx.store, `ok 視圖「${view.name}」沒有變`);
  const next = clone(ctx.store);
  next.views[id] = view;
  const record = boardRecord(
    "hashtag.view_saved",
    before === undefined ? "" : JSON.stringify(before),
    JSON.stringify(view),
    `視圖「${view.name}」已存下`,
  );
  return changed(next, `ok ${id} 視圖「${view.name}」已存下`, record);
}

/** Drops a saved view; the default view falls back to 全部 when it was this one. */
export function deleteView(ctx: HashtagContext, id: string): HashtagResult {
  const view = Object.hasOwn(ctx.store.views, id) ? ctx.store.views[id] : undefined;
  if (view === undefined) return unchanged(ctx.store, `ok 本來就沒有視圖 ${id}`);
  const next = clone(ctx.store);
  delete next.views[id];
  if (next.settings.default_view === id) next.settings.default_view = ALL_VIEW;
  const text = `視圖「${view.name}」已刪掉`;
  return changed(
    next,
    `ok ${text}`,
    boardRecord("hashtag.view_deleted", JSON.stringify(view), "", text),
  );
}

/** True for a hashtag the aggregator opened that the captain has not marked seen. */
export function isNew(ctx: Pick<HashtagContext, "records">, entry: Frozen<HashtagEntry>): boolean {
  if (entry.created_by !== "aggregator") return false;
  const seen = oversight.lastSeenAt(ctx.records, WATCHED);
  return seen === null || Date.parse(entry.created_at) / 1000 > seen;
}

/** Marks the aggregator's changes so far, and the hashtags it opened, as seen. */
export function markSeen(ctx: HashtagContext): HashtagResult {
  const unseen = oversight.unseenChanges(ctx.records, WATCHED).length;
  const opened = Object.values(ctx.store.hashtags).filter((entry) => isNew(ctx, entry)).length;
  if (unseen === 0 && opened === 0) return unchanged(ctx.store, "ok 沒有還沒看過的 hashtag 改動");
  const text = `看過 aggregator 最近的 hashtag 改動（${unseen} 筆，新開的 hashtag ${opened} 個）`;
  return changed(clone(ctx.store), `ok ${text}`, { kind: "hashtag.seen", topic: null, text });
}

function words(list: string | undefined): string[] {
  return list === undefined ? [] : list.split(" ").filter((name) => name !== "");
}

/** The record to take back and the topic it changed, or the result that turns the revert down. */
function revertTarget(
  ctx: HashtagContext,
  rid: string,
): { record: HashtagRecord; topic: { id: string; name: string } } | HashtagResult {
  const found = oversight.revertable(ctx.records, WATCHED, rid);
  if ("reverted" in found) return unchanged(ctx.store, `ok ${rid} 本來就已撤回`);
  if ("problem" in found) return refuse(found.problem);
  if (typeof found.record.topic !== "string") return refuse(`紀錄 ${rid} 沒有議題，不能撤回。`);
  const topic = liveTopic(ctx.topics, found.record.topic);
  if (typeof topic === "string") return refuse(topic);
  return { record: found.record, topic };
}

/**
 * Takes back one change the aggregator made: what it put on comes off, what it
 * took off goes back on. A hashtag it opened that is now on no topic and that
 * the captain has not seen goes away with it.
 */
export function revertChange(ctx: HashtagContext, rid: string): HashtagResult {
  const target = revertTarget(ctx, rid);
  if ("ok" in target) return target;
  const { record, topic } = target;
  const was = words(record.before);
  const became = words(record.after);
  const gone = was.filter((name) => !became.includes(name));
  const missing = gone.filter((name) => ctx.store.hashtags[name] === undefined);
  if (missing.length > 0)
    return refuse(
      `${tags(missing)} 已經不在了（改名、合併或刪掉了），這筆改動不能自動撤回；請直接在議題上改。`,
    );
  const before = tagsIn(ctx.store.topics, topic.id);
  const added = became.filter((name) => !was.includes(name));
  const after = [
    ...before.filter((name) => !added.includes(name)),
    ...gone.filter((name) => !before.includes(name)),
  ];
  const next = withTopicTags(ctx.store, topic.id, after);
  for (const name of added) {
    const entry = next.hashtags[name];
    if (entry !== undefined && isNew(ctx, entry) && topicsWith(next, name).length === 0)
      delete next.hashtags[name];
  }
  const text = `撤回 aggregator 在議題「${topic.name}」的改動：${tags(before)} → ${tags(after)}`;
  return changed(next, `ok ${text}`, {
    kind: "hashtag.reverted",
    topic: topic.id,
    before: before.join(" "),
    after: after.join(" "),
    ref: rid,
    text,
  });
}

// ---- what topic changes do to hashtags ----

/** A topic change's follow-up in this file, or null when the topic carried none. */
export interface Carried {
  store: HashtagStore;
  records: Records;
}

function carried(store: HashtagStore, record: Draft): Carried {
  return { store, records: [record] };
}

/** A merge: the topic merged in brings its hashtags to the one it went into. */
export function carryMerge(
  store: Frozen<HashtagStore>,
  from: string,
  into: { id: string; name: string },
): Carried | null {
  const brought = store.topics[from];
  if (brought === undefined) return null;
  const before = tagsIn(store.topics, into.id);
  const after = [...new Set([...before, ...brought])];
  const next = clone(store);
  delete next.topics[from];
  next.topics[into.id] = after;
  const added = after.filter((name) => !before.includes(name));
  const text =
    added.length === 0
      ? `議題「${into.name}」：併進來的議題的 hashtag 這裡都有了`
      : `議題「${into.name}」：併進來時帶上 ${tags(added)}`;
  return carried(next, {
    kind: "hashtag.carried",
    topic: into.id,
    before: before.join(" "),
    after: after.join(" "),
    text,
  });
}

/** A split: the new topic starts with its source's hashtags. */
export function carrySplit(
  store: Frozen<HashtagStore>,
  from: string,
  made: { id: string; name: string },
): Carried | null {
  const copied = store.topics[from];
  if (copied === undefined || store.topics[made.id] !== undefined) return null;
  const next = clone(store);
  next.topics[made.id] = [...copied];
  const text = `議題「${made.name}」：拆出時帶上 ${tags(copied)}`;
  return carried(next, {
    kind: "hashtag.carried",
    topic: made.id,
    before: "",
    after: copied.join(" "),
    text,
  });
}

// ---- what the page shows ----

/** One aggregator change the captain has not marked seen, for the list with a revert next to each. */
export interface HashtagView {
  /** Every hashtag, by key; `topics` are the ids that carry it. */
  hashtags: {
    name: string;
    color: Color;
    locked: boolean;
    created_by: "captain" | "aggregator";
    new: boolean;
    topics: string[];
  }[];
  /** Topic id to its hashtags. */
  topics: Record<string, string[]>;
  views: (SavedView & { id: string })[];
  settings: HashtagSettings;
  defaults: HashtagSettings;
  ranges: Record<NumberSetting, readonly [number, number]>;
  /** Topics with more hashtags than the per-topic maximum (after a merge); they take no new one. */
  over: string[];
  /** The aggregator's changes since the captain last marked them seen, newest first. */
  recent: RecentChange[];
}

/** What the page shows of the hashtags. `records` are the board's saved records, oldest first. */
export function hashtagView(
  store: Frozen<HashtagStore>,
  records: readonly (HashtagRecord & { text?: string })[],
): HashtagView {
  const ctx = { records };
  const max = store.settings.per_topic_max;
  return {
    hashtags: Object.entries(store.hashtags)
      .toSorted(([, a], [, b]) => a.key.localeCompare(b.key))
      .map(([name, entry]) => ({
        name,
        color: entry.color,
        locked: entry.locked,
        created_by: entry.created_by,
        new: isNew(ctx, entry),
        topics: topicsWith(store, name),
      })),
    topics: structuredClone(store.topics) as Record<string, string[]>,
    views: Object.entries(store.views).map(([id, view]) => ({
      id,
      ...(structuredClone(view) as SavedView),
    })),
    settings: { ...store.settings },
    defaults: { ...DEFAULT_SETTINGS },
    ranges: { ...SETTING_RANGES },
    over: Object.entries(store.topics)
      .filter(([, names]) => names.length > max)
      .map(([id]) => id),
    recent: oversight.recentChanges(records, WATCHED),
  };
}
