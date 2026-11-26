// Schedules (data/myshape/schedules.json): a daily or weekly rule attached to
// one open topic, the occurrences the board's clock opens (PR 2), the last
// ten that ended, the settings the captain tunes, and deleted schedules kept
// for thirty days. Pure: each operation takes the store and returns the next
// one with its records; store.ts commitChange saves them.
//
// The locks, the hourly cap and the first-ring rule are guard rails against a
// careless or misled aggregator, not a boundary against a deliberate program
// under the same account: the socket does not verify who is calling.
import * as oversight from "./oversight.js";
import type { WatchedRecord } from "./oversight.js";
import { isRecord, stringField } from "./files.js";
import type { Draft, Frozen, RecordKind } from "./records.js";
import {
  describeRule,
  formatRule,
  isOccurrence,
  isTimeZone,
  isoSeconds,
  localLabel,
  minGapMinutes,
  occurrenceAfter,
  occurrenceKey,
  parseOccurrenceKey,
  parseRule,
} from "./schedule-time.js";
import type { Rule, Weekday } from "./schedule-time.js";
import { GOAL_MAX, QUEUE_LABEL, isValidTopicId, oneLine, resolveTopicId } from "./topics.js";
import type { TopicState } from "./topics.js";

export const RT_VALUES = ["none", "soft-rt", "hard-rt"] as const;
export type Rt = (typeof RT_VALUES)[number];
export const SERIES_STATES = ["on", "paused"] as const;
export type SeriesState = (typeof SERIES_STATES)[number];
export const OCCURRENCE_STATES = ["upcoming", "due", "taken"] as const;
export type OccurrenceState = (typeof OCCURRENCE_STATES)[number];
export const MISSED_MODES = ["notice", "due", "record"] as const;
export type MissedMode = (typeof MISSED_MODES)[number];
export const CLOSE_OUTCOMES = ["done", "skipped"] as const;
export type CloseOutcome = (typeof CLOSE_OUTCOMES)[number];

/** What the captain tunes on the page (design section 5.1); null zone means this machine's. */
export interface Settings {
  lead_min: number;
  duration_min: number;
  max_open_min: number;
  missed: MissedMode;
  late_after_min: number;
  aggregator_may_create: boolean;
  aggregator_needs_enable: boolean;
  first_bell_min_ahead: number;
  captain_locks_by_default: boolean;
  max_active: number;
  aggregator_changes_per_hour: number;
  aggregator_may_set_rt: boolean;
  default_rt: Rt;
  default_tz: string | null;
  all_paused: boolean;
}

/** One schedule. `lead_min` and `duration_min` are null when the settings decide them. */
export interface Series {
  topic: string;
  title: string;
  rule: string;
  tz: string;
  duration_min: number | null;
  lead_min: number | null;
  rt: Rt;
  rt_locked: boolean;
  state: SeriesState;
  locked: boolean;
  by: "captain" | "aggregator";
  /** Only on a schedule the aggregator made: whether the captain has seen it. */
  seen?: boolean;
  created_at: string;
  /** How far the clock has checked; written only by the clock (PR 2). */
  checked_through?: string;
}

/** An occurrence the clock opened and that has not ended. */
export interface Occurrence {
  series: string;
  at: string;
  state: OccurrenceState;
  opened_at: string;
  taken_at?: string;
  note?: string;
  closes_by: string;
  /** The fixed ids of the notices handed over for it (PR 2). */
  notices?: Record<string, string>;
}

/** One ended or skipped occurrence of a schedule; the clock's missed entries also count others. */
export interface RecentEntry {
  key: string;
  outcome: string;
  by: string;
  note?: string;
  closed_at?: string;
  notice?: string;
  notices?: Record<string, string>;
  count?: number;
  from?: string;
  to?: string;
}

export interface RemovedSeries extends Series {
  removed_at: string;
  removed_by: string;
}

export interface ScheduleStore {
  v: 1;
  settings: Settings;
  series: Record<string, Series>;
  occurrences: Record<string, Occurrence>;
  recent: Record<string, RecentEntry[]>;
  removed: Record<string, RemovedSeries>;
}

/** What a schedule operation did; a change carries at least one record, like a topic change. */
export type ScheduleResult =
  | {
      ok: true;
      changed: true;
      store: ScheduleStore;
      line: string;
      records: readonly [Draft, ...Draft[]];
    }
  | { ok: true; changed: false; store: Frozen<ScheduleStore>; line: string }
  | { ok: false; code: "refused" | "usage"; line: string };

/** A saved record as the schedule rails read it (oversight.ts), with the schedule on each side. */
export type ScheduleRecord = WatchedRecord & { before?: string; after?: string };

/** Who asks and what the board knows besides the store. */
export interface ScheduleEnv {
  topics: Frozen<TopicState>;
  nowMs: number;
  actor: { by: "captain" | "aggregator"; label: string };
  /** The board's saved records, oldest first: the hourly cap, undoing and the seen mark read them. */
  records: readonly ScheduleRecord[];
  /** This machine's time zone, for a schedule made without one. */
  machineZone: string;
}

export const DEFAULT_SETTINGS: Settings = {
  lead_min: 15,
  duration_min: 60,
  max_open_min: 180,
  missed: "notice",
  late_after_min: 5,
  aggregator_may_create: true,
  aggregator_needs_enable: false,
  first_bell_min_ahead: 60,
  captain_locks_by_default: true,
  max_active: 20,
  aggregator_changes_per_hour: 10,
  aggregator_may_set_rt: true,
  default_rt: "none",
  default_tz: null,
  all_paused: false,
};

/** The whole-minute ranges of the settings (design section 5.1). */
export const RANGES = {
  lead_min: [0, 120],
  duration_min: [5, 480],
  max_open_min: [15, 1440],
  late_after_min: [1, 60],
  first_bell_min_ahead: [0, 1440],
  max_active: [1, 100],
  aggregator_changes_per_hour: [1, 100],
} as const satisfies Partial<Record<keyof Settings, readonly [number, number]>>;
type NumberSetting = keyof typeof RANGES;

const BOOLEAN_SETTINGS = [
  "aggregator_may_create",
  "aggregator_needs_enable",
  "captain_locks_by_default",
  "aggregator_may_set_rt",
] as const;

const RECENT_KEEP = 10;
const NOTE_MAX = GOAL_MAX;
const MINUTE_MS = 60_000;
/** How long a deleted schedule is kept so it can be undone. */
export const REVERT_DAYS = 30;
const REVERT_MS = REVERT_DAYS * 24 * 60 * MINUTE_MS;

/**
 * The schedule records the guard rails watch (oversight.ts): the aggregator's
 * changes, which its hourly cap counts and the captain may take back, the
 * captain's revert of one, and the captain's mark that every change so far
 * was seen.
 */
export const WATCHED: oversight.Watched = {
  changes: new Set<RecordKind>([
    "schedule.created",
    "schedule.edited",
    "schedule.paused",
    "schedule.resumed",
    "schedule.skipped",
    "schedule.rt_changed",
    "schedule.deleted",
  ]),
  reverted: "schedule.reverted",
  seen: "schedule.seen",
};

/** Whether the aggregator made `series` and the captain has not marked it seen (shown as 新). */
export function isNew(series: Pick<Frozen<Series>, "by" | "seen">): boolean {
  return series.by === "aggregator" && series.seen !== true;
}

const RT_WORDS: Record<Rt, string> = {
  none: "",
  "soft-rt": "（soft-rt）",
  "hard-rt": "（hard-rt）",
};

export function emptySchedules(): ScheduleStore {
  return {
    v: 1,
    settings: { ...DEFAULT_SETTINGS },
    series: {},
    occurrences: {},
    recent: {},
    removed: {},
  };
}

// ---------------------------------------------------------------- reading

function isRt(value: unknown): value is Rt {
  return typeof value === "string" && (RT_VALUES as readonly string[]).includes(value);
}

