// What the page shows of the schedules (schedules.json): the 現在 strip of
// open occurrences in the order the board publishes them, one card per
// schedule with its next occurrences and its last ten, the settings with
// their defaults and ranges, and the aggregator's recent schedule changes.
// Local times are worked out here, since page scripts cannot load the time
// maths. Pure: the service passes the store, the topics, the records and now.
import * as oversight from "./oversight.js";
import type { RecentChange } from "./oversight.js";
import type { Frozen } from "./records.js";
import { rings } from "./schedule-clock.js";
import { describeRule, localLabel, occurrenceAfter } from "./schedule-time.js";
import type { Weekday } from "./schedule-time.js";
import {
  DEFAULT_SETTINGS,
  MISSED_MODES,
  RANGES,
  RT_VALUES,
  WATCHED,
  activeCount,
  effective,
  hasEnded,
  instantOf,
  isNew,
  nextOccurrence,
  ruleOf,
} from "./schedules.js";
import type {
  MissedMode,
  OccurrenceState,
  RecentEntry,
  Rt,
  ScheduleRecord,
  ScheduleStore,
  Series,
  Settings,
} from "./schedules.js";
import { resolveTopicId } from "./topics.js";
import type { TopicState } from "./topics.js";

/** How many coming occurrences a schedule's card lists. */
export const NEXT_SHOWN = 3;

/** An open occurrence in the 現在 strip. Times are epoch milliseconds, `local` is in the schedule's zone. */
export interface NowEntry {
  key: string;
  series: string;
  topic: string;
  title: string;
  at: number;
  local: string;
  state: OccurrenceState;
  rt: Rt;
  taken_at: number | null;
  taken_local: string | null;
  note: string | null;
  closes_by: number;
  closes_local: string;
}

/** One of a schedule's last ten occurrences, as a cell of its record strip. */
export interface StripCell {
  key: string;
  local: string;
  outcome: string;
  by: string;
  /** A skip saved before the occurrence's time: asked for, or the board holding back a too-early first ring. */
  advance: boolean;
  note: string | null;
  closed_at: number | null;
  /** How many occurrences a missed entry stands for, when more than one. */
  count: number | null;
}

/** One schedule as its card and its topic page show it. */
export interface ScheduleCard {
  id: string;
  /** The topic it is on now, merges followed. */
  topic: string;
  title: string;
  rule_text: string;
  /** The rule's days and time, for the edit form. */
  days: "daily" | Weekday[];
  at: string;
  tz: string;
  /** The schedule's own lead and duration, or null when the settings decide them. */
  lead_min: number | null;
  duration_min: number | null;
  lead: number;
  duration: number;
  rt: Rt;
  rt_locked: boolean;
  locked: boolean;
  state: Series["state"];
  by: Series["by"];
  /** Made by the aggregator and not yet seen by the captain. */
  new: boolean;
  /** Waits for the captain's 啟用 before it rings (aggregator_needs_enable). */
  awaiting_enable: boolean;
  /** Whether the clock rings for it now. */
  rings: boolean;
  next: { at: number; local: string }[];
  /** The key of its open occurrence, or null. */
  open: string | null;
  /** Newest first. */
  strip: StripCell[];
}

export interface ScheduleView {
  settings: Settings;
  defaults: Settings;
  ranges: typeof RANGES;
  missed_modes: readonly MissedMode[];
  rt_values: readonly Rt[];
  /** How many schedules are switched on. */
  active: number;
  series: ScheduleCard[];
  now: NowEntry[];
  /** The aggregator's schedule changes since the captain last marked them seen, newest first. */
  recent: RecentChange[];
}

const RT_RANK: Record<Rt, number> = { "hard-rt": 0, "soft-rt": 1, none: 2 };

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function msOrNull(text: string | undefined): number | null {
  return text === undefined ? null : Date.parse(text);
}

/** The order of the 現在 strip: hard-rt, then soft-rt, then none, then by time. */
export function nowOrder(a: Pick<NowEntry, "rt" | "at">, b: Pick<NowEntry, "rt" | "at">): number {
  return RT_RANK[a.rt] - RT_RANK[b.rt] || a.at - b.at;
}

/**
 * The keys of the occurrences open at `nowMs`, sorted. An occurrence past its
 * closes_by counts as ended even while the file still holds it, so the
 * page's version changes when one ends without the clock saving anything.
 */
export function openKeys(store: Frozen<ScheduleStore>, nowMs: number): string[] {
  return Object.entries(store.occurrences)
    .filter(([, occurrence]) => !hasEnded(occurrence, nowMs))
    .map(([key]) => key)
    .toSorted();
}

