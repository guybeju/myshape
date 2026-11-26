// The notices of schedules (design section 5, option 3): coming up
// (schedule.upcoming), due (schedule.due), missed (schedule.missed) and
// closed on the page (schedule.closed). Each `text` is a fixed sentence
// filled with the topic's name and id, the time, the occurrence key and the
// fixed rt word, because Firstmate's side forwards only `text`; the
// schedule's own title is never in it. The structured `occurrence` goes along.
import type { Frozen } from "./records.js";
import { compactUtc, isoSeconds, localIso, localLabel, occurrenceAfter } from "./schedule-time.js";
import { effective, ruleOf } from "./schedules.js";
import type { Rt, ScheduleStore, Series } from "./schedules.js";
import { resolveTopicId } from "./topics.js";
import type { TopicState } from "./topics.js";
import type { Action, FixedId, OccurrenceRef } from "./writes.js";

export type NoticeAction = Extract<Action, { kind: "notice" }>;

/** The phases the clock sends, by their fixed-id suffix. */
export type ClockPhase = "pre" | "start" | "missed";

/** A notice for the write engine: the topic it is about, and the fixed id when the clock sends it. */
export interface ScheduleNotice {
  topic: string;
  action: NoticeAction;
  fixed?: FixedId;
}

const MINUTE_MS = 60_000;

const RT_WORD: Record<Rt, string> = {
  none: "",
  "soft-rt": "（soft-rt）",
  "hard-rt": "（hard-rt）",
};

/** The fixed write id of one notice: w-s-<schedule id>-<UTC>-<pre|start|missed>. */
export function noticeId(series: string, atMs: number, phase: ClockPhase): string {
  return `w-s-${series}-${compactUtc(atMs)}-${phase}`;
}

/** Minutes as the late suffix says them: 7 分鐘, 3 小時, 3 小時 10 分. */
export function lateWords(minutes: number): string {
  if (minutes < 60) return `${minutes} 分鐘`;
  const rest = minutes % 60;
  return rest === 0 ? `${minutes / 60} 小時` : `${Math.floor(minutes / 60)} 小時 ${rest} 分`;
}

/** What every notice of one occurrence shares. */
interface Subject {
  series: Frozen<Series>;
  key: string;
  atMs: number;
  topicId: string;
  name: string;
}

/** The schedule `seriesId`, live or deleted; the notices of a deleted one may still be rebuilt. */
function seriesOf(store: Frozen<ScheduleStore>, seriesId: string): Frozen<Series> {
  const series = store.series[seriesId] ?? store.removed[seriesId];
  if (series === undefined) throw new Error(`沒有排程 ${seriesId}`);
  return series;
}

/** A topic's name as it is now, live or archived, or its id when the board has neither. */
function nameOf(topics: Frozen<TopicState>, topicId: string): string {
  return topics.doc.topics[topicId]?.name ?? topics.archive.topics[topicId]?.name ?? topicId;
}

function subject(
  store: Frozen<ScheduleStore>,
  topics: Frozen<TopicState>,
  seriesId: string,
  key: string,
  atMs: number,
): Subject {
  const series = seriesOf(store, seriesId);
  const topicId = resolveTopicId(topics.doc, series.topic);
  return { series, key, atMs, topicId, name: nameOf(topics, topicId) };
}

function ref(about: Subject, phase: OccurrenceRef["phase"]): OccurrenceRef {
  return {
    key: about.key,
    at: isoSeconds(about.atMs),
    local: localIso(about.series.tz, about.atMs),
    phase,
    rt: about.series.rt,
  };
}

function tail(about: Subject): string {
  return `（議題 ${about.topicId}，這一場 ${about.key}）`;
}

function notice(
  about: Subject,
  event: NoticeAction["event"],
  text: string,
  occurrence: OccurrenceRef,
): NoticeAction {
  return {
    kind: "notice",
    event,
    text,
    topic: { id: about.topicId, name: about.name },
    occurrence,
  };
}

/** One clock notice: when it is sent, how late it is, and until when it is worth sending. */
export interface ClockTiming {
  nowMs: number;
  /** The moment lateness counts from. */
  dueMs: number;
  expiresMs: number;
}

/** The late suffix and minutes of a notice sent at `nowMs` for a moment `dueMs`. */
function lateness(store: Frozen<ScheduleStore>, timing: ClockTiming): [number, string] {
  const late = Math.max(0, Math.floor((timing.nowMs - timing.dueMs) / MINUTE_MS));
  const said = late > store.settings.late_after_min ? `（晚了 ${lateWords(late)}）` : "";
  return [late, said];
}

/**
 * The coming-up or due notice of an open occurrence. A due notice supersedes
 * the coming-up one of the same occurrence that was not handed over yet.
 */
export function clockNotice(
  store: Frozen<ScheduleStore>,
  topics: Frozen<TopicState>,
  occurrence: { series: string; key: string; atMs: number; phase: "pre" | "start" },
  timing: ClockTiming,
): ScheduleNotice {
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
export function missedExpiry(store: Frozen<ScheduleStore>, seriesId: string, atMs: number): number {
  const series = seriesOf(store, seriesId);
  const { lead } = effective(series, store.settings);
  return occurrenceAfter(ruleOf(series), series.tz, atMs) - lead * MINUTE_MS;
}

/** The one notice of a schedule's latest occurrence missed while the board was not running. */
export function missedNotice(
  store: Frozen<ScheduleStore>,
  topics: Frozen<TopicState>,
  occurrence: { series: string; key: string; atMs: number },
): ScheduleNotice {
  const about = subject(store, topics, occurrence.series, occurrence.key, occurrence.atMs);
  const when = localLabel(about.series.tz, about.atMs);
  const text =
    `排程「${about.name}」${when} 錯過了：看板當時沒在跑，這一場沒有通知` +
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
export function closedNotice(
  store: Frozen<ScheduleStore>,
  topics: Frozen<TopicState>,
  occurrence: { series: string; key: string; atMs: number; outcome: "done" | "skipped" },
): ScheduleNotice {
  const about = subject(store, topics, occurrence.series, occurrence.key, occurrence.atMs);
  const when = localLabel(about.series.tz, about.atMs);
  const words = occurrence.outcome === "done" ? "結束" : "跳過";
  const text =
    `排程「${about.name}」${when} 那一場，使用者在看板上${words}了，不用準備了` +
    `${tail(about)}${RT_WORD[about.series.rt]}`;
  return {
    topic: about.topicId,
    action: notice(about, "schedule.closed", text, ref(about, "closed")),
  };
}
