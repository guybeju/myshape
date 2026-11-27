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
/**
 * How long a measurement counts as current, in seconds: the aggregator's
 * word, within these bounds.
 */
export const STALE_AFTER_S = { min: 10, max: 86_400, fallback: 900 };
/** How far ahead of the board's clock a measured time may be and still count as now, in seconds. */
export const FUTURE_SKEW_S = 60;
const ID = /^[A-Za-z0-9_][A-Za-z0-9._:-]*$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
export const SEVERITIES = ["normal", "warn", "critical"];
export const GROUP_STATES = ["ok", "stale", "unavailable"];
export const NO_METRICS = { kind: "none" };
/** Why one entry is left out; thrown inside the entry's parse and caught by its list. */
class Dropped extends Error {
}
function need(ok, why) {
    if (!ok)
        throw new Dropped(why);
}
function idOf(raw, name) {
    const value = raw[name];
    need(typeof value === "string" && value.length <= ID_MAX && ID.test(value), `${name} 不是合格的 id`);
    return value;
}
/**
 * One line of plain text within `max` code points; "" when it may be empty
 * and is missing or empty.
 */
function textOf(raw, name, max, mayBeEmpty) {
    const value = raw[name];
    if (mayBeEmpty && (value === undefined || value === ""))
        return "";
    const line = typeof value === "string" ? oneLine(value, max) : null;
    need(line !== null, `${name} 不是 1 到 ${max} 字的一行字`);
    return line;
}
function timeOf(raw, name) {
    const value = raw[name];
    if (value === undefined)
        return null;
    need(typeof value === "string" && TIME.test(value) && Number.isFinite(Date.parse(value)), `${name} 不是 ISO 8601 的時間`);
    return value;
}
function wordOf(raw, name, words, fallback) {
    const value = raw[name];
    if (value === undefined)
        return fallback;
    const found = words.find((word) => word === value);
    need(found !== undefined, `${name} 不是 ${words.join("、")} 其中之一`);
    return found;
}
/** Seconds within STALE_AFTER_S: a number outside takes the nearer bound. */
function clampSeconds(value) {
    return Math.min(STALE_AFTER_S.max, Math.max(STALE_AFTER_S.min, value));
}
function isNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}
function staleAfterOf(raw, blockS) {
    const value = raw["stale_after_s"];
    if (value === undefined)
        return blockS;
    need(isNumber(value), "stale_after_s 不是數字");
    return clampSeconds(value);
}
function valueOf(raw, unit) {
    const value = raw["value"];
    need(isNumber(value), "value 不是數字");
    const number = value;
    if (unit === "%")
        need(number >= 0 && number <= 100, "百分比不在 0 到 100 之間");
    else
        need(Math.abs(number) <= VALUE_MAX, "value 超出範圍");
    return number;
}
function parseGroup(raw) {
    return {
        id: idOf(raw, "id"),
        label: textOf(raw, "label", LABEL_MAX, false),
        state: wordOf(raw, "state", GROUP_STATES, "ok"),
        note: textOf(raw, "note", NOTE_MAX, true),
    };
}
function groupOf(raw, groups) {
    if (raw["group"] === undefined)
        return null;
    const group = idOf(raw, "group");
    need(groups.has(group), `group ${group} 不在 groups 裡`);
    return group;
}
function parseItem(raw, groups, blockS) {
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
        stale_after_s: staleAfterOf(raw, blockS),
    };
}
function drop(drops, why) {
    drops.count += 1;
    drops.first ??= why;
}
/** The entry `raw` parses to, or why it is left out. */
function entryOf(raw, parse) {
    if (!isRecord(raw))
        return new Dropped("不是物件");
    try {
        return parse(raw);
    }
    catch (error) {
        if (error instanceof Dropped)
            return error;
        throw error;
    }
}
/**
 * The entries of one list that pass, in the list's order. A bad entry, one
 * past `max` and a repeated id are each left out and counted; the rest stay.
 */