function inRange(value: unknown, [low, high]: readonly [number, number]): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;
}

function oneOf<T extends string>(list: readonly T[], value: unknown, fallback: T): T {
  return list.find((entry) => entry === value) ?? fallback;
}

/** The stored settings; a missing or out-of-range value reads as its default. */
function parseSettings(raw: unknown): Settings {
  const given = isRecord(raw) ? raw : {};
  const settings: Settings = { ...DEFAULT_SETTINGS };
  for (const [name, range] of Object.entries(RANGES) as [NumberSetting, [number, number]][]) {
    if (inRange(given[name], range)) settings[name] = given[name];
  }
  for (const name of [...BOOLEAN_SETTINGS, "all_paused"] as const) {
    if (typeof given[name] === "boolean") settings[name] = given[name];
  }
  settings.missed = oneOf(MISSED_MODES, given["missed"], DEFAULT_SETTINGS.missed);
  settings.default_rt = isRt(given["default_rt"])
    ? given["default_rt"]
    : DEFAULT_SETTINGS.default_rt;
  const zone = given["default_tz"];
  settings.default_tz = typeof zone === "string" && isTimeZone(zone) ? zone : null;
  return settings;
}

function optionalMinutes(
  raw: unknown,
  range: readonly [number, number],
): number | null | undefined {
  if (raw === null || raw === undefined) return null;
  return inRange(raw, range) ? raw : undefined;
}

function stringMap(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined;
  const map: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) if (typeof value === "string") map[name] = value;
  return map;
}

/** The string fields `names` of `raw`, or null when one is missing or not a string. */
function required<const N extends string>(
  raw: Record<string, unknown>,
  names: readonly N[],
): Record<N, string> | null {
  const found: Partial<Record<N, string>> = {};
  for (const name of names) {
    const value = stringField(raw, name);
    if (value === null) return null;
    found[name] = value;
  }
  return found as Record<N, string>;
}

/** The string fields `names` of `raw` that are there; the clock writes some of them (PR 2). */
function present<const N extends string>(
  raw: Record<string, unknown>,
  names: readonly N[],
): Partial<Record<N, string>> {
  const found: Partial<Record<N, string>> = {};
  for (const name of names) {
    const value = stringField(raw, name);
    if (value !== null) found[name] = value;
  }
  return found;
}

/** The notice ids an occurrence or entry carries, when it carries any. */
function noticesOf(raw: Record<string, unknown>): { notices?: Record<string, string> } {
  const notices = stringMap(raw["notices"]);
  return notices === undefined ? {} : { notices };
}

/** The minutes a stored schedule leaves to the settings (null) or sets, or null when out of range. */
function storedMinutes(
  raw: Record<string, unknown>,
): Pick<Series, "duration_min" | "lead_min"> | null {
  const duration = optionalMinutes(raw["duration_min"], RANGES.duration_min);
  const lead = optionalMinutes(raw["lead_min"], RANGES.lead_min);
  return duration === undefined || lead === undefined
    ? null
    : { duration_min: duration, lead_min: lead };
}

/** One stored schedule, or null when it lacks what the board needs to run it. */
function parseSeries(raw: unknown): Series | null {
  if (!isRecord(raw)) return null;
  const text = required(raw, ["topic", "title", "rule", "tz", "created_at"]);
  const minutes = storedMinutes(raw);
  if (text === null || minutes === null) return null;
  if (parseRule(text.rule) === null || !isTimeZone(text.tz)) return null;
  const by = raw["by"] === "aggregator" ? "aggregator" : "captain";
  return {
    topic: text.topic,
    title: text.title,
    rule: text.rule,
    tz: text.tz,
    ...minutes,
    rt: isRt(raw["rt"]) ? raw["rt"] : "none",
    rt_locked: raw["rt_locked"] === true,
    state: oneOf(SERIES_STATES, raw["state"], "paused"),
    locked: raw["locked"] === true,
    by,
    ...(by === "aggregator" ? { seen: raw["seen"] === true } : {}),
    created_at: text.created_at,
    ...present(raw, ["checked_through"]),
  };
}

function parseOccurrence(raw: unknown): Occurrence | null {
  if (!isRecord(raw)) return null;
  const text = required(raw, ["series", "at", "opened_at", "closes_by"]);
  const state = OCCURRENCE_STATES.find((name) => name === raw["state"]);
  if (text === null || state === undefined) return null;
  return { ...text, state, ...present(raw, ["taken_at", "note"]), ...noticesOf(raw) };
}

function parseRecent(raw: unknown): RecentEntry | null {
  if (!isRecord(raw)) return null;
  const text = required(raw, ["key", "outcome", "by"]);
  if (text === null) return null;
  const count = raw["count"];
  return {
    ...text,
    ...present(raw, ["note", "closed_at", "notice", "from", "to"]),
    ...noticesOf(raw),
    ...(typeof count === "number" && Number.isInteger(count) ? { count } : {}),
  };
}

function parseEntries<T>(
  raw: unknown,
  parse: (value: unknown) => T | null,
  validId: (id: string) => boolean,
): Record<string, T> {
  const entries: Record<string, T> = {};
  if (!isRecord(raw)) return entries;
  for (const [id, value] of Object.entries(raw)) {
    const parsed = parse(value);
    if (parsed !== null && validId(id)) entries[id] = parsed;
  }
  return entries;
}

/**
 * A usable schedule id: the topic-id grammar, at most 64 characters. The
 * clock's fixed notice ids (w-s-<id>-<UTC>-<phase>) and Firstmate's inbox
 * request ids (tb-<write id>, at most 128 of A-Za-z0-9._:-) depend on it.
 */
export function isValidScheduleId(id: string): boolean {
  return isValidTopicId(id);
}

function isOccurrenceKeyOf(key: string): boolean {
  const parsed = parseOccurrenceKey(key);
  return parsed !== null && isValidScheduleId(parsed.series);
}

function parseRemoved(raw: unknown): RemovedSeries | null {
  const series = parseSeries(raw);
  if (series === null || !isRecord(raw)) return null;
  const removedAt = stringField(raw, "removed_at");
  const removedBy = stringField(raw, "removed_by");
  if (removedAt === null || removedBy === null) return null;
  return { ...series, removed_at: removedAt, removed_by: removedBy };
}

/**
 * Reads data/myshape/schedules.json. Entries that are not whole are skipped,
 * settings out of range read as their defaults, and fields the clock writes
 * (checked_through, notices, missed counts) are kept as they are.
 */
export function parseSchedules(raw: unknown): ScheduleStore {
  if (!isRecord(raw) || raw["v"] !== 1) throw new Error("expected an object with v: 1");
  const recent: Record<string, RecentEntry[]> = {};
  if (isRecord(raw["recent"])) {
    for (const [id, list] of Object.entries(raw["recent"])) {
      if (!Array.isArray(list) || !isValidScheduleId(id)) continue;
      recent[id] = list.flatMap((entry: unknown) => {
        const parsed = parseRecent(entry);
        return parsed === null ? [] : [parsed];
      });
    }
  }
  return {
    v: 1,
    settings: parseSettings(raw["settings"]),
    series: parseEntries(raw["series"], parseSeries, isValidScheduleId),
    occurrences: parseEntries(raw["occurrences"], parseOccurrence, isOccurrenceKeyOf),
    recent,
    removed: parseEntries(raw["removed"], parseRemoved, isValidScheduleId),
  };
}

// ---------------------------------------------------------------- reading the model

/** The rule of a stored schedule; parseSchedules only keeps schedules whose rule reads. */
export function ruleOf(series: Frozen<Series>): Rule {
  const rule = parseRule(series.rule);
  if (rule === null) throw new Error(`排程的規則讀不懂：${series.rule}`);
  return rule;
}

/** The lead, duration and longest open time that apply to `series`. */
export function effective(
  series: Pick<Frozen<Series>, "lead_min" | "duration_min">,
  settings: Frozen<Settings>,
): { lead: number; duration: number; maxOpen: number } {
  return {
    lead: series.lead_min ?? settings.lead_min,
    duration: series.duration_min ?? settings.duration_min,
    maxOpen: settings.max_open_min,
  };
}

