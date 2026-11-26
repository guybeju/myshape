// The schedule notices' fixed sentences (schedule-notices.ts): the topic's
// name as it is now, never the schedule's title, the rt word, the late
// suffix, the fixed ids and when each notice stops being worth sending.
import { describe, expect, it } from "vitest";
import {
  clockNotice,
  closedNotice,
  lateWords,
  missedExpiry,
  missedNotice,
  noticeId,
} from "#board/schedule-notices.js";
import { emptySchedules } from "#board/schedules.js";
import type { ScheduleStore, Series } from "#board/schedules.js";
import { emptyState } from "#board/topics.js";
import type { TopicState } from "#board/topics.js";

const MINUTE = 60_000;
// Monday 2026-11-30 10:00 in Taipei.
const T = Date.UTC(2026, 10, 30, 2, 0);
const KEY = "sync:20261130T0200Z";

function topics(): TopicState {
  const state = emptyState();
  state.doc.topics = { sync: { name: "週會", goal: "g", status: "confirmed", created_at: "T" } };
  state.doc.queues = { high: [], normal: [], later: ["sync"] };
  return state;
}

function series(extra: Partial<Series> = {}): Series {
  return {
    topic: "sync",
    title: "Weekly sync (old title)",
    rule: "weekly mon 10:00",
    tz: "Asia/Taipei",
    duration_min: null,
    lead_min: null,
    rt: "hard-rt",
    rt_locked: false,
    state: "on",
    locked: true,
    by: "captain",
    created_at: "2026-11-26T06:00:00Z",
    ...extra,
  };
}

function store(extra: Partial<Series> = {}): ScheduleStore {
  const fresh = emptySchedules();
  fresh.series["sync"] = series(extra);
  return fresh;
}

describe("the clock's two notices", () => {
  const pre = { series: "sync", key: KEY, atMs: T, phase: "pre" as const };

  it("says how many minutes are left, rounded up", () => {
    const notice = clockNotice(store(), topics(), pre, {
      nowMs: T - 14 * MINUTE - 30_000,
      dueMs: T - 15 * MINUTE,
      expiresMs: T,
    });
    expect(notice.action.text).toBe(
      "排程「週會」11-30（一）10:00 開始，還有 15 分鐘（議題 sync，這一場 sync:20261130T0200Z）（hard-rt）",
    );
    expect(notice.action.occurrence?.late_min).toBe(0);
  });

  it("adds the late suffix only past the captain's late_after_min", () => {
    const timing = (late: number) => ({
      nowMs: T - 15 * MINUTE + late * MINUTE,
      dueMs: T - 15 * MINUTE,
      expiresMs: T,
    });
    expect(clockNotice(store(), topics(), pre, timing(5)).action.text).not.toContain("晚了");
    expect(clockNotice(store(), topics(), pre, timing(6)).action.text).toContain(
      "（晚了 6 分鐘）（hard-rt）",
    );
    const patient = store();
    patient.settings.late_after_min = 10;
    expect(clockNotice(patient, topics(), pre, timing(6)).action.text).not.toContain("晚了");
  });

  it("never says a negative lateness or time left", () => {
    const notice = clockNotice(store(), topics(), pre, {
      nowMs: T + MINUTE,
      dueMs: T + 5 * MINUTE,
      expiresMs: T,
    });
    expect(notice.action.occurrence?.late_min).toBe(0);
    expect(notice.action.text).toContain("還有 0 分鐘");
  });

  it("gives the due notice its fixed id and the coming-up one it supersedes", () => {
    const notice = clockNotice(
      store(),
      topics(),
      { ...pre, phase: "start" },
      {
        nowMs: T,
        dueMs: T,
        expiresMs: T + 60 * MINUTE,
      },
    );
    expect(notice.fixed).toEqual({
      id: "w-s-sync-20261130T0200Z-start",
      supersedes: ["w-s-sync-20261130T0200Z-pre"],
    });
    expect(notice.action.occurrence?.expires_at).toBe("2026-11-30T03:00:00Z");
  });
});

describe("the missed notice's expiry", () => {
  it("is the next occurrence's coming-up moment", () => {
    expect(missedExpiry(store(), "sync", T)).toBe(Date.UTC(2026, 11, 7, 1, 45));
    expect(missedExpiry(store({ lead_min: 30 }), "sync", T)).toBe(Date.UTC(2026, 11, 7, 1, 30));
  });

  it("is the next occurrence's time when the schedule sends no coming-up notice", () => {
    expect(missedExpiry(store({ lead_min: 0 }), "sync", T)).toBe(Date.UTC(2026, 11, 7, 2, 0));
  });
});

describe("names in the notices", () => {
  const occurrence = { series: "sync", key: KEY, atMs: T };

  it("follows a merge and names an archived topic by its name", () => {
    const state = topics();
    state.doc.merged = { sync: "gone" };
    state.archive.topics = {
      gone: {
        name: "封存的週會",
        goal: "g",
        status: "confirmed",
        created_at: "T",
        archived_at: "T",
      },
    };
    const notice = missedNotice(store(), state, occurrence);
    expect(notice.topic).toBe("gone");
    expect(notice.action.text).toContain("排程「封存的週會」");
  });

  it("falls back to the topic id when the board has no such topic", () => {
    const state = topics();
    delete state.doc.topics["sync"];
    expect(missedNotice(store(), state, occurrence).action.topic).toEqual({
      id: "sync",
      name: "sync",
    });
  });

  it("still names a deleted schedule's occurrence, and refuses an unknown schedule", () => {
    const deleted = emptySchedules();
    deleted.removed["sync"] = {
      ...series(),
      removed_at: "2026-11-30T00:00:00Z",
      removed_by: "captain",
    };
    const notice = closedNotice(deleted, topics(), { ...occurrence, outcome: "done" });
    expect(notice.action.text).toBe(
      "排程「週會」11-30（一）10:00 那一場，使用者在看板上結束了，不用準備了（議題 sync，這一場 sync:20261130T0200Z）（hard-rt）",
    );
    expect(() => missedNotice(emptySchedules(), topics(), occurrence)).toThrow("沒有排程 sync");
  });
});

describe("words", () => {
  it("says lateness in minutes, hours, and both", () => {
    expect(lateWords(7)).toBe("7 分鐘");
    expect(lateWords(60)).toBe("1 小時");
    expect(lateWords(190)).toBe("3 小時 10 分");
    expect(noticeId("a-b", T, "missed")).toBe("w-s-a-b-20261130T0200Z-missed");
  });
});
