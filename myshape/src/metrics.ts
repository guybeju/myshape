// The status metrics a home's report may carry (status-metrics.markdown,
// contracts section 4): a short list of named numbers the aggregator chose,
// such as how much of a usage window is spent and when it resets. They are
// parsed and checked once, where the report enters the service, and read here
// against the board's clock. The board only shows them: nothing it decides,
// orders or sends reads them.
import { isRecord } from "./files.js";
import { oneLine } from "./topics.js";

export const METRICS_VERSION = 1;
export const MAX_GROUPS = 16;
export const MAX_ITEMS = 64;
export const ID_MAX = 128;
export const LABEL_MAX = 80;
export const NOTE_MAX = 200;
export const UNIT_MAX = 16;
/** The largest magnitude a value other than a percentage may have. */
export const VALUE_MAX = 1e12;
/** How long a measurement counts as current, in seconds: the aggregator's word within these bounds. */
export const STALE_AFTER_S = { min: 10, max: 86_400, fallback: 900 } as const;
/** How far ahead of the board's clock a measured time may be and still count as now, in seconds. */
export const FUTURE_SKEW_S = 60;
const ID = /^[A-Za-z0-9_][A-Za-z0-9._:-]*$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export const SEVERITIES = ["normal", "warn", "critical"] as const;
/** A styling hint only: it never moves, holds or raises anything. */
export type Severity = (typeof SEVERITIES)[number];
export const GROUP_STATES = ["ok", "stale", "unavailable"] as const;
/** What the aggregator says about a group's numbers as a whole, such as one account it reads. */
export type GroupState = (typeof GROUP_STATES)[number];

export interface MetricGroup {
  id: string;
  label: string;
  state: GroupState;
  /** One line of the aggregator's about the group, such as why it has no numbers; "" for none. */
  note: string;
}

export interface Metric {
  id: string;
  /** The id of a listed group, or null for a metric in no group. */
  group: string | null;
  label: string;
  value: number;
  /** "%" for a percentage from 0 to 100; "" for none. */
  unit: string;
  resets_at: string | null;
  /** When the aggregator measured it; null when it did not say, which never reads as current. */
  measured_at: string | null;
  severity: Severity;
  /** This metric's own limit in seconds, or null for the block's. */
  stale_after_s: number | null;
}

/**
 * A report's metrics block: none, one the board cannot use (another version,
 * not an object), or the entries that passed, with how many did not.
 */
export type Metrics =
  | { kind: "none" }
  | { kind: "unreadable"; reason: string }
  | {
      kind: "ok";
      stale_after_s: number;
      groups: MetricGroup[];
      items: Metric[];
      dropped: number;
      /** Why the first left-out entry was left out, or null when none was. */
      first_drop: string | null;
    };

export const NO_METRICS: Metrics = { kind: "none" };

/** Why one entry is left out; thrown inside the entry's parse and caught by its list. */
class Dropped extends Error {}

function need(ok: boolean, why: string): void {
  if (!ok) throw new Dropped(why);
}

function idOf(raw: Record<string, unknown>, name: string): string {
  const value = raw[name];
  need(
    typeof value === "string" && value.length <= ID_MAX && ID.test(value),
    `${name} 不是合格的 id`,
  );
  return value as string;
}

/** One line of plain text within `max` code points; "" when it may be empty and is missing or empty. */
function textOf(
  raw: Record<string, unknown>,
  name: string,
  max: number,
  mayBeEmpty: boolean,
): string {
  const value = raw[name];
  if (mayBeEmpty && (value === undefined || value === "")) return "";
  const line = typeof value === "string" ? oneLine(value, max) : null;
  need(line !== null, `${name} 不是 1 到 ${max} 字的一行字`);
  return line as string;
}

function timeOf(raw: Record<string, unknown>, name: string): string | null {
  const value = raw[name];
  if (value === undefined) return null;
  need(
    typeof value === "string" && TIME.test(value) && Number.isFinite(Date.parse(value)),
    `${name} 不是 ISO 8601 的時間`,
  );
  return value as string;
}

function wordOf<T extends string>(
  raw: Record<string, unknown>,
  name: string,
  words: readonly T[],
  fallback: T,
): T {
  const value = raw[name];
  if (value === undefined) return fallback;
  const found = words.find((word) => word === value);
  need(found !== undefined, `${name} 不是 ${words.join("、")} 其中之一`);
  return found as T;
}