function listOf(value, name, max, parse, drops) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value)) {
        drop(drops, `${name} 不是清單`);
        return [];
    }
    const kept = [];
    const seen = new Set();
    value.forEach((raw, index) => {
        const where = `${name}[${index}]`;
        const entry = index < max ? entryOf(raw, parse) : new Dropped(`超過 ${max} 筆`);
        if (entry instanceof Dropped)
            drop(drops, `${where}：${entry.message}`);
        else if (seen.has(entry.id))
            drop(drops, `${where}：id ${entry.id} 重複`);
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
export function parseMetrics(raw) {
    if (raw === undefined || raw === null)
        return NO_METRICS;
    if (!isRecord(raw))
        return { kind: "unreadable", reason: "metrics 不是物件" };
    const version = raw["v"];
    if (version !== METRICS_VERSION) {
        const word = isNumber(version) ? String(version) : "不是數字";
        return { kind: "unreadable", reason: `格式版本是 ${word}，看板只認得 ${METRICS_VERSION}` };
    }
    const drops = { count: 0, first: null };
    const groups = listOf(raw["groups"], "groups", MAX_GROUPS, parseGroup, drops);
    const ids = new Set(groups.map((group) => group.id));
    const limit = raw["stale_after_s"];
    const blockS = isNumber(limit) ? clampSeconds(limit) : STALE_AFTER_S.fallback;
    const parse = (entry) => parseItem(entry, ids, blockS);
    const items = listOf(raw["items"], "items", MAX_ITEMS, parse, drops);
    return {
        kind: "ok",
        stale_after_s: blockS,
        groups,
        items,
        dropped: drops.count,
        first_drop: drops.first,
    };
}
function staleWhy(item, state, ageMs, nowMs) {
    if (state !== "ok")
        return "group";
    if (ageMs === null)
        return "no-time";
    if (ageMs < -FUTURE_SKEW_S * 1000)
        return "future";
    if (item.resets_at !== null && Date.parse(item.resets_at) <= nowMs)
        return "reset";
    return ageMs > item.stale_after_s * 1000 ? "old" : null;
}
/** How `item` reads at `nowMs` (epoch ms) in a group in `state`. */
export function readMetric(item, state, nowMs) {
    const ageMs = item.measured_at === null ? null : nowMs - Date.parse(item.measured_at);
    const known = ageMs !== null && ageMs >= -FUTURE_SKEW_S * 1000;
    return {
        ...item,
        age_s: known ? Math.max(0, Math.floor(ageMs / 1000)) : null,
        stale: staleWhy(item, state, ageMs, nowMs),
        reset_passed: item.resets_at !== null && Date.parse(item.resets_at) <= nowMs,
    };
}
/** The soonest of the metrics' reset times that is still after `nowMs`, or null. */
export function nextReset(items, nowMs) {
    let soonest = null;
    let soonestMs = Number.POSITIVE_INFINITY;
    for (const item of items) {
        if (item.resets_at === null)
            continue;
        const at = Date.parse(item.resets_at);
        if (at > nowMs && at < soonestMs) {
            soonest = item.resets_at;
            soonestMs = at;
        }
    }
    return soonest;
}
/** Where the metrics in no group are listed: after the groups, untitled. */
const NO_GROUP = { id: null, label: "", state: "ok", note: "" };
function groupView(group, items, nowMs) {
    return { ...group, next_reset: nextReset(items, nowMs), items };
}
/**
 * One home's metrics at `nowMs`, or null when its report has none. Groups keep
 * the report's order, each with its metrics in the report's order, and the
 * metrics in no group come last; the board orders nothing by a value.
 */
export function homeMetrics(home, metrics, nowMs) {
    if (metrics.kind === "none")
        return null;
    if (metrics.kind === "unreadable")
        return { home, problem: metrics.reason, dropped: 0, first_drop: null, groups: [] };
    const read = (item, state) => readMetric(item, state, nowMs);
    const groups = metrics.groups.map((group) => groupView(group, metrics.items
        .filter((item) => item.group === group.id)
        .map((item) => read(item, group.state)), nowMs));
    const loose = metrics.items.filter((item) => item.group === null).map((item) => read(item, "ok"));
    if (loose.length > 0)
        groups.push(groupView(NO_GROUP, loose, nowMs));
    return { home, problem: null, dropped: metrics.dropped, first_drop: metrics.first_drop, groups };
}
/** Every home's metrics at `nowMs`, in the homes' order, leaving out the homes with none. */
export function boardMetrics(homes, nowMs) {
    const views = [];
    for (const home of homes) {
        const view = home.metrics === null ? null : homeMetrics(home.id, home.metrics, nowMs);
        if (view !== null)
            views.push(view);
    }
    return views;
}
/**
 * What changes on the page with time alone: whether each metric reads as
 * current and whether its reset has passed. The page's version carries it, as
 * it carries each home's staleness, since no read announces such a change.
 */
export function metricFlags(views) {
    return views.flatMap((view) => view.groups.flatMap((group) => group.items.map((item) => JSON.stringify([view.home, item.id, item.stale, item.reset_passed]))));
}
