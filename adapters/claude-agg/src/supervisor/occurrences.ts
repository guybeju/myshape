// The supervisor's side of the board's schedules (plan section 3.8), as pure
// functions of the board's schedules.json, the supervisor's own state and
// the time. The board's clock owns the occurrences: nothing here works out
// when one happens, it only reads what the file says.
//
// The work for an occurrence is named after it, so a restart finds which
// task works for which occurrence with no field added to the state files:
//   <schedule id>-at-<UTC>-<n>         the work of the occurrence <schedule id>:<UTC>
//   <schedule id>-at-<UTC>-makeup-<n>  the make-up of a missed soft-rt occurrence
//   <schedule id>-at-<UTC>-missed      the carrier of a missed occurrence's report summary
// A schedule id and a topic id share one grammar, so these are task ids.

import type { Rt, SchedulesFile } from "./board-files.js";
import { clip, NOTE_MAX } from "./commands.js";

export { isOccurrenceKey, NOTE_MAX } from "./commands.js";

const WORK_ID = /^([A-Za-z0-9_][A-Za-z0-9._-]{0,63})-at-(\d{8}T\d{4}Z)-(makeup-)?([1-9]\d*)$/;

/** Which occurrence a task works for, and whether it is a make-up. */
export interface WorkRef {
  key: string;
  makeUp: boolean;
}

/** The occurrence work the task id names, or undefined for any other task. */
export function workOf(id: string): WorkRef | undefined {
  const match = WORK_ID.exec(id);
  if (match === null) return undefined;
  return { key: `${match[1] ?? ""}:${match[2] ?? ""}`, makeUp: match[3] !== undefined };
}

function stem(key: string): string {
  const [series = "", at = ""] = key.split(":");
  return `${series}-at-${at}`;
}

/** The task id of the `n`th task of this occurrence work. */
export function workId(ref: WorkRef, n: number): string {
  return `${stem(ref.key)}-${ref.makeUp ? "makeup-" : ""}${String(n)}`;
}

/** The id that carries the report summary of a missed occurrence; it is never a task. */
export function missedReportId(key: string): string {
  return `${stem(key)}-missed`;
}

/**
 * Where an occurrence stands now:
 * - `ended`: not in the file, its schedule gone, or past its closes_by;
 * - `silent`: open, but its schedule does not ring (paused, all paused, waiting for enable);
 * - `notYet`: open, before its time;
 * - `due`: open, at or past its time.
 */
export type OccurrencePhase = "ended" | "silent" | "notYet" | "due";

export function occurrencePhase(
  schedules: SchedulesFile,
  key: string,
  nowMs: number,
): OccurrencePhase {
  const occurrence = schedules.occurrences.get(key);
  if (occurrence === undefined || occurrence.closesByMs <= nowMs) return "ended";
  const series = schedules.series.get(occurrence.series);
  if (series === undefined) return "ended";
  if (!series.rings) return "silent";
  return occurrence.atMs > nowMs ? "notYet" : "due";
}

export type TaskState = "working" | "paused" | "blocked" | "failed" | "done";

/** What the supervisor knows, as the schedule work needs it. */
export interface WorkView {
  schedules: SchedulesFile;
  nowMs: number;
  /** Every task in tasks.json, with its state. */
  tasks: ReadonlyMap<string, TaskState>;
  /** The ids in queued.json. */
  queued: readonly string[];
  /** The occurrence keys a session (planner or worker) runs for now. */
  live: ReadonlySet<string>;
  /** Occurrences whose planner planned nothing this run, or gave no usable plan. */
  planned: ReadonlyMap<string, "nothing" | "failed">;
  /** Whether a schedule's topic (merges followed) is a live topic that may get work. */
  usable: (topic: string) => boolean;
}

export interface ScheduleWork {
  /** Open occurrences whose work has not started: each keeps one place free. */
  reserved: Set<string>;
  /** Open occurrences whose work has all ended: close each `done` with its note. */
  close: { key: string; note: string }[];
  /** Queued tasks whose occurrence ended before they started: take them off the queue. */
  drop: string[];
}

export const NOTE = {
  take: "claude-agg 接下，到時間開工",
  takeDue: "claude-agg 接下，現在開工",
  nothing: "claude-agg 看過了，這一場沒有要做的事",
  ended: (tasks: readonly string[]) =>
    clip(`claude-agg：${String(tasks.length)} 個 task 結束（${tasks.join("、")}）`, NOTE_MAX),
} as const;

