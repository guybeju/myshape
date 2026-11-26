// What the page works out from the schedules the board sends (schedule-view.ts):
// which occurrences are still open by the page's own clock, which topics
// have a schedule, and the words for states, outcomes and rt. The board
// already orders the 現在 strip and gives every local time.
import type { NowEntry, ScheduleCard, ScheduleView, StripCell } from "#board/schedule-view.js";

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