/** The schedule on `topic` (merges followed on both sides), with its id. */
export function scheduleOfTopic(
  store: Frozen<ScheduleStore>,
  topics: Frozen<TopicState>,
  topic: string,
): { id: string; series: Frozen<Series> } | null {
  const wanted = resolveTopicId(topics.doc, topic);
  for (const [id, series] of Object.entries(store.series)) {
    if (resolveTopicId(topics.doc, series.topic) === wanted) return { id, series };
  }
  return null;
}

/** The occurrence of `id` that is in the file, open or past its closes_by, with its key. */
function openOf(
  store: Frozen<ScheduleStore>,
  id: string,
): { key: string; occurrence: Frozen<Occurrence> } | null {
  for (const [key, occurrence] of Object.entries(store.occurrences)) {
    if (occurrence.series === id) return { key, occurrence };
  }
  return null;
}

/** Whether an occurrence has ended: every reader treats one past its closes_by as ended. */
export function hasEnded(occurrence: Frozen<Occurrence>, nowMs: number): boolean {
  return Date.parse(occurrence.closes_by) <= nowMs;
}

function instantOf(key: string): number {
  return parseOccurrenceKey(key)?.at ?? Number.NEGATIVE_INFINITY;
}

/**
 * The next occurrence of schedule `id` that has neither been handled nor is
 * open: after `nowMs`, after every occurrence already handled or open (so a
 * clock that went back never offers one again), and opening no earlier than
 * an open occurrence's closes_by (a rule change applies after it).
 */
export function nextOccurrence(store: Frozen<ScheduleStore>, id: string, nowMs: number): number {
  const series = store.series[id] ?? store.removed[id];
  if (series === undefined) throw new Error(`沒有排程 ${id}`);
  const rule = ruleOf(series);
  const { lead } = effective(series, store.settings);
  const open = openOf(store, id);
  const handled = (store.recent[id] ?? []).map((entry) => instantOf(entry.key));
  if (open !== null) handled.push(Date.parse(open.occurrence.at));
  let at = occurrenceAfter(rule, series.tz, Math.max(nowMs, ...handled));
  const opensAfter =
    open === null ? Number.NEGATIVE_INFINITY : Date.parse(open.occurrence.closes_by);
  while (at - lead * MINUTE_MS < opensAfter) at = occurrenceAfter(rule, series.tz, at);
  return at;
}

/**
 * Why `rule` with these minutes could have two occurrences open at once, or
 * null: an occurrence opens `lead` minutes before its time and stays open at
 * most the longer of `duration` and `maxOpen`, and the next one must not open
 * before that.
 */
export function overlapProblem(
  rule: Rule,
  minutes: { lead: number; duration: number; maxOpen: number },
): string | null {
  const longest = Math.max(minutes.duration, minutes.maxOpen);
  const gap = minGapMinutes(rule);
  if (minutes.lead + longest <= gap) return null;
  return (
    `這樣設的話，${describeRule(rule)} 會同時開著兩場：提前 ${minutes.lead} 分加上最長開 ${longest} 分，` +
    `不能超過兩場之間最短的 ${gap} 分`
  );
}

/** How many schedules are switched on. */
export function activeCount(store: Frozen<ScheduleStore>): number {
  return Object.values(store.series).filter((series) => series.state === "on").length;
}

// ---------------------------------------------------------------- results

function refused(line: string): ScheduleResult {
  return { ok: false, code: "refused", line };
}

function usage(line: string): ScheduleResult {
  return { ok: false, code: "usage", line };
}

function unchanged(store: Frozen<ScheduleStore>, line: string): ScheduleResult {
  return { ok: true, changed: false, store, line };
}

function changed(store: ScheduleStore, line: string, records: [Draft, ...Draft[]]): ScheduleResult {
  return { ok: true, changed: true, store, line, records };
}

function clone(store: Frozen<ScheduleStore>): ScheduleStore {
  return structuredClone(store) as ScheduleStore;
}

function suffix(env: ScheduleEnv): string {
  return env.actor.by === "captain" ? "（你在頁面上）" : `（${env.actor.label} 用指令）`;
}

/** A schedule, its future skips, and its id: what a change's record keeps on each side. */
interface Snapshot {
  id: string;
  series: Frozen<Series> | null;
  skips: Frozen<RecentEntry>[];
}

/** A skip made before its occurrence came: what skip-next and the first-ring rule leave. */
function isAdvanceSkip(entry: Frozen<RecentEntry>): boolean {
  return (
    entry.outcome === "skipped" &&
    entry.closed_at !== undefined &&
    Date.parse(entry.closed_at) < instantOf(entry.key)
  );
}

function snapshot(store: Frozen<ScheduleStore>, id: string): string {
  const series = store.series[id] ?? null;
  const skips = (store.recent[id] ?? []).filter(isAdvanceSkip);
  const shown: Snapshot = { id, series: series === null ? null : comparable(series), skips };
  return JSON.stringify(shown);
}

/**
 * A schedule without what the clock and the captain's look change behind a
 * change's back, its fields always in the same order so two can be compared
 * as text.
 */
function comparable(series: Frozen<Series>): Frozen<Series> {
  return {
    topic: series.topic,
    title: series.title,
    rule: series.rule,
    tz: series.tz,
    duration_min: series.duration_min,
    lead_min: series.lead_min,
    rt: series.rt,
    rt_locked: series.rt_locked,
    state: series.state,
    locked: series.locked,
    by: series.by,
    created_at: series.created_at,
  };
}

/** One record about schedule `id`, with the schedule on each side of the change. */
function record(
  kind: RecordKind,
  before: Frozen<ScheduleStore>,
  after: Frozen<ScheduleStore>,
  id: string,
  text: string,
  topic: string | null,
): Draft {
  return {
    kind,
    topic,
    before: snapshot(before, id),
    after: snapshot(after, id),
    text,
  };
}

function pushRecent(store: ScheduleStore, id: string, entry: RecentEntry): void {
  store.recent[id] = [...(store.recent[id] ?? []), entry].slice(-RECENT_KEEP);
}

/** The topic id a schedule shows under now. */
function topicOf(env: ScheduleEnv, series: Frozen<Series>): string {
  return resolveTopicId(env.topics.doc, series.topic);
}

/** A time as the replies print it: 11-30（一）10:00 in the schedule's zone. */
function when(series: Pick<Frozen<Series>, "tz">, ms: number): string {
  return localLabel(series.tz, ms);
}

// ---------------------------------------------------------------- the aggregator's gate

interface GateNeeds {
  /** The change sets rt. */
  rt?: boolean;
  /** Only a schedule the aggregator made itself. */
  own?: boolean;
}

/** Why the aggregator may not make this change to `series`, or null. The captain always may. */
function gateProblem(
  store: Frozen<ScheduleStore>,
  env: ScheduleEnv,
  series: Frozen<Series>,
  needs: GateNeeds,
): string | null {
  if (env.actor.by === "captain") return null;
  if (series.locked)
    return `排程「${series.title}」上了鎖，${env.actor.label} 不能改；請 captain 在頁面上改或解鎖`;
  if (needs.own === true && series.by !== "aggregator")
    return `排程「${series.title}」是 captain 建的，${env.actor.label} 只能刪自己建的排程`;
  if (needs.rt === true) {
    if (series.rt_locked) return `排程「${series.title}」的 rt 上了鎖；請 captain 在頁面上改或解鎖`;
    if (!store.settings.aggregator_may_set_rt)
      return `captain 關掉了 ${env.actor.label} 設 rt；請 captain 在頁面上設`;
  }
  return null;
}

