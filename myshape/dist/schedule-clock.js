import { isoSeconds, localLabel, occurrenceAfter, occurrenceKey } from "./schedule-time.js";
import { clockNotice, missedNotice, noticeId } from "./schedule-notices.js";
import { effective, hasEnded, instantOf, isNew, pushRecent, restartCount, ruleOf, } from "./schedules.js";
import { resolveTopicId } from "./topics.js";
/** How often the service runs the clock. */
export const TICK_MS = 30_000;
const MINUTE_MS = 60_000;
/**
 * Whether the clock rings for `series` now: it is on, not everything is
 * paused, and it does not wait for the captain's enable.
 */
export function rings(store, series) {
    const { settings } = store;
    if (series.state !== "on" || settings.all_paused)
        return false;
    return !(settings.aggregator_needs_enable && isNew(series));
}
function topicOf(work, seriesId) {
    const series = work.next.series[seriesId] ?? work.next.removed[seriesId];
    return series === undefined ? seriesId : resolveTopicId(work.env.topics.doc, series.topic);
}
function when(series, ms) {
    return series === undefined ? isoSeconds(ms) : localLabel(series.tz, ms);
}
function titleOf(series, seriesId) {
    return series?.title ?? seriesId;
}
/** Ends an open occurrence at its closes_by: nobody took it, or the taker never closed it. */
function endByTime(work, key, occurrence) {
    const series = work.next.series[occurrence.series];
    const taken = occurrence.state === "taken";
    const outcome = taken ? "timed_out" : "untaken";
    const words = taken ? "逾時結束" : "沒有人接（時間到）";
    delete work.next.occurrences[key];
    const entry = {
        key,
        outcome,
        by: "board",
        note: taken && occurrence.note !== undefined ? occurrence.note : words,
        closed_at: isoSeconds(work.env.nowMs),
        ...(occurrence.notices === undefined ? {} : { notices: { ...occurrence.notices } }),
    };
    pushRecent(work.next, occurrence.series, entry);
    work.records.push({
        kind: "occurrence.closed",
        topic: topicOf(work, occurrence.series),
        outcome,
        text: `排程「${titleOf(series, occurrence.series)}」${when(series, Date.parse(occurrence.at))} 那一場${words}`,
    });
    work.touched.add(occurrence.series);
    work.counts.closed += 1;
}
/** Makes an upcoming occurrence due at its time, with its due notice unless the schedule is silent. */
function makeDue(work, key, occurrence) {
    const series = work.next.series[occurrence.series];
    const atMs = Date.parse(occurrence.at);
    occurrence.state = "due";
    const loud = series !== undefined && rings(work.next, series);
    if (loud) {
        occurrence.notices = {
            ...occurrence.notices,
            start: noticeId(occurrence.series, atMs, "start"),
        };
        work.fresh.push(startNotice(work, key, occurrence, atMs));
    }
    const silent = loud ? "" : "（排程暫停中，沒有送通知）";
    work.records.push({
        kind: "occurrence.due",
        topic: topicOf(work, occurrence.series),
        text: `排程「${titleOf(series, occurrence.series)}」${when(series, atMs)} 那一場時間到了${silent}`,
    });
    work.touched.add(occurrence.series);
}
function startNotice(work, key, occurrence, dueMs) {
    return clockNotice(work.next, work.env.topics, { series: occurrence.series, key, atMs: Date.parse(occurrence.at), phase: "start" }, { nowMs: work.env.nowMs, dueMs, expiresMs: Date.parse(occurrence.closes_by) });
}
/** Ends what has run out and makes due what has come; an occurrence taken before its time stays taken. */
function advanceOpen(work) {
    for (const [key, occurrence] of Object.entries(work.next.occurrences)) {
        if (hasEnded(occurrence, work.env.nowMs))
            endByTime(work, key, occurrence);
        else if (occurrence.state === "upcoming" && Date.parse(occurrence.at) <= work.env.nowMs)
            makeDue(work, key, occurrence);
    }
}
/**
 * The instant after which the clock looks for occurrences of `seriesId`: how
 * far it had checked (or when the schedule was made), and never before an
 * occurrence already handled, so a clock that went back reopens nothing.
 */