const ENDED = new Set<TaskState>(["done", "failed"]);

function workFor(key: string, ids: Iterable<string>): string[] {
  return [...ids].filter((id) => {
    const ref = workOf(id);
    return ref !== undefined && !ref.makeUp && ref.key === key;
  });
}

/** An open occurrence none of whose tasks started: it keeps a place, or closes if planned to nothing. */
function unstarted(key: string, rings: boolean, view: WorkView, work: ScheduleWork): void {
  const queued = workFor(key, view.queued).length > 0;
  const planned = view.planned.get(key);
  if (planned === "nothing" && !queued) work.close.push({ key, note: NOTE.nothing });
  else if (rings && (planned === undefined || queued)) work.reserved.add(key);
}

/** What becomes of one open occurrence this pass. */
function oneOccurrence(key: string, rings: boolean, view: WorkView, work: ScheduleWork): void {
  if (view.live.has(key)) return;
  const tasks = workFor(key, view.tasks.keys()).toSorted();
  if (tasks.length === 0) {
    unstarted(key, rings, view, work);
    return;
  }
  const ended = tasks.every((id) => ENDED.has(view.tasks.get(id) ?? "working"));
  if (ended && workFor(key, view.queued).length === 0) {
    const states = tasks.map((id) => `${id} ${view.tasks.get(id) ?? ""}`);
    work.close.push({ key, note: NOTE.ended(states) });
  }
}

/**
 * For each open occurrence: whether it keeps a place free, whether its work
 * has ended so it is closed, and which queued tasks lost their occurrence.
 * A silent occurrence keeps no place, but one whose work ran is still closed.
 */
export function scheduleWork(view: WorkView): ScheduleWork {
  const work: ScheduleWork = { reserved: new Set(), close: [], drop: [] };
  const keys = [...view.schedules.occurrences.keys()].toSorted();
  for (const key of keys) {
    const phase = occurrencePhase(view.schedules, key, view.nowMs);
    const topic = topicOf(view.schedules, key);
    if (phase === "ended" || topic === undefined || !view.usable(topic)) continue;
    oneOccurrence(key, phase !== "silent", view, work);
  }
  work.drop = view.queued.filter((id) => lostItsOccurrence(id, view));
  return work;
}

/** The topic of an occurrence's schedule, or undefined when either is not in the file. */
function topicOf(schedules: SchedulesFile, key: string): string | undefined {
  const occurrence = schedules.occurrences.get(key);
  return occurrence === undefined ? undefined : schedules.series.get(occurrence.series)?.topic;
}

/** Whether a queued task is an occurrence's work whose occurrence has ended. */
function lostItsOccurrence(id: string, view: WorkView): boolean {
  const ref = workOf(id);
  if (ref === undefined || ref.makeUp) return false;
  return occurrencePhase(view.schedules, ref.key, view.nowMs) === "ended";
}

/** A schedule notice as `deliver` landed it: the occurrence it is about. */
export interface ScheduleNotice {
  event: "schedule.upcoming" | "schedule.due" | "schedule.missed" | "schedule.closed";
  key: string;
  /** The notice's topic id, as the board named it when it sent the notice. */
  topic: string;
  /** T, in UTC, as the notice gives it. */
  at: string;
  /** T in the schedule's zone, as the notice gives it ("" when it gave none). */
  local: string;
  rt: Rt;
  /** When the notice stops mattering, or null when it gave no time. */
  expiresAtMs: number | null;
}

/** What a missed occurrence gets: soft-rt is made up once, the others are reported. */
export type Missed = "makeUp" | "expired" | "report";

/**
 * soft-rt is made up once, unless the notice has expired (the schedule's
 * next occurrence is already coming up, so making up would be twice);
 * hard-rt is reported and not made up; rt none is reported like hard-rt.
 */
export function missedAction(notice: ScheduleNotice, nowMs: number): Missed {
  if (notice.rt !== "soft-rt") return "report";
  return notice.expiresAtMs !== null && notice.expiresAtMs <= nowMs ? "expired" : "makeUp";
}

/** The report summary of a missed occurrence; the same text every time, so a repeat is a no-op. */
export function missedReport(notice: ScheduleNotice): string {
  const when = notice.local === "" ? notice.at : notice.local;
  const rule = notice.rt === "hard-rt" ? "hard-rt 不補做" : "rt 是 none，不補做";
  return `排程的這一場 ${notice.key}（${when}）錯過了：看板當時沒在跑，沒有開工。${rule}。`;
}