/** The hourly cap, checked once a change is known to change something. */
function capProblem(store: Frozen<ScheduleStore>, env: ScheduleEnv): string | null {
  if (env.actor.by === "captain") return null;
  const cap = store.settings.aggregator_changes_per_hour;
  return oversight.capProblem(env.records, WATCHED, Math.floor(env.nowMs / 1000), cap);
}

/** A change, unless the hourly cap refuses it. */
function capped(
  before: Frozen<ScheduleStore>,
  env: ScheduleEnv,
  result: ScheduleResult,
): ScheduleResult {
  if (!result.ok || !result.changed) return result;
  const problem = capProblem(before, env);
  return problem === null ? result : refused(problem);
}

// ---------------------------------------------------------------- the first-ring rule

/**
 * After the aggregator makes or retimes a schedule, the occurrences whose
 * first notice would ring within first_bell_min_ahead minutes are skipped in
 * advance (kept in `recent`), so a schedule cannot pull a topic to the top
 * sooner than that. The captain's changes are not held back.
 */
function holdBackFirstRing(store: ScheduleStore, id: string, env: ScheduleEnv): number {
  const series = store.series[id] as Series;
  const rule = ruleOf(series);
  const { lead, duration } = effective(series, store.settings);
  const earliestBell = env.nowMs + store.settings.first_bell_min_ahead * MINUTE_MS;
  let skipped = 0;
  for (let at = occurrenceAfter(rule, series.tz, env.nowMs - duration * MINUTE_MS); ;) {
    // One whose bell has passed would open at once, so it rings now.
    if (Math.max(at - lead * MINUTE_MS, env.nowMs) >= earliestBell) break;
    const key = occurrenceKey(id, at);
    const handled = (store.recent[id] ?? []).some((entry) => entry.key === key);
    if (!handled && store.occurrences[key] === undefined) {
      pushRecent(store, id, {
        key,
        outcome: "skipped",
        by: "board",
        note: `${env.actor.label} 建立或改時間後 ${store.settings.first_bell_min_ahead} 分鐘內不響`,
        closed_at: isoSeconds(env.nowMs),
      });
      skipped += 1;
    }
    at = occurrenceAfter(rule, series.tz, at);
  }
  return skipped;
}

/** Drops advance skips that are not occurrences of the schedule's rule any more. */
function dropStaleSkips(store: ScheduleStore, id: string): void {
  const series = store.series[id] as Series;
  const rule = ruleOf(series);
  const kept = (store.recent[id] ?? []).filter(
    (entry) => !isAdvanceSkip(entry) || isOccurrence(rule, series.tz, instantOf(entry.key)),
  );
  if (kept.length > 0) store.recent[id] = kept;
  else delete store.recent[id];
}

/** The reply's tail: the earliest occurrence, and how many the first-ring rule skipped. */
function earliestLine(
  store: Frozen<ScheduleStore>,
  id: string,
  env: ScheduleEnv,
  held: number,
): string {
  const series = store.series[id] as Frozen<Series>;
  const first = when(series, nextOccurrence(store, id, env.nowMs));
  if (held === 0) return `最快的一場是 ${first}`;
  return `${store.settings.first_bell_min_ahead} 分鐘內的 ${held} 場略過，最快的一場是 ${first}`;
}

// ---------------------------------------------------------------- input

/** What `schedule add` and `schedule edit` ask for; undefined leaves a part as it is. */
export interface ScheduleInput {
  topic: string;
  /** daily, or weekly on these days. */
  days?: "daily" | readonly Weekday[];
  at?: { hour: number; minute: number };
  tz?: string;
  duration?: number;
  lead?: number;
  rt?: Rt;
}

/** The input's problem with the ranges, or null. */
function inputProblem(input: ScheduleInput): string | null {
  if (input.tz !== undefined && !isTimeZone(input.tz))
    return `--tz 要是 IANA 時區名稱，例如 Asia/Taipei：${input.tz}`;
  if (input.duration !== undefined && !inRange(input.duration, RANGES.duration_min))
    return `--duration 要是 ${RANGES.duration_min[0]} 到 ${RANGES.duration_min[1]} 的整數（分鐘）`;
  if (input.lead !== undefined && !inRange(input.lead, RANGES.lead_min))
    return `--lead 要是 ${RANGES.lead_min[0]} 到 ${RANGES.lead_min[1]} 的整數（分鐘）；0 表示不送「快到了」`;
  return null;
}

function ruleFrom(input: ScheduleInput, current: Rule | null): Rule | null {
  const days =
    input.days ??
    (current === null ? undefined : current.kind === "daily" ? "daily" : current.days);
  const at =
    input.at ?? (current === null ? undefined : { hour: current.hour, minute: current.minute });
  if (days === undefined || at === undefined) return null;
  return days === "daily" ? { kind: "daily", ...at } : { kind: "weekly", days: [...days], ...at };
}

/** A fresh schedule id for `topic`: the topic id, else with -2, -3; never one used in series or removed. */
function mintId(store: Frozen<ScheduleStore>, topic: string): string {
  const free = (id: string): boolean =>
    store.series[id] === undefined && store.removed[id] === undefined && isValidScheduleId(id);
  if (free(topic)) return topic;
  const base = topic.slice(0, 60);
  for (let n = 2; ; n += 1) {
    if (free(`${base}-${n}`)) return `${base}-${n}`;
  }
}

/** The live topic `raw` names and its queue, or why a schedule cannot go on it. */
function laterTopic(env: ScheduleEnv, raw: string): { id: string; name: string } | string {
  const id = resolveTopicId(env.topics.doc, raw);
  const topic = env.topics.doc.topics[id];
  if (topic === undefined)
    return env.topics.archive.topics[id] === undefined
      ? `沒有 ${raw} 這個議題。用 list --all 看有哪些。`
      : `議題 ${id} 已封存，要先 reopen。`;
  if (!env.topics.doc.queues.later.includes(id))
    return `議題 ${id} 不在「${QUEUE_LABEL.later}」：先把議題移到待辦（新議題可以用 create --queue later），排程議題平常存在待辦`;
  return { id, name: topic.name };
}

// ---------------------------------------------------------------- operations

/** Whether the aggregator may make one more schedule, or why not. */
function createProblem(
  store: Frozen<ScheduleStore>,
  env: ScheduleEnv,
  input: ScheduleInput,
): string | null {
  if (env.actor.by === "captain") return null;
  const { settings } = store;
  if (!settings.aggregator_may_create)
    return `captain 關掉了 ${env.actor.label} 建立排程；請 captain 在頁面上建立`;
  const active = activeCount(store);
  if (active >= settings.max_active)
    return `啟用中的排程已有 ${active} 筆（上限 ${settings.max_active}）；captain 在頁面上仍可建立，或調高上限`;
  if (input.rt !== undefined && !settings.aggregator_may_set_rt)
    return `captain 關掉了 ${env.actor.label} 設 rt；不帶 --rt 再建一次`;
  return null;
}

/** Whether `input` asks for what `series` already is. */
function sameSchedule(series: Frozen<Series>, rule: Rule, input: ScheduleInput): boolean {
  return (
    series.rule === formatRule(rule) &&
    series.tz === (input.tz ?? series.tz) &&
    (input.duration === undefined || series.duration_min === input.duration) &&
    (input.lead === undefined || series.lead_min === input.lead) &&
    (input.rt === undefined || series.rt === input.rt)
  );
}

/**
 * Puts a schedule on a topic in 待辦. A topic has at most one schedule; the
 * same schedule again changes nothing. The captain's schedules are locked by
 * default, the aggregator's are not and wait to be seen (新).
 */
