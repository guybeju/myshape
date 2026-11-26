import { compactUtc, isoSeconds, localIso, localLabel, occurrenceAfter } from "./schedule-time.js";
import { effective, ruleOf } from "./schedules.js";
import { resolveTopicId } from "./topics.js";
const MINUTE_MS = 60_000;
const RT_WORD = {
    none: "",
    "soft-rt": "（soft-rt）",
    "hard-rt": "（hard-rt）",
};
/** The fixed write id of one notice: w-s-<schedule id>-<UTC>-<pre|start|missed>. */
export function noticeId(series, atMs, phase) {
    return `w-s-${series}-${compactUtc(atMs)}-${phase}`;
}
/** Minutes as the late suffix says them: 7 分鐘, 3 小時, 3 小時 10 分. */
export function lateWords(minutes) {
    if (minutes < 60)
        return `${minutes} 分鐘`;
    const rest = minutes % 60;
    return rest === 0 ? `${minutes / 60} 小時` : `${Math.floor(minutes / 60)} 小時 ${rest} 分`;
}
/** The schedule `seriesId`, live or deleted; the notices of a deleted one may still be rebuilt. */
function seriesOf(store, seriesId) {
    const series = store.series[seriesId] ?? store.removed[seriesId];
    if (series === undefined)
        throw new Error(`沒有排程 ${seriesId}`);
    return series;
}
/** A topic's name as it is now, live or archived, or its id when the board has neither. */
function nameOf(topics, topicId) {
    return topics.doc.topics[topicId]?.name ?? topics.archive.topics[topicId]?.name ?? topicId;
}
function subject(store, topics, seriesId, key, atMs) {
    const series = seriesOf(store, seriesId);
    const topicId = resolveTopicId(topics.doc, series.topic);
    return { series, key, atMs, topicId, name: nameOf(topics, topicId) };
}
function ref(about, phase) {
    return {
        key: about.key,
        at: isoSeconds(about.atMs),
        local: localIso(about.series.tz, about.atMs),
        phase,
        rt: about.series.rt,
    };
}
function tail(about) {
    return `（議題 ${about.topicId}，這一場 ${about.key}）`;
}
function notice(about, event, text, occurrence) {
    return {
        kind: "notice",
        event,
        text,
        topic: { id: about.topicId, name: about.name },
        occurrence,
    };
}
/** The late suffix and minutes of a notice sent at `nowMs` for a moment `dueMs`. */
function lateness(store, timing) {
    const late = Math.max(0, Math.floor((timing.nowMs - timing.dueMs) / MINUTE_MS));
    const said = late > store.settings.late_after_min ? `（晚了 ${lateWords(late)}）` : "";
    return [late, said];
}
/**
 * The coming-up or due notice of an open occurrence. A due notice supersedes
 * the coming-up one of the same occurrence that was not handed over yet.
 */
export function clockNotice(store, topics, occurrence, timing) {
    const about = subject(store, topics, occurrence.series, occurrence.key, occurrence.atMs);
    const [late, lateSaid] = lateness(store, timing);
    const when = localLabel(about.series.tz, about.atMs);
    const rt = RT_WORD[about.series.rt];
    const phase = occurrence.phase;
    const occurrenceRef = {
        ...ref(about, phase),
        late_min: late,
        expires_at: isoSeconds(timing.expiresMs),
    };
    const id = noticeId(occurrence.series, occurrence.atMs, phase);
    if (phase === "pre") {
        const left = Math.max(0, Math.ceil((about.atMs - timing.nowMs) / MINUTE_MS));
        const text = `排程「${about.name}」${when} 開始，還有 ${left} 分鐘${tail(about)}${lateSaid}${rt}`;
        return {
            topic: about.topicId,
            action: notice(about, "schedule.upcoming", text, occurrenceRef),
            fixed: { id },
        };
    }
    const text = `排程「${about.name}」${when} 時間到了${tail(about)}${lateSaid}${rt}`;
    return {
        topic: about.topicId,
        action: notice(about, "schedule.due", text, occurrenceRef),
        fixed: { id, supersedes: [noticeId(occurrence.series, occurrence.atMs, "pre")] },
    };
}
/**
 * When a missed notice stops being worth sending: the next occurrence's
 * coming-up notice, or its time when the schedule sends none.
 */
export function missedExpiry(store, seriesId, atMs) {
    const series = seriesOf(store, seriesId);
    const { lead } = effective(series, store.settings);
    return occurrenceAfter(ruleOf(series), series.tz, atMs) - lead * MINUTE_MS;
}
/** The one notice of a schedule's latest occurrence missed while the board was not running. */
export function missedNotice(store, topics, occurrence) {
    const about = subject(store, topics, occurrence.series, occurrence.key, occurrence.atMs);
    const when = localLabel(about.series.tz, about.atMs);
    const text = `排程「${about.name}」${when} 錯過了：看板當時沒在跑，這一場沒有通知` +
        `${tail(about)}${RT_WORD[about.series.rt]}`;
    const expires = missedExpiry(store, occurrence.series, occurrence.atMs);
    return {
        topic: about.topicId,
        action: notice(about, "schedule.missed", text, {
            ...ref(about, "missed"),
            expires_at: isoSeconds(expires),
        }),
        fixed: { id: noticeId(occurrence.series, occurrence.atMs, "missed") },
    };
}
/** The notice of an occurrence the captain ended on the page after its notices went out. */
export function closedNotice(store, topics, occurrence) {
    const about = subject(store, topics, occurrence.series, occurrence.key, occurrence.atMs);
    const when = localLabel(about.series.tz, about.atMs);
    const words = occurrence.outcome === "done" ? "結束" : "跳過";
    const text = `排程「${about.name}」${when} 那一場，使用者在看板上${words}了，不用準備了` +
        `${tail(about)}${RT_WORD[about.series.rt]}`;
    return {
        topic: about.topicId,
        action: notice(about, "schedule.closed", text, ref(about, "closed")),
    };
}