function scanBase(store, seriesId, series) {
    const marks = [Date.parse(series.checked_through ?? series.created_at)];
    for (const entry of store.recent[seriesId] ?? [])
        marks.push(instantOf(entry.key));
    return Math.max(...marks.filter(Number.isFinite));
}
function findDue(store, seriesId, nowMs) {
    const series = store.series[seriesId];
    const rule = ruleOf(series);
    const { lead, duration } = effective(series, store.settings);
    const handled = new Set((store.recent[seriesId] ?? []).map((entry) => entry.key));
    const found = { inWindow: null, missed: [] };
    for (let at = occurrenceAfter(rule, series.tz, scanBase(store, seriesId, series)); at - lead * MINUTE_MS <= nowMs; at = occurrenceAfter(rule, series.tz, at)) {
        if (handled.has(occurrenceKey(seriesId, at)))
            continue;
        if (nowMs < at + duration * MINUTE_MS)
            found.inWindow = at;
        else
            found.missed.push(at);
    }
    return found;
}
/**
 * Opens occurrence `atMs` now: coming up before its time, due after it. Its
 * notice is due from the later of its moment and `sinceMs`, so one that
 * opens late says how late. `closesMs` is when it ends if nobody takes it.
 */
function open(work, seriesId, atMs, sinceMs, closesMs) {
    const series = work.next.series[seriesId];
    const { lead } = effective(series, work.next.settings);
    const { nowMs } = work.env;
    const key = occurrenceKey(seriesId, atMs);
    const upcoming = nowMs < atMs;
    const phase = upcoming ? "pre" : "start";
    const occurrence = {
        series: seriesId,
        at: isoSeconds(atMs),
        state: upcoming ? "upcoming" : "due",
        opened_at: isoSeconds(nowMs),
        closes_by: isoSeconds(closesMs),
        notices: { [phase]: noticeId(seriesId, atMs, phase) },
    };
    work.next.occurrences[key] = occurrence;
    const moment = upcoming ? atMs - lead * MINUTE_MS : atMs;
    const dueMs = Math.max(moment, sinceMs);
    work.fresh.push(upcoming
        ? clockNotice(work.next, work.env.topics, { series: seriesId, key, atMs, phase: "pre" }, { nowMs, dueMs, expiresMs: atMs })
        : startNotice(work, key, occurrence, dueMs));
    const what = upcoming ? "快到了" : "時間到了";
    work.records.push({
        kind: "occurrence.opened",
        topic: topicOf(work, seriesId),
        text: `排程「${series.title}」${when(series, atMs)} 那一場開了：${what}`,
    });
    work.touched.add(seriesId);
    work.counts.opened += 1;
}
/**
 * Records occurrences whose window passed while the board was not running,
 * as one entry for the latest that counts the others. `notice` says whether
 * the latest gets its missed notice.
 */
function recordMissed(work, seriesId, missed, notice) {
    const latest = missed[missed.length - 1];
    const first = missed[0];
    if (latest === undefined || first === undefined)
        return;
    const series = work.next.series[seriesId];
    const key = occurrenceKey(seriesId, latest);
    const entry = {
        key,
        outcome: "missed",
        by: "board",
        closed_at: isoSeconds(work.env.nowMs),
        ...(notice ? { notice: noticeId(seriesId, latest, "missed") } : {}),
        ...(missed.length > 1
            ? { count: missed.length, from: isoSeconds(first), to: isoSeconds(latest) }
            : {}),
    };
    pushRecent(work.next, seriesId, entry);
    if (notice)
        work.fresh.push(missedNotice(work.next, work.env.topics, { series: seriesId, key, atMs: latest }));
    const span = missed.length > 1
        ? `錯過 ${missed.length} 場（${when(series, first)} 到 ${when(series, latest)}）`
        : `${when(series, latest)} 那一場錯過了`;
    work.records.push({
        kind: "occurrence.missed",
        topic: topicOf(work, seriesId),
        outcome: "missed",
        text: `排程「${series.title}」${span}：看板當時沒在跑${notice ? "" : "，只記下來"}`,
    });
    work.touched.add(seriesId);
    work.counts.missed += missed.length;
}
/**
 * Looks for occurrences of one ringing schedule with nothing open. The latest
 * still inside its window opens as usual, and the ones before it are only
 * recorded. When none is, the latest missed is handled as the captain's
 * `missed` setting says: a missed notice, only a record, or reopened now as
 * due with a late due notice.
 */