export function addSchedule(
  store: Frozen<ScheduleStore>,
  env: ScheduleEnv,
  input: ScheduleInput,
): ScheduleResult {
  const problem = inputProblem(input);
  if (problem !== null) return usage(problem);
  const rule = ruleFrom(input, null);
  if (rule === null) return usage("schedule add 需要 --daily 或 --weekly <星期>，與 --at HH:MM");
  const topic = placeFor(store, env, input, rule);
  if ("ok" in topic) return topic;
  const next = clone(store);
  const id = mintId(store, topic.id);
  next.series[id] = newSeries(store, env, input, rule, topic);
  const held = env.actor.by === "aggregator" ? holdBackFirstRing(next, id, env) : 0;
  const series = next.series[id] as Series;
  const what = `${describeRule(rule)}（${series.tz}）${RT_WORDS[series.rt]}`;
  const tail = earliestLine(next, id, env, held);
  const text = `議題「${topic.name}」加了排程：${what}，${tail}${suffix(env)}`;
  return capped(
    store,
    env,
    changed(next, `ok ${topic.id} 已排程：${what}，${tail}`, [
      record("schedule.created", store, next, id, text, topic.id),
    ]),
  );
}

/**
 * The topic a new schedule goes on, or what to answer instead: a refusal, or
 * "already there" when the topic has this very schedule.
 */
function placeFor(
  store: Frozen<ScheduleStore>,
  env: ScheduleEnv,
  input: ScheduleInput,
  rule: Rule,
): { id: string; name: string } | ScheduleResult {
  const topic = laterTopic(env, input.topic);
  if (typeof topic === "string") return refused(topic);
  const existing = scheduleOfTopic(store, env.topics, topic.id);
  if (existing !== null) {
    if (sameSchedule(existing.series, rule, input))
      return unchanged(store, `ok ${topic.id} 本來就有這筆排程：${describeRule(rule)}`);
    return refused(`議題 ${topic.id} 已經有排程；一個議題最多一筆排程，要改用 schedule edit`);
  }
  const blocked = createProblem(store, env, input);
  if (blocked !== null) return refused(blocked);
  const minutes = effective(
    { lead_min: input.lead ?? null, duration_min: input.duration ?? null },
    store.settings,
  );
  const overlap = overlapProblem(rule, minutes);
  return overlap === null ? topic : refused(overlap);
}

/** A new schedule as the asker makes it: the captain's locked by default, the aggregator's new. */
function newSeries(
  store: Frozen<ScheduleStore>,
  env: ScheduleEnv,
  input: ScheduleInput,
  rule: Rule,
  topic: { id: string; name: string },
): Series {
  const byAggregator = env.actor.by === "aggregator";
  return {
    topic: topic.id,
    title: topic.name,
    rule: formatRule(rule),
    tz: input.tz ?? store.settings.default_tz ?? env.machineZone,
    duration_min: input.duration ?? null,
    lead_min: input.lead ?? null,
    rt: input.rt ?? store.settings.default_rt,
    rt_locked: false,
    state: "on",
    locked: byAggregator ? false : store.settings.captain_locks_by_default,
    by: env.actor.by,
    ...(byAggregator ? { seen: false } : {}),
    created_at: isoSeconds(env.nowMs),
  };
}

/** The schedule on `raw`, or a refusal. */
function scheduleOn(
  store: Frozen<ScheduleStore>,
  env: ScheduleEnv,
  raw: string,
): { id: string; series: Frozen<Series> } | ScheduleResult {
  const schedule = scheduleOfTopic(store, env.topics, raw);
  if (schedule === null) return refused(`議題 ${raw} 沒有排程。`);
  return schedule;
}

/**
 * Changes a schedule's rule, time, zone, duration or lead. An open occurrence
 * is left alone and the new rule applies after it; skips made in advance that
 * the new rule no longer has are dropped. The aggregator's retime is held to
 * the first-ring rule.
 */
export function editSchedule(
  store: Frozen<ScheduleStore>,
  env: ScheduleEnv,
  input: ScheduleInput,
): ScheduleResult {
  const problem = inputProblem(input);
  if (problem !== null) return usage(problem);
  if (input.rt !== undefined) return usage("rt 用 schedule rt 改");
  const schedule = scheduleOn(store, env, input.topic);
  if ("ok" in schedule) return schedule;
  const { id, series } = schedule;
  const rule = ruleFrom(input, ruleOf(series)) as Rule;
  if (sameSchedule(series, rule, input))
    return unchanged(store, `ok ${topicOf(env, series)} 排程沒有變`);
  const gate = gateProblem(store, env, series, {});
  if (gate !== null) return refused(gate);
  const updated = edited(series, rule, input);
  const overlap = overlapProblem(rule, effective(updated, store.settings));
  if (overlap !== null) return refused(overlap);
  const next = clone(store);
  next.series[id] = updated;
  dropStaleSkips(next, id);
  const held =
    isRetime(series, updated) && env.actor.by === "aggregator"
      ? holdBackFirstRing(next, id, env)
      : 0;
  const what = `${describeRule(rule)}（${updated.tz}）`;
  const tail = earliestLine(next, id, env, held);
  const topic = topicOf(env, series);
  return capped(
    store,
    env,
    changed(next, `ok ${topic} 排程已改：${what}，${tail}`, [
      record(
        "schedule.edited",
        store,
        next,
        id,
        `排程「${series.title}」改成 ${what}，${tail}${suffix(env)}`,
        topic,
      ),
    ]),
  );
}

/** `series` with the parts `input` names changed. */
function edited(series: Frozen<Series>, rule: Rule, input: ScheduleInput): Series {
  return {
    ...(structuredClone(series) as Series),
    rule: formatRule(rule),
    tz: input.tz ?? series.tz,
    duration_min: input.duration ?? series.duration_min,
    lead_min: input.lead ?? series.lead_min,
  };
}

/** Whether an edit moves when the schedule rings: its rule, zone or lead. */
function isRetime(before: Frozen<Series>, after: Frozen<Series>): boolean {
  return before.rule !== after.rule || before.tz !== after.tz || before.lead_min !== after.lead_min;
}

/** Pauses or resumes one schedule. An open occurrence stays open: it ends at its closes_by. */
export function setPaused(
  store: Frozen<ScheduleStore>,
  env: ScheduleEnv,
  raw: string,
  paused: boolean,
): ScheduleResult {
  const schedule = scheduleOn(store, env, raw);
  if ("ok" in schedule) return schedule;
  const { id, series } = schedule;
  const topic = topicOf(env, series);
  const state: SeriesState = paused ? "paused" : "on";
  const word = paused ? "暫停" : "恢復";
  if (series.state === state)
    return unchanged(store, `ok ${topic} 排程本來就${paused ? "暫停了" : "開著"}`);
  const blocked = pauseProblem(store, env, series, paused);
  if (blocked !== null) return refused(blocked);
  const next = clone(store);
  (next.series[id] as Series).state = state;
  return capped(
    store,
    env,
    changed(next, `ok ${topic} 排程已${word}`, [
      record(
        paused ? "schedule.paused" : "schedule.resumed",
        store,
        next,
        id,
        `排程「${series.title}」已${word}${suffix(env)}`,
        topic,
      ),
    ]),
  );
}

/** Why the aggregator may not pause or resume `series`, or null. */
function pauseProblem(
  store: Frozen<ScheduleStore>,
  env: ScheduleEnv,
  series: Frozen<Series>,
  paused: boolean,
): string | null {
  const gate = gateProblem(store, env, series, {});
  if (gate !== null || paused) return gate;
  return resumeProblem(store, env, series);
}

/** Why the aggregator may not switch `series` on again, or null. */
function resumeProblem(
  store: Frozen<ScheduleStore>,
  env: ScheduleEnv,
  series: Frozen<Series>,
): string | null {
  if (env.actor.by === "captain") return null;
  if (store.settings.aggregator_needs_enable && isNew(series))
    return `排程「${series.title}」要等 captain 在頁面上按啟用`;
  const active = activeCount(store);
  if (active >= store.settings.max_active)
    return `啟用中的排程已有 ${active} 筆（上限 ${store.settings.max_active}）；請 captain 在頁面上調`;
  return null;
}

/** A skip someone asked for (skip next), as opposed to one the first-ring rule made. */
function isAskedSkip(entry: Frozen<RecentEntry>): boolean {
  return isAdvanceSkip(entry) && entry.by !== "board";
}

