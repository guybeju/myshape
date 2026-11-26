// What the page works out from the schedules the board sends (schedule-view.ts):
// which occurrences are still open by the page's own clock, which topics
// have a schedule, and the words for states, outcomes and rt. The board
// already orders the 現在 strip and gives every local time.
import type { NowEntry, ScheduleCard, ScheduleView, StripCell } from "#board/schedule-view.js";
import type { Weekday } from "#board/schedule-time.js";

type Rt = NowEntry["rt"];

/**
 * The open occurrences, in the board's order, without any past its
 * closes_by: the view on screen may be a few seconds older than now.
 */
export function liveNow(schedules: Pick<ScheduleView, "now">, nowMs: number): NowEntry[] {
  return schedules.now.filter((entry) => entry.closes_by > nowMs);
}

/** The topics that have a schedule, merges followed. */
export function scheduledTopics(schedules: Pick<ScheduleView, "series">): Set<string> {
  return new Set(schedules.series.map((card) => card.topic));
}

/** The schedule on `topic`, if it has one. */
export function scheduleOn(
  schedules: Pick<ScheduleView, "series">,
  topic: string,
): ScheduleCard | undefined {
  return schedules.series.find((card) => card.topic === topic);
}

export const STATE_LABEL: Record<NowEntry["state"], string> = {
  upcoming: "快到了",
  due: "到了",
  taken: "已接下",
};

const OUTCOME_LABEL: Record<string, string> = {
  done: "做完",
  skipped: "跳過",
  untaken: "沒有人接（時間到）",
  timed_out: "逾時結束",
  missed: "錯過",
};

/** How one of the last ten ended, in the strip's words. */
export function outcomeLabel(
  cell: Pick<StripCell, "outcome" | "advance" | "by" | "count">,
): string {
  if (cell.advance) return cell.by === "board" ? "太快，看板略過" : "事先跳過";
  if (cell.outcome === "missed" && cell.count !== null) return `錯過 ${cell.count} 場`;
  return OUTCOME_LABEL[cell.outcome] ?? cell.outcome;
}

/** The board's suggestion of how the aggregator might treat the rt; none for `none`. */
export function rtHint(rt: Rt, agent: string): string | null {
  if (rt === "hard-rt") return `建議 ${agent}：這一場的時限不能錯過`;
  if (rt === "soft-rt") return `建議 ${agent}：盡量在合理時間內處理，晚一點可以`;
  return null;
}

/** Why a schedule does not ring now, or null when it does. */
export function silentReason(card: ScheduleCard, allPaused: boolean): string | null {
  if (card.rings) return null;
  if (card.state === "paused") return "暫停中";
  if (allPaused) return "所有排程暫停中";
  return card.awaiting_enable ? "等你按啟用" : "不會響";
}

/** The card's one line in the 排程 column: when the next occurrence is, and the rule. */
export function nextLine(card: ScheduleCard): string {
  const next = card.next[0];
  return next === undefined ? card.rule_text : `下一場 ${next.local} · ${card.rule_text}`;
}

/** Whether the latest of the last ten was missed, so the column says 上一場錯過. */
export function lastMissed(card: Pick<ScheduleCard, "strip">): boolean {
  return card.strip[0]?.outcome === "missed";
}

// ---------------------------------------------------------------- the add and edit form

type Settings = ScheduleView["settings"];
type Drafts = ReadonlyMap<string, string>;

/** The weekdays in the form's order, Monday first, with their one-character names. */
export const FORM_DAYS: readonly (readonly [Weekday, string])[] = [
  ["mon", "一"],
  ["tue", "二"],
  ["wed", "三"],
  ["thu", "四"],
  ["fri", "五"],
  ["sat", "六"],
  ["sun", "日"],
];

function isWeekday(value: string): value is Weekday {
  return FORM_DAYS.some(([day]) => day === value);
}

/** The days the form has ticked: what was typed, or the schedule's own; none means every day. */
export function formDays(drafts: Drafts, id: string, card: ScheduleCard | undefined): Weekday[] {
  const typed = drafts.get(`schedule-days:${id}`);
  if (typed !== undefined) return typed.split(",").filter(isWeekday);
  return card === undefined || card.days === "daily" ? [] : [...card.days];
}