/** Seconds within STALE_AFTER_S: a number outside takes the nearer bound. */
function clampSeconds(value: number): number {
  return Math.min(STALE_AFTER_S.max, Math.max(STALE_AFTER_S.min, value));
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function staleAfterOf(raw: Record<string, unknown>): number | null {
  const value = raw["stale_after_s"];
  if (value === undefined) return null;
  need(isNumber(value), "stale_after_s 不是數字");
  return clampSeconds(value as number);
}

function valueOf(raw: Record<string, unknown>, unit: string): number {
  const value = raw["value"];
  need(isNumber(value), "value 不是數字");
  const number = value as number;
  if (unit === "%") need(number >= 0 && number <= 100, "百分比不在 0 到 100 之間");
  else need(Math.abs(number) <= VALUE_MAX, "value 超出範圍");
  return number;
}

function parseGroup(raw: Record<string, unknown>): MetricGroup {
  return {
    id: idOf(raw, "id"),
    label: textOf(raw, "label", LABEL_MAX, false),
    state: wordOf(raw, "state", GROUP_STATES, "ok"),
    note: textOf(raw, "note", NOTE_MAX, true),
  };
}

function groupOf(raw: Record<string, unknown>, groups: Set<string>): string | null {
  if (raw["group"] === undefined) return null;
  const group = idOf(raw, "group");
  need(groups.has(group), `group ${group} 不在 groups 裡`);
  return group;
}

function parseItem(raw: Record<string, unknown>, groups: Set<string>): Metric {
  const id = idOf(raw, "id");
  const unit = textOf(raw, "unit", UNIT_MAX, true);
  return {
    id,
    group: groupOf(raw, groups),
    label: textOf(raw, "label", LABEL_MAX, false),
    value: valueOf(raw, unit),
    unit,
    resets_at: timeOf(raw, "resets_at"),
    measured_at: timeOf(raw, "measured_at"),
    severity: wordOf(raw, "severity", SEVERITIES, "normal"),
    stale_after_s: staleAfterOf(raw),
  };
}

interface Drops {
  count: number;
  first: string | null;
}

function drop(drops: Drops, why: string): void {
  drops.count += 1;
  drops.first ??= why;
}

/** The entry `raw` parses to, or why it is left out. */
function entryOf<T>(raw: unknown, parse: (raw: Record<string, unknown>) => T): T | Dropped {
  if (!isRecord(raw)) return new Dropped("不是物件");
  try {
    return parse(raw);
  } catch (error) {
    if (error instanceof Dropped) return error;
    throw error;
  }
}

/**
 * The entries of one list that pass, in the list's order. A bad entry, one
 * past `max` and a repeated id are each left out and counted; the rest stay.
 */
function listOf<T extends { id: string }>(
  value: unknown,
  name: string,
  max: number,
  parse: (raw: Record<string, unknown>) => T,
  drops: Drops,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    drop(drops, `${name} 不是清單`);
    return [];
  }
  const kept: T[] = [];
  const seen = new Set<string>();
  value.forEach((raw: unknown, index) => {
    const where = `${name}[${index}]`;
    const entry = index < max ? entryOf(raw, parse) : new Dropped(`超過 ${max} 筆`);
    if (entry instanceof Dropped) drop(drops, `${where}：${entry.message}`);
    else if (seen.has(entry.id)) drop(drops, `${where}：id ${entry.id} 重複`);
    else {
      seen.add(entry.id);
      kept.push(entry);
    }
  });
  return kept;
}

/**
 * A report's `metrics` value, checked. A missing block (or null) is none; one
 * that is not an object or names another version is unreadable as a whole.
 * Within a block every field an entry has must pass, or that entry alone is
 * left out; fields the board does not know are ignored.
 */
export function parseMetrics(raw: unknown): Metrics {
  if (raw === undefined || raw === null) return NO_METRICS;
  if (!isRecord(raw)) return { kind: "unreadable", reason: "metrics 不是物件" };
  const version = raw["v"];
  if (version !== METRICS_VERSION) {
    const word = isNumber(version) ? String(version) : "不是數字";
    return { kind: "unreadable", reason: `格式版本是 ${word}，看板只認得 ${METRICS_VERSION}` };
  }
  const drops: Drops = { count: 0, first: null };
  const groups = listOf(raw["groups"], "groups", MAX_GROUPS, parseGroup, drops);
  const ids = new Set(groups.map((group) => group.id));
  const items = listOf(raw["items"], "items", MAX_ITEMS, (entry) => parseItem(entry, ids), drops);
  const limit = raw["stale_after_s"];
  return {
    kind: "ok",
    stale_after_s: isNumber(limit) ? clampSeconds(limit) : STALE_AFTER_S.fallback,
    groups,
    items,
    dropped: drops.count,
    first_drop: drops.first,
  };
}

/**
 * Why a metric does not read as current: its group's numbers are not good, it
 * has no measured time, its measured time is ahead of the board's clock, its
 * reset time has passed (the number stopped holding then), or it is older
 * than its limit.
 */
export type StaleWhy = "group" | "no-time" | "future" | "reset" | "old";