/**
 * Skips the schedule's next occurrence: it will not open, and the one after
 * it is next. Asking again while that skip stands changes nothing.
 */
export function skipNext(
  store: Frozen<ScheduleStore>,
  env: ScheduleEnv,
  raw: string,
): ScheduleResult {
  const schedule = scheduleOn(store, env, raw);
  if ("ok" in schedule) return schedule;
  const { id, series } = schedule;
  const recent = store.recent[id] ?? [];
  const withoutAsked = {
    ...store,
    recent: { ...store.recent, [id]: recent.filter((entry) => !isAskedSkip(entry)) },
  };
  const at = nextOccurrence(withoutAsked, id, env.nowMs);
  const key = occurrenceKey(id, at);
  const topic = topicOf(env, series);
  if (recent.some((entry) => entry.key === key && isAskedSkip(entry)))
    return unchanged(store, `ok ${topic} 本來就已跳過 ${when(series, at)} 那一場`);
  const gate = gateProblem(store, env, series, {});
  if (gate !== null) return refused(gate);
  const next = clone(store);
  pushRecent(next, id, {
    key,
    outcome: "skipped",
    by: env.actor.by,
    closed_at: isoSeconds(env.nowMs),
  });
  const after = when(series, nextOccurrence(next, id, env.nowMs));
  const text = `排程「${series.title}」跳過 ${when(series, at)} 那一場，下一場是 ${after}`;
  return capped(
    store,
    env,
    changed(next, `ok ${topic} 跳過 ${when(series, at)} 那一場，下一場是 ${after}`, [
      record("schedule.skipped", store, next, id, `${text}${suffix(env)}`, topic),
    ]),
  );
}

/** Sets the schedule's rt, which orders the 現在 strip and appears in its notices. */
export function setRt(
  store: Frozen<ScheduleStore>,
  env: ScheduleEnv,
  raw: string,
  rt: Rt,
): ScheduleResult {
  const schedule = scheduleOn(store, env, raw);
  if ("ok" in schedule) return schedule;
  const { id, series } = schedule;
  const topic = topicOf(env, series);
  if (series.rt === rt) return unchanged(store, `ok ${topic} rt 本來就是 ${rt}`);
  const gate = gateProblem(store, env, series, { rt: true });
  if (gate !== null) return refused(gate);
  const next = clone(store);
  (next.series[id] as Series).rt = rt;
  return capped(
    store,
    env,
    changed(next, `ok ${topic} rt 改為 ${rt}`, [
      record(
        "schedule.rt_changed",
        store,
        next,
        id,
        `排程「${series.title}」的 rt 從 ${series.rt} 改為 ${rt}${suffix(env)}`,
        topic,
      ),
    ]),
  );
}

/** Ends the open occurrence of schedule `id` as skipped, for a reason; nothing when none is open. */
function closeOpen(next: ScheduleStore, id: string, env: ScheduleEnv, why: string): Draft[] {
  const open = openOf(next, id);
  if (open === null) return [];
  delete next.occurrences[open.key];
  pushRecent(next, id, endedEntry(open.key, open.occurrence, "skipped", why, env));
  return [
    {
      kind: "occurrence.closed",
      topic: null,
      outcome: "skipped",
      text: `排程的 ${open.key} 那一場結束：${why}${suffix(env)}`,
    },
  ];
}

/** Drops deleted schedules kept longer than thirty days; done whenever `removed` is written. */
function forgetOldRemoved(store: ScheduleStore, nowMs: number): void {
  for (const [id, removed] of Object.entries(store.removed)) {
    if (Date.parse(removed.removed_at) < nowMs - REVERT_MS) delete store.removed[id];
  }
}

/**
 * Deletes a schedule; the topic becomes an ordinary topic in 待辦. The schedule
 * is kept for thirty days so the page can undo it. The aggregator may delete
 * only schedules it made and that are not locked.
 */
export function deleteSchedule(
  store: Frozen<ScheduleStore>,
  env: ScheduleEnv,
  raw: string,
): ScheduleResult {
  const schedule = scheduleOn(store, env, raw);
  if ("ok" in schedule) {
    const wanted = resolveTopicId(env.topics.doc, raw);
    const gone = Object.values(store.removed).some(
      (entry) => resolveTopicId(env.topics.doc, entry.topic) === wanted,
    );
    return gone ? unchanged(store, `ok ${wanted} 排程本來就已刪除`) : schedule;
  }
  const { id, series } = schedule;
  const gate = gateProblem(store, env, series, { own: true });
  if (gate !== null) return refused(gate);
  const next = clone(store);
  const topic = topicOf(env, series);
  const closed = closeOpen(next, id, env, "排程已刪除").map((draft) => ({ ...draft, topic }));
  delete next.series[id];
  forgetOldRemoved(next, env.nowMs);
  next.removed[id] = {
    ...(structuredClone(series) as Series),
    removed_at: isoSeconds(env.nowMs),
    removed_by: env.actor.by,
  };
  const text = `排程「${series.title}」已刪除，議題留在「${QUEUE_LABEL.later}」；${REVERT_DAYS} 天內可以在頁面上撤回`;
  return capped(
    store,
    env,
    changed(next, `ok ${topic} 排程已刪除`, [
      record("schedule.deleted", store, next, id, `${text}${suffix(env)}`, topic),
      ...closed,
    ]),
  );
}

/** How occurrence `key` ended, when it is no longer open and is among the last ten. */
function endedAs(store: Frozen<ScheduleStore>, key: string): string | null {
  if (Object.hasOwn(store.occurrences, key)) return null;
  const entry = Object.values(store.recent)
    .flat()
    .find((recent) => recent.key === key);
  return entry?.outcome ?? null;
}

/** The entry an occurrence leaves in the last ten when it ends; its notices go with it. */
function endedEntry(
  key: string,
  occurrence: Frozen<Occurrence>,
  outcome: string,
  note: string | undefined,
  env: ScheduleEnv,
): RecentEntry {
  const savedNote = note ?? occurrence.note;
  return {
    key,
    outcome,
    by: env.actor.by,
    ...(savedNote === undefined ? {} : { note: savedNote }),
    closed_at: isoSeconds(env.nowMs),
    ...(occurrence.notices === undefined ? {} : { notices: { ...occurrence.notices } }),
  };
}

/** The open occurrence `key` names, or a refusal. */
function openOccurrence(
  store: Frozen<ScheduleStore>,
  key: string,
): { occurrence: Frozen<Occurrence>; series: Frozen<Series> } | ScheduleResult {
  const occurrence = Object.hasOwn(store.occurrences, key) ? store.occurrences[key] : undefined;
  const series = occurrence === undefined ? undefined : store.series[occurrence.series];
  if (occurrence === undefined || series === undefined) {
    const outcome = endedAs(store, key);
    if (outcome !== null) return refused(`${key} 那一場已經結束（${outcome}）。`);
    return refused(`${key} 不是開著的一場。用 list 看開著的場次。`);
  }
  return { occurrence, series };
}

function noteOf(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  return oneLine(raw, NOTE_MAX);
}

/**
 * The aggregator's report that it took an open occurrence. Allowed on a
 * locked schedule: it is a report, not a change to the schedule. A taken
 * occurrence stays open until the aggregator closes it, at most until its
 * time plus the longest open time.
 */