/** The days after ticking or unticking `day`, in the form's order. */
export function flipDay(days: readonly Weekday[], day: Weekday): Weekday[] {
  const next = days.includes(day) ? days.filter((entry) => entry !== day) : [...days, day];
  return FORM_DAYS.map(([name]) => name).filter((name) => next.includes(name));
}

/** The form's fields a request carries only when typed: whether each is a number. */
const NEW_FIELDS = [
  ["lead", true],
  ["duration", true],
  ["tz", false],
  ["rt", false],
] as const;
// rt has its own control once a schedule exists.
const EDIT_FIELDS = NEW_FIELDS.filter(([field]) => field !== "rt");

function typedField(drafts: Drafts, id: string, field: string): string {
  return (drafts.get(`schedule-${field}:${id}`) ?? "").trim();
}

/** The rule the form names: the typed time or the schedule's own, and the ticked days or every day. */
function formRule(
  drafts: Drafts,
  id: string,
  card: ScheduleCard | undefined,
): Record<string, unknown> {
  const days = formDays(drafts, id, card);
  return {
    at: typedField(drafts, id, "at") || (card?.at ?? ""),
    ...(days.length === 0 ? { daily: true } : { weekly: days.join(",") }),
  };
}

/** What the add or edit form sends: the rule always, the rest only when typed. */
export function formBody(
  drafts: Drafts,
  id: string,
  card: ScheduleCard | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = { topic: id, ...formRule(drafts, id, card) };
  for (const [field, isNumber] of card === undefined ? NEW_FIELDS : EDIT_FIELDS) {
    const value = typedField(drafts, id, field);
    if (value !== "") body[field] = isNumber ? Number(value) : value;
  }
  return body;
}

interface FormHints {
  at: string;
  tz: string;
  lead: string;
  duration: string;
  save: string;
}

function hintsFor(at: string, tz: string, lead: number, duration: number, save: string): FormHints {
  return {
    at,
    tz: `時區（${tz}）`,
    lead: `提前幾分鐘（${lead}）`,
    duration: `時段長度（${duration} 分）`,
    save,
  };
}

/** The form's placeholders: what each field is now, or what a new schedule would take. */
export function formHints(card: ScheduleCard | undefined, settings: Settings): FormHints {
  if (card !== undefined)
    return hintsFor(`時間（現在 ${card.at}）`, card.tz, card.lead, card.duration, "儲存");
  const tz = settings.default_tz ?? "這台機器的時區";
  return hintsFor(
    "時間 HH:MM，例如 10:00",
    tz,
    settings.lead_min,
    settings.duration_min,
    "建立排程",
  );
}

// ---------------------------------------------------------------- the settings panel and buttons

const BOOLEAN_WORDS: Partial<Record<keyof Settings, readonly [string, string]>> = {
  aggregator_needs_enable: ["要", "不用"],
  captain_locks_by_default: ["上鎖", "不鎖"],
};
const MISSED_WORDS: Record<string, string> = {
  notice: "送一則「錯過」",
  due: "補送晚了的「到了」",
  record: "只記錄",
};
const MINUTE_SETTINGS: ReadonlySet<keyof Settings> = new Set<keyof Settings>([
  "lead_min",
  "duration_min",
  "max_open_min",
  "late_after_min",
  "first_bell_min_ahead",
]);

/** A setting's value in the panel's words. */
export function settingWords<K extends keyof Settings>(name: K, value: Settings[K]): string {
  if (typeof value === "boolean") {
    const [yes, no] = BOOLEAN_WORDS[name] ?? ["可以", "不可以"];
    return value ? yes : no;
  }
  if (value === null) return "這台機器的時區";
  if (name === "missed") return MISSED_WORDS[String(value)] ?? String(value);
  return MINUTE_SETTINGS.has(name) ? `${value} 分` : String(value);
}

/** The lock button's words: what pressing it does, and what holds now. */
export function lockLabel(lock: "schedule" | "rt", locked: boolean, agent: string): string {
  const what = lock === "schedule" ? "排程" : "rt";
  return locked ? `解鎖${what}（現在 ${agent} 不能改）` : `鎖上${what}（${agent} 就不能改）`;
}

/** 啟用 is the seen mark, which enables every waiting schedule at once, so its words say so. */
export function enableLabel(waiting: number, agent: string): string {
  return waiting > 1
    ? `啟用（${agent} 建的 ${waiting} 筆新排程會一起啟用，並標成看過）`
    : "啟用（並把它標成看過）";
}