export interface MetricView extends Metric {
  /** Whole seconds since it was measured, or null when that is not known. */
  age_s: number | null;
  stale: StaleWhy | null;
  reset_passed: boolean;
}

export interface MetricGroupView {
  /** Null for the metrics in no group, listed after the groups. */
  id: string | null;
  label: string;
  state: GroupState;
  note: string;
  /** The soonest reset time still ahead among its metrics, or null. */
  next_reset: string | null;
  items: MetricView[];
}

/** One home's metrics as the page shows them. */
export interface HomeMetricsView {
  home: string;
  /** Why the whole block could not be used, or null. */
  problem: string | null;
  dropped: number;
  first_drop: string | null;
  groups: MetricGroupView[];
}

function staleWhy(
  item: Metric,
  state: GroupState,
  ageMs: number | null,
  nowMs: number,
  limitS: number,
): StaleWhy | null {
  if (state !== "ok") return "group";
  if (ageMs === null) return "no-time";
  if (ageMs < -FUTURE_SKEW_S * 1000) return "future";
  if (item.resets_at !== null && Date.parse(item.resets_at) <= nowMs) return "reset";
  return ageMs > (item.stale_after_s ?? limitS) * 1000 ? "old" : null;
}

/** How `item` reads at `nowMs` (epoch ms) in a group in `state`, with the block's limit `limitS`. */
export function readMetric(
  item: Metric,
  state: GroupState,
  limitS: number,
  nowMs: number,
): MetricView {
  const ageMs = item.measured_at === null ? null : nowMs - Date.parse(item.measured_at);
  const known = ageMs !== null && ageMs >= -FUTURE_SKEW_S * 1000;
  return {
    ...item,
    age_s: known ? Math.max(0, Math.floor(ageMs / 1000)) : null,
    stale: staleWhy(item, state, ageMs, nowMs, limitS),
    reset_passed: item.resets_at !== null && Date.parse(item.resets_at) <= nowMs,
  };
}

/** The soonest of the metrics' reset times that is still after `nowMs`, or null. */
export function nextReset(items: Metric[], nowMs: number): string | null {
  let soonest: string | null = null;
  let soonestMs = Number.POSITIVE_INFINITY;
  for (const item of items) {
    if (item.resets_at === null) continue;
    const at = Date.parse(item.resets_at);
    if (at > nowMs && at < soonestMs) {
      soonest = item.resets_at;
      soonestMs = at;
    }
  }
  return soonest;
}

function groupView(group: MetricGroup | null, items: MetricView[], nowMs: number): MetricGroupView {
  return {
    id: group?.id ?? null,
    label: group?.label ?? "",
    state: group?.state ?? "ok",
    note: group?.note ?? "",
    next_reset: nextReset(items, nowMs),
    items,
  };
}

/**
 * One home's metrics at `nowMs`, or null when its report has none. Groups keep
 * the report's order, each with its metrics in the report's order, and the
 * metrics in no group come last; the board orders nothing by a value.
 */
export function homeMetrics(home: string, metrics: Metrics, nowMs: number): HomeMetricsView | null {
  if (metrics.kind === "none") return null;
  if (metrics.kind === "unreadable")
    return { home, problem: metrics.reason, dropped: 0, first_drop: null, groups: [] };
  const read = (item: Metric, state: GroupState): MetricView =>
    readMetric(item, state, metrics.stale_after_s, nowMs);
  const groups = metrics.groups.map((group) =>
    groupView(
      group,
      metrics.items
        .filter((item) => item.group === group.id)
        .map((item) => read(item, group.state)),
      nowMs,
    ),
  );
  const loose = metrics.items.filter((item) => item.group === null).map((item) => read(item, "ok"));
  if (loose.length > 0) groups.push(groupView(null, loose, nowMs));
  return { home, problem: null, dropped: metrics.dropped, first_drop: metrics.first_drop, groups };
}

/** Every home's metrics at `nowMs`, in the homes' order, leaving out the homes with none. */
export function boardMetrics(
  homes: { id: string; metrics: Metrics | null }[],
  nowMs: number,
): HomeMetricsView[] {
  const views: HomeMetricsView[] = [];
  for (const home of homes) {
    const view = home.metrics === null ? null : homeMetrics(home.id, home.metrics, nowMs);
    if (view !== null) views.push(view);
  }
  return views;
}

/**
 * What changes on the page with time alone: whether each metric reads as
 * current and whether its reset has passed. The page's version carries it, as
 * it carries each home's staleness, since no read announces such a change.
 */
export function metricFlags(views: HomeMetricsView[]): string[] {
  return views.flatMap((view) =>
    view.groups.flatMap((group) =>
      group.items.map(
        (item) => `${view.home}\t${item.id}\t${item.stale ?? ""}\t${item.reset_passed ? 1 : 0}`,
      ),
    ),
  );
}