export function takeOccurrence(
  store: Frozen<ScheduleStore>,
  env: ScheduleEnv,
  key: string,
  rawNote?: string,
): ScheduleResult {
  const note = noteOf(rawNote);
  if (note === null) return usage(`--note 要是一行，最多 ${NOTE_MAX} 個字`);
  const open = openOccurrence(store, key);
  if ("ok" in open) return open;
  const { occurrence, series } = open;
  if (hasEnded(occurrence, env.nowMs))
    return refused(`${key} 那一場已在 ${occurrence.closes_by} 結束。`);
  const topic = topicOf(env, series);
  if (occurrence.state === "taken" && (note === undefined || occurrence.note === note))
    return unchanged(store, `ok ${key} 本來就已接下`);
  const next = clone(store);
  const taken = takenOccurrence(occurrence, effective(series, store.settings), note, env.nowMs);
  next.occurrences[key] = taken;
  const at = Date.parse(occurrence.at);
  const said = note === undefined ? "" : `：${note}`;
  const text = `排程「${series.title}」${when(series, at)} 那一場，${env.actor.label} 接了${said}`;
  const latest = when(series, Date.parse(taken.closes_by));
  return changed(next, `ok ${key} 已接下，最晚 ${latest} 結束`, [
    { kind: "occurrence.taken", topic, text: `${text}${suffix(env)}` },
  ]);
}

/** An occurrence once taken: it stays open up to its time plus the longer of the two limits. */
function takenOccurrence(
  occurrence: Frozen<Occurrence>,
  minutes: { duration: number; maxOpen: number },
  note: string | undefined,
  nowMs: number,
): Occurrence {
  const at = Date.parse(occurrence.at);
  return {
    ...(structuredClone(occurrence) as Occurrence),
    state: "taken",
    taken_at: occurrence.taken_at ?? isoSeconds(nowMs),
    ...(note === undefined ? {} : { note }),
    closes_by: isoSeconds(at + Math.max(minutes.duration, minutes.maxOpen) * MINUTE_MS),
  };
}

/** Ends an open occurrence as done or skipped; the aggregator's report, or the captain's press. */
export function closeOccurrence(
  store: Frozen<ScheduleStore>,
  env: ScheduleEnv,
  key: string,
  outcome: CloseOutcome,
  rawNote?: string,
): ScheduleResult {
  const note = noteOf(rawNote);
  if (note === null) return usage(`--note 要是一行，最多 ${NOTE_MAX} 個字`);
  if (endedAs(store, key) === outcome)
    return unchanged(store, `ok ${key} 本來就已結束（${outcome}）`);
  const open = openOccurrence(store, key);
  if ("ok" in open) return open;
  const { occurrence, series } = open;
  const next = clone(store);
  delete next.occurrences[key];
  pushRecent(next, occurrence.series, endedEntry(key, occurrence, outcome, note, env));
  const words = outcome === "done" ? "結束" : "跳過";
  const said = note === undefined ? "" : `：${note}`;
  return changed(next, `ok ${key} 已${words}`, [
    {
      kind: "occurrence.closed",
      topic: topicOf(env, series),
      outcome,
      text: `排程「${series.title}」${when(series, Date.parse(occurrence.at))} 那一場${words}${said}${suffix(env)}`,
    },
  ]);
}

// ---------------------------------------------------------------- the captain's page only

const SETTING_LABEL: Record<Exclude<keyof Settings, "all_paused">, string> = {
  lead_min: "提前幾分鐘送第一則",
  duration_min: "時段長度",
  max_open_min: "接了之後最長開多久",
  missed: "錯過的場次",
  late_after_min: "晚多久才標「晚了」",
  aggregator_may_create: "aggregator 可以建立排程",
  aggregator_needs_enable: "aggregator 建的排程要 captain 先按啟用",
  first_bell_min_ahead: "aggregator 新建或改時間後，最快多久才響",
  captain_locks_by_default: "captain 建的排程預設上鎖",
  max_active: "啟用中的排程最多幾筆",
  aggregator_changes_per_hour: "aggregator 每小時最多改幾次排程",
  aggregator_may_set_rt: "aggregator 可以設 rt",
  default_rt: "新排程的 rt",
  default_tz: "新排程的時區",
};

type SettingName = keyof typeof SETTING_LABEL;

function isSettingName(name: string): name is SettingName {
  return Object.hasOwn(SETTING_LABEL, name);
}

type Check = (raw: unknown) => boolean;

const isMinutes =
  (range: readonly [number, number]): Check =>
  (raw) =>
    inRange(raw, range);
const isBoolean: Check = (raw) => typeof raw === "boolean";
const isZoneOrNull: Check = (raw) => raw === null || (typeof raw === "string" && isTimeZone(raw));

/** What each setting accepts, and how its refusal says so. */
const SETTING_CHECKS: Record<SettingName, { check: Check; wanted: string }> = {
  ...(Object.fromEntries(
    Object.entries(RANGES).map(([name, range]) => [
      name,
      { check: isMinutes(range), wanted: `${range[0]} 到 ${range[1]} 的整數` },
    ]),
  ) as Record<NumberSetting, { check: Check; wanted: string }>),
  ...(Object.fromEntries(
    BOOLEAN_SETTINGS.map((name) => [name, { check: isBoolean, wanted: "true 或 false" }]),
  ) as Record<(typeof BOOLEAN_SETTINGS)[number], { check: Check; wanted: string }>),
  missed: {
    check: (raw) => (MISSED_MODES as readonly unknown[]).includes(raw),
    wanted: MISSED_MODES.join("、"),
  },
  default_rt: { check: isRt, wanted: RT_VALUES.join("、") },
  default_tz: { check: isZoneOrNull, wanted: "IANA 時區名稱，或 null（這台機器的時區）" },
};

/** The settings with `changes` applied, or why one of them is not allowed. */
function nextSettings(
  current: Frozen<Settings>,
  changes: Record<string, unknown>,
): Settings | string {
  const settings: Settings = { ...current };
  for (const [name, raw] of Object.entries(changes)) {
    if (!isSettingName(name)) return `不認得的設定：${name}`;
    const { check, wanted } = SETTING_CHECKS[name];
    if (!check(raw)) return `${SETTING_LABEL[name]}要是 ${wanted}`;
    Object.assign(settings, { [name]: raw });
  }
  return settings;
}

/** Changes the captain's settings. Every schedule must still never have two occurrences open at once. */
export function updateSettings(
  store: Frozen<ScheduleStore>,
  env: ScheduleEnv,
  changes: Record<string, unknown>,
): ScheduleResult {
  const settings = nextSettings(store.settings, changes);
  if (typeof settings === "string") return usage(settings);
  const changedNames = (Object.keys(SETTING_LABEL) as SettingName[]).filter(
    (name) => settings[name] !== store.settings[name],
  );
  if (changedNames.length === 0) return unchanged(store, "ok 排程設定沒有變");
  for (const series of Object.values(store.series)) {
    const overlap = overlapProblem(ruleOf(series), effective(series, settings));
    if (overlap !== null) return refused(`排程「${series.title}」${overlap}`);
  }
  const next = clone(store);
  next.settings = settings;
  const said = changedNames
    .map(
      (name) =>
        `${SETTING_LABEL[name]} ${String(store.settings[name])} → ${String(settings[name])}`,
    )
    .join("；");
  return changed(next, "ok 排程設定已改", [
    {
      kind: "schedule.settings_changed",
      topic: null,
      before: JSON.stringify(store.settings),
      after: JSON.stringify(settings),
      text: `排程設定：${said}${suffix(env)}`,
    },
  ]);
}

/** Pauses every schedule at once, or lifts it; open occurrences stay open. */
export function setAllPaused(
  store: Frozen<ScheduleStore>,
  env: ScheduleEnv,
  paused: boolean,
): ScheduleResult {
  if (store.settings.all_paused === paused)
    return unchanged(store, `ok 排程本來就${paused ? "全部暫停了" : "沒有全部暫停"}`);
  const next = clone(store);
  next.settings.all_paused = paused;
  const text = paused ? "所有排程暫停：不開新時段、不送排程通知" : "所有排程恢復";
  return changed(next, `ok ${text}`, [
    { kind: "schedule.all_paused", topic: null, text: `${text}${suffix(env)}` },
  ]);
}