function nowEntries(
  store: Frozen<ScheduleStore>,
  topics: Frozen<TopicState>,
  nowMs: number,
): NowEntry[] {
  const entries: NowEntry[] = [];
  for (const key of openKeys(store, nowMs)) {
    const occurrence = store.occurrences[key];
    const series = occurrence === undefined ? undefined : store.series[occurrence.series];
    if (occurrence === undefined || series === undefined) continue;
    const at = Date.parse(occurrence.at);
    const takenAt = msOrNull(occurrence.taken_at);
    const closesBy = Date.parse(occurrence.closes_by);
    entries.push({
      key,
      series: occurrence.series,
      topic: resolveTopicId(topics.doc, series.topic),
      title: series.title,
      at,
      local: localLabel(series.tz, at),
      state: occurrence.state,
      rt: series.rt,
      taken_at: takenAt,
      taken_local: takenAt === null ? null : localLabel(series.tz, takenAt),
      note: occurrence.note ?? null,
      closes_by: closesBy,
      closes_local: localLabel(series.tz, closesBy),
    });
  }
  return entries.toSorted(nowOrder);
}

function stripCell(series: Frozen<Series>, entry: Frozen<RecentEntry>): StripCell {
  const at = instantOf(entry.key);
  const closedAt = msOrNull(entry.closed_at);
  return {
    key: entry.key,
    local: Number.isFinite(at) ? localLabel(series.tz, at) : entry.key,
    outcome: entry.outcome,
    by: entry.by,
    advance: entry.outcome === "skipped" && closedAt !== null && closedAt < at,
    note: entry.note ?? null,
    closed_at: closedAt,
    count: entry.count ?? null,
  };
}

/** The next `NEXT_SHOWN` occurrences the schedule would open, in its zone. */
function nextOf(store: Frozen<ScheduleStore>, id: string, nowMs: number): ScheduleCard["next"] {
  const series = store.series[id] as Frozen<Series>;
  const rule = ruleOf(series);
  const next: ScheduleCard["next"] = [];
  let at = nextOccurrence(store, id, nowMs);
  while (next.length < NEXT_SHOWN) {
    next.push({ at, local: localLabel(series.tz, at) });
    at = occurrenceAfter(rule, series.tz, at);
  }
  return next;
}

function openOf(store: Frozen<ScheduleStore>, id: string, nowMs: number): string | null {
  return openKeys(store, nowMs).find((key) => store.occurrences[key]?.series === id) ?? null;
}

function card(
  store: Frozen<ScheduleStore>,
  topics: Frozen<TopicState>,
  id: string,
  nowMs: number,
): ScheduleCard {
  const series = store.series[id] as Frozen<Series>;
  const rule = ruleOf(series);
  const { lead, duration } = effective(series, store.settings);
  const fresh = isNew(series);
  return {
    id,
    topic: resolveTopicId(topics.doc, series.topic),
    title: series.title,
    rule_text: describeRule(rule),
    days: rule.kind === "daily" ? "daily" : [...rule.days],
    at: `${pad(rule.hour)}:${pad(rule.minute)}`,
    tz: series.tz,
    lead_min: series.lead_min,
    duration_min: series.duration_min,
    lead,
    duration,
    rt: series.rt,
    rt_locked: series.rt_locked,
    locked: series.locked,
    state: series.state,
    by: series.by,
    new: fresh,
    awaiting_enable: store.settings.aggregator_needs_enable && fresh,
    rings: rings(store, series),
    next: nextOf(store, id, nowMs),
    open: openOf(store, id, nowMs),
    strip: (store.recent[id] ?? []).map((entry) => stripCell(series, entry)).toReversed(),
  };
}

/** What the page shows of the schedules. `records` are the board's saved records, oldest first. */
export function scheduleView(
  store: Frozen<ScheduleStore>,
  topics: Frozen<TopicState>,
  records: readonly (ScheduleRecord & { topic?: string | null; text?: string })[],
  nowMs: number,
): ScheduleView {
  const ids = Object.keys(store.series).toSorted();
  return {
    settings: { ...store.settings },
    defaults: { ...DEFAULT_SETTINGS },
    ranges: RANGES,
    missed_modes: MISSED_MODES,
    rt_values: RT_VALUES,
    active: activeCount(store),
    series: ids.map((id) => card(store, topics, id, nowMs)),
    now: nowEntries(store, topics, nowMs),
    recent: oversight.recentChanges(records, WATCHED),
  };
}