function openOrMiss(work, seriesId) {
    const series = work.next.series[seriesId];
    const { duration } = effective(series, work.next.settings);
    const { nowMs } = work.env;
    const since = scanBase(work.next, seriesId, series);
    const found = findDue(work.next, seriesId, nowMs);
    if (found.inWindow !== null) {
        recordMissed(work, seriesId, found.missed, false);
        open(work, seriesId, found.inWindow, since, found.inWindow + duration * MINUTE_MS);
        return;
    }
    const mode = work.next.settings.missed;
    if (mode !== "due") {
        recordMissed(work, seriesId, found.missed, mode === "notice");
        return;
    }
    const latest = found.missed.pop();
    recordMissed(work, seriesId, found.missed, false);
    if (latest !== undefined)
        open(work, seriesId, latest, latest, nowMs + duration * MINUTE_MS);
}
function hasOpen(store, seriesId) {
    return Object.values(store.occurrences).some((occurrence) => occurrence.series === seriesId);
}
/** The notices the store says were handed over and may still be wanted, built again. */
function recorded(store, env) {
    const notices = [];
    for (const [key, occurrence] of Object.entries(store.occurrences)) {
        const series = store.series[occurrence.series];
        if (series === undefined || !rings(store, series))
            continue;
        const atMs = Date.parse(occurrence.at);
        const { lead } = effective(series, store.settings);
        const base = { series: occurrence.series, key, atMs };
        if (occurrence.notices?.["pre"] !== undefined)
            notices.push(clockNotice(store, env.topics, { ...base, phase: "pre" }, {
                nowMs: env.nowMs,
                dueMs: atMs - lead * MINUTE_MS,
                expiresMs: atMs,
            }));
        if (occurrence.notices?.["start"] !== undefined)
            notices.push(clockNotice(store, env.topics, { ...base, phase: "start" }, {
                nowMs: env.nowMs,
                dueMs: atMs,
                expiresMs: Date.parse(occurrence.closes_by),
            }));
    }
    return [...notices, ...recordedMissed(store, env)];
}
function recordedMissed(store, env) {
    const notices = [];
    for (const [seriesId, entries] of Object.entries(store.recent)) {
        const series = store.series[seriesId];
        if (series === undefined || !rings(store, series))
            continue;
        for (const entry of entries) {
            if (entry.outcome !== "missed" || entry.notice === undefined)
                continue;
            const atMs = instantOf(entry.key);
            notices.push(missedNotice(store, env.topics, { series: seriesId, key: entry.key, atMs }));
        }
    }
    return notices;
}
/**
 * The fixed ids of the notices of occurrences that ended: whatever of them
 * was not handed over yet is no longer worth sending.
 */
export function endedNotices(store) {
    return Object.values(store.recent)
        .flat()
        .flatMap((entry) => Object.values(entry.notices ?? {}));
}
/** The notices once each by fixed id, the first of each kept: this tick's own come first. */
function once(notices) {
    const ids = new Set();
    return notices.filter((notice) => {
        const id = notice.fixed?.id;
        if (id === undefined)
            return true;
        if (ids.has(id))
            return false;
        ids.add(id);
        return true;
    });
}
function summary(counts, notices) {
    const parts = [
        counts.opened > 0 ? `開了 ${counts.opened} 場` : "",
        counts.closed > 0 ? `結束 ${counts.closed} 場` : "",
        counts.missed > 0 ? `錯過 ${counts.missed} 場` : "",
        notices > 0 ? `新的通知 ${notices} 則` : "",
    ].filter((part) => part !== "");
    return parts.length === 0
        ? "ok schedule tick：沒有要做的"
        : `ok schedule tick：${parts.join("、")}`;
}
/** One check of the clock at `env.nowMs`; running it again at the same time changes nothing. */
export function tick(store, env) {
    const work = {
        next: structuredClone(store),
        env,
        records: [],
        fresh: [],
        touched: new Set(),
        counts: { opened: 0, closed: 0, missed: 0 },
    };
    advanceOpen(work);
    for (const [seriesId, series] of Object.entries(work.next.series)) {
        if (rings(work.next, series) && !hasOpen(work.next, seriesId))
            openOrMiss(work, seriesId);
    }
    for (const seriesId of work.touched) {
        const series = work.next.series[seriesId];
        if (series !== undefined)
            restartCount(series, env.nowMs);
    }
    const [first, ...rest] = work.records;
    const line = summary(work.counts, work.fresh.length);
    if (first === undefined)
        return { change: null, notices: recorded(store, env), line };
    return {
        change: { store: work.next, records: [first, ...rest] },
        notices: once([...work.fresh, ...recorded(work.next, env)]),
        line,
    };
}