/** Locks or unlocks a schedule, or only its rt, against the aggregator's changes. */
export function setLock(
  store: Frozen<ScheduleStore>,
  env: ScheduleEnv,
  raw: string,
  which: "schedule" | "rt",
  locked: boolean,
): ScheduleResult {
  const schedule = scheduleOn(store, env, raw);
  if ("ok" in schedule) return schedule;
  const { id, series } = schedule;
  const field = which === "schedule" ? "locked" : "rt_locked";
  const what = which === "schedule" ? "排程" : "rt";
  const word = locked ? "上鎖" : "解鎖";
  const topic = topicOf(env, series);
  if (series[field] === locked) return unchanged(store, `ok ${topic} ${what}本來就已${word}`);
  const next = clone(store);
  (next.series[id] as Series)[field] = locked;
  return changed(next, `ok ${topic} ${what}已${word}`, [
    record(
      "schedule.locked",
      store,
      next,
      id,
      `排程「${series.title}」的${what}已${word}${suffix(env)}`,
      topic,
    ),
  ]);
}

/**
 * The captain has seen the aggregator's schedule changes so far: the seen
 * mark (oversight.ts) that the 最近改了 list counts from, and every schedule
 * the aggregator made is no longer 新.
 */
export function markSeen(store: Frozen<ScheduleStore>, env: ScheduleEnv): ScheduleResult {
  const unseen = oversight.unseenChanges(env.records, WATCHED).length;
  const fresh = Object.keys(store.series).filter((id) => isNew(store.series[id] as Frozen<Series>));
  if (unseen === 0 && fresh.length === 0) return unchanged(store, "ok 沒有還沒看過的排程改動");
  const next = clone(store);
  for (const id of fresh) (next.series[id] as Series).seen = true;
  const text = `看過 ${env.actor.label} 最近的排程改動（${unseen} 筆，新的排程 ${fresh.length} 筆）`;
  return changed(next, `ok ${text}`, [
    { kind: "schedule.seen", topic: null, text: `${text}${suffix(env)}` },
  ]);
}

function readSnapshot(text: string): Snapshot | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || typeof raw["id"] !== "string" || !Array.isArray(raw["skips"]))
      return null;
    const series = raw["series"] === null ? null : parseSeries(raw["series"]);
    if (raw["series"] !== null && series === null) return null;
    const skips = raw["skips"].flatMap((entry: unknown) => {
      const parsed = parseRecent(entry);
      return parsed === null ? [] : [parsed];
    });
    return { id: raw["id"], series, skips };
  } catch {
    return null;
  }
}

/** Why a schedule cannot be put back on its topic now, or null. */
function restoreProblem(
  store: Frozen<ScheduleStore>,
  env: ScheduleEnv,
  id: string,
  series: Frozen<Series>,
): string | null {
  const topic = laterTopic(env, series.topic);
  if (typeof topic === "string") return topic;
  const other = scheduleOfTopic(store, env.topics, topic.id);
  if (other !== null && other.id !== id)
    return `議題 ${topic.id} 現在有另一筆排程；先刪掉其中一筆排程`;
  return null;
}

/**
 * Takes back one of the aggregator's changes from its record (oversight.ts),
 * only while the schedule is still as that change left it; a deleted schedule
 * only while it is kept in `removed`. Taking it back again changes nothing.
 */
export function revertChange(
  store: Frozen<ScheduleStore>,
  env: ScheduleEnv,
  rid: string,
): ScheduleResult {
  const found = oversight.revertable(env.records, WATCHED, rid);
  if ("reverted" in found) return unchanged(store, `ok ${rid} 本來就已撤回`);
  if ("problem" in found) return refused(found.problem);
  const undo = undoOf(store, env, found.record, rid);
  if (typeof undo === "string") return refused(undo);
  const { before, after } = undo;
  const { id } = before;
  const next = clone(store);
  restoreSnapshot(next, before, store.series[id], env);
  const name = (before.series ?? after.series)?.title ?? id;
  const topic = before.series ?? after.series;
  const text = `排程「${name}」撤回了 ${env.actor.label} 的改動（${rid}）`;
  return changed(next, `ok 已撤回 ${rid}`, [
    {
      ...record("schedule.reverted", store, next, id, `${text}${suffix(env)}`, null),
      topic: topic === null ? null : resolveTopicId(env.topics.doc, topic.topic),
      ref: rid,
    },
  ]);
}

/**
 * The schedule on each side of the change `source` records, when it can be
 * taken back now: the schedule is still as the change left it, a deleted one
 * is still kept, and it can go back on its topic.
 */
function undoOf(
  store: Frozen<ScheduleStore>,
  env: ScheduleEnv,
  source: Frozen<ScheduleRecord>,
  rid: string,
): { before: Snapshot; after: Snapshot } | string {
  const afterText = source.after ?? "";
  const before = readSnapshot(source.before ?? "");
  const after = readSnapshot(afterText);
  if (before === null || after === null) return `紀錄 ${rid} 的改前改後讀不懂，沒有撤回。`;
  const problem = changedSince(store, before, after, afterText);
  if (problem !== null) return problem;
  const restore =
    before.series === null ? null : restoreProblem(store, env, before.id, before.series);
  return restore ?? { before, after };
}

/** Why the schedule is no longer as the change left it, or null when it is. */
function changedSince(
  store: Frozen<ScheduleStore>,
  before: Snapshot,
  after: Snapshot,
  afterText: string,
): string | null {
  if (after.id !== before.id || snapshot(store, before.id) !== afterText)
    return `排程 ${before.id} 在那之後又改過；先撤回較新的改動。`;
  if (after.series === null && store.removed[before.id] === undefined)
    return `排程 ${before.id} 刪掉已經超過 ${REVERT_DAYS} 天，不能撤回。`;
  return null;
}

/** Puts schedule `before.id` back as `before` says, with its advance skips. */
function restoreSnapshot(
  next: ScheduleStore,
  before: Snapshot,
  current: Frozen<Series> | undefined,
  env: ScheduleEnv,
): void {
  const { id } = before;
  const others = (next.recent[id] ?? []).filter((entry) => !isAdvanceSkip(entry));
  const recent = [...others, ...before.skips.map((entry) => structuredClone(entry) as RecentEntry)];
  if (recent.length > 0) next.recent[id] = recent.slice(-RECENT_KEEP);
  else delete next.recent[id];
  forgetOldRemoved(next, env.nowMs);
  if (before.series === null) {
    delete next.series[id];
    if (current !== undefined)
      next.removed[id] = {
        ...(structuredClone(current) as Series),
        removed_at: isoSeconds(env.nowMs),
        removed_by: env.actor.by,
      };
    return;
  }
  const kept =
    current === undefined
      ? {}
      : {
          ...(current.seen === undefined ? {} : { seen: current.seen }),
          ...(current.checked_through === undefined
            ? {}
            : { checked_through: current.checked_through }),
        };
  next.series[id] = { ...(structuredClone(before.series) as Series), ...kept };
  delete next.removed[id];
}

// ---------------------------------------------------------------- the queue rules

/**
 * What archiving `topic` does to its schedule: pauses it and ends an open
 * occurrence, each with a record. Null when the topic has no schedule or it
 * is already paused with nothing open.
 */
export function pauseForArchive(
  store: Frozen<ScheduleStore>,
  env: ScheduleEnv,
  topic: string,
): { store: ScheduleStore; records: [Draft, ...Draft[]] } | null {
  const schedule = scheduleOfTopic(store, env.topics, topic);
  if (schedule === null) return null;
  const { id, series } = schedule;
  if (series.state === "paused" && openOf(store, id) === null) return null;
  const next = clone(store);
  const closed = closeOpen(next, id, env, "議題已封存");
  (next.series[id] as Series).state = "paused";
  const paused =
    series.state === "paused"
      ? []
      : [
          record(
            "schedule.paused",
            store,
            next,
            id,
            `議題封存，排程「${series.title}」已暫停${suffix(env)}`,
            topic,
          ),
        ];
  const records = [...paused, ...closed.map((draft) => ({ ...draft, topic }))];
  return { store: next, records: records as [Draft, ...Draft[]] };
}
