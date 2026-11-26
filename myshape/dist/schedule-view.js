// What the page shows of the schedules (schedules.json): the 現在 strip of
// open occurrences in the order the board publishes them, one card per
// schedule with its next occurrences and its last ten, the settings with
// their defaults and ranges, and the aggregator's recent schedule changes.
// Local times are worked out here, since page scripts cannot load the time
// maths. Pure: the service passes the store, the topics, the records and now.
import * as oversight from "./oversight.js";
import { rings } from "./schedule-clock.js";
import { describeRule, localLabel, occurrenceAfter } from "./schedule-time.js";
import { DEFAULT_SETTINGS, MISSED_MODES, RANGES, RT_VALUES, WATCHED, activeCount, effective, hasEnded, instantOf, isNew, nextOccurrence, ruleOf, } from "./schedules.js";
import { resolveTopicId } from "./topics.js";
/** How many coming occurrences a schedule's card lists. */
export const NEXT_SHOWN = 3;
const RT_RANK = { "hard-rt": 0, "soft-rt": 1, none: 2 };
function pad(value) {
    return String(value).padStart(2, "0");
}
function msOrNull(text) {
    return text === undefined ? null : Date.parse(text);
}
/** The order of the 現在 strip: hard-rt, then soft-rt, then none, then by time. */
export function nowOrder(a, b) {
    return RT_RANK[a.rt] - RT_RANK[b.rt] || a.at - b.at;
}
/**
 * The keys of the occurrences open at `nowMs`, sorted. An occurrence past its
 * closes_by counts as ended even while the file still holds it, so the
 * page's version changes when one ends without the clock saving anything.
 */
export function openKeys(store, nowMs) {
    return Object.entries(store.occurrences)
        .filter(([, occurrence]) => !hasEnded(occurrence, nowMs))
        .map(([key]) => key)
        .toSorted();
}
function nowEntries(store, topics, nowMs) {
    const entries = [];
    for (const key of openKeys(store, nowMs)) {
        const occurrence = store.occurrences[key];
        const series = occurrence === undefined ? undefined : store.series[occurrence.series];
        if (occurrence === undefined || series === undefined)
            continue;
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
function stripCell(series, entry) {
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
function nextOf(store, id, nowMs) {
    const series = store.series[id];
    const rule = ruleOf(series);
    const next = [];
    let at = nextOccurrence(store, id, nowMs);
    while (next.length < NEXT_SHOWN) {
        next.push({ at, local: localLabel(series.tz, at) });
        at = occurrenceAfter(rule, series.tz, at);
    }
    return next;
}
function openOf(store, id, nowMs) {
    return openKeys(store, nowMs).find((key) => store.occurrences[key]?.series === id) ?? null;
}
function card(store, topics, id, nowMs) {
    const series = store.series[id];
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
export function scheduleView(store, topics, records, nowMs) {
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
