import { describe, expect, it } from "vitest";
import type { NowEntry, ScheduleCard } from "#board/schedule-view.js";
import { DEFAULT_SETTINGS } from "#board/schedules.js";
import {
  enableLabel,
  flipDay,
  formBody,
  formDays,
  formHints,
  lastMissed,
  lockLabel,
  liveNow,
  nextLine,
  outcomeLabel,
  rtHint,
  scheduleOn,
  scheduledTopics,
  settingWords,
  silentReason,
} from "./schedules.js";

function entry(key: string, closesBy: number, rt: NowEntry["rt"] = "none"): NowEntry {
  return {
    key,
    series: key,
    topic: key,
    title: key,
    at: 0,
    local: "11-30（一）10:00",
    state: "upcoming",
    rt,
    taken_at: null,
    taken_local: null,
    note: null,
    closes_by: closesBy,
    closes_local: "11-30（一）11:00",
  };
}

function card(extra: Partial<ScheduleCard> = {}): ScheduleCard {
  return {
    id: "sync",
    topic: "sync",
    title: "週會",
    rule_text: "每週一 10:00",
    days: ["mon"],
    at: "10:00",
    tz: "Asia/Taipei",
    lead_min: null,
    duration_min: null,
    lead: 15,
    duration: 60,
    rt: "none",
    rt_locked: false,
    locked: true,
    state: "on",
    by: "captain",
    new: false,
    awaiting_enable: false,
    rings: true,
    next: [{ at: 1, local: "11-30（一）10:00" }],
    open: null,
    strip: [],
    ...extra,
  };
}

describe("the 現在 strip on the page", () => {
  it("keeps the board's order and drops what passed its closes_by by the page's clock", () => {
    const now = [entry("b", 2000, "hard-rt"), entry("a", 1000), entry("c", 3000)];
    expect(liveNow({ now }, 999).map((open) => open.key)).toEqual(["b", "a", "c"]);
    expect(liveNow({ now }, 1000).map((open) => open.key)).toEqual(["b", "c"]);
    expect(liveNow({ now }, 3000)).toEqual([]);
  });
});

describe("the schedules by topic", () => {
  it("knows which topics have a schedule", () => {
    const series = [card(), card({ id: "mail", topic: "mail-check" })];
    expect([...scheduledTopics({ series })]).toEqual(["sync", "mail-check"]);
    expect(scheduleOn({ series }, "mail-check")?.id).toBe("mail");
    expect(scheduleOn({ series }, "other")).toBeUndefined();
  });
});

describe("the words", () => {
  it("says how each of the last ten ended", () => {
    const cell = { by: "aggregator", advance: false, count: null };
    expect(outcomeLabel({ ...cell, outcome: "done" })).toBe("做完");
    expect(outcomeLabel({ ...cell, outcome: "untaken" })).toBe("沒有人接（時間到）");
    expect(outcomeLabel({ ...cell, outcome: "timed_out" })).toBe("逾時結束");
    expect(outcomeLabel({ ...cell, outcome: "missed" })).toBe("錯過");
    expect(outcomeLabel({ ...cell, outcome: "missed", count: 3 })).toBe("錯過 3 場");
    expect(outcomeLabel({ ...cell, outcome: "skipped" })).toBe("跳過");
    expect(outcomeLabel({ ...cell, outcome: "skipped", advance: true })).toBe("事先跳過");
    expect(outcomeLabel({ ...cell, outcome: "skipped", advance: true, by: "board" })).toBe(
      "太快，看板略過",
    );
    expect(outcomeLabel({ ...cell, outcome: "later" })).toBe("later");
  });

  it("suggests a use for each rt but none", () => {
    expect(rtHint("hard-rt", "first mate")).toBe("建議 first mate：這一場的時限不能錯過");
    expect(rtHint("soft-rt", "plain")).toBe("建議 plain：盡量在合理時間內處理，晚一點可以");
    expect(rtHint("none", "plain")).toBeNull();
  });

  it("says why a schedule stays silent", () => {
    expect(silentReason(card(), true)).toBeNull();
    expect(silentReason(card({ rings: false, state: "paused" }), true)).toBe("暫停中");
    expect(silentReason(card({ rings: false }), true)).toBe("所有排程暫停中");
    expect(silentReason(card({ rings: false, awaiting_enable: true }), false)).toBe("等你按啟用");
    expect(silentReason(card({ rings: false }), false)).toBe("不會響");
  });

  it("names the next occurrence, and the last one when it was missed", () => {
    expect(nextLine(card())).toBe("下一場 11-30（一）10:00 · 每週一 10:00");
    expect(nextLine(card({ next: [] }))).toBe("每週一 10:00");
    const cell = {
      key: "k",
      local: "",
      by: "board",
      advance: false,
      note: null,
      closed_at: null,
      count: null,
    };
    expect(lastMissed(card())).toBe(false);
    expect(lastMissed(card({ strip: [{ ...cell, outcome: "missed" }] }))).toBe(true);
    expect(
      lastMissed(
        card({
          strip: [
            { ...cell, outcome: "done" },
            { ...cell, outcome: "missed" },
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe("the add and edit form", () => {
  it("ticks what was typed, else the schedule's own days, and none for every day", () => {
    const drafts = new Map<string, string>();
    expect(formDays(drafts, "sync", undefined)).toEqual([]);
    expect(formDays(drafts, "sync", card({ days: ["mon", "thu"] }))).toEqual(["mon", "thu"]);
    expect(formDays(drafts, "sync", card({ days: "daily" }))).toEqual([]);
    drafts.set("schedule-days:sync", "tue,nope");
    expect(formDays(drafts, "sync", card())).toEqual(["tue"]);
    drafts.set("schedule-days:sync", "");
    expect(formDays(drafts, "sync", card())).toEqual([]);
    expect(formDays(drafts, "other", card())).toEqual(["mon"]);
  });

  it("flips one day, keeping Monday-first order", () => {
    expect(flipDay(["thu"], "mon")).toEqual(["mon", "thu"]);
    expect(flipDay(["mon", "thu"], "mon")).toEqual(["thu"]);
    expect(flipDay(["sat"], "sun")).toEqual(["sat", "sun"]);
    expect(flipDay([], "wed")).toEqual(["wed"]);
  });

  it("sends the rule always, and the rest only when typed", () => {
    const drafts = new Map<string, string>([["schedule-at:mail", " 06:00 "]]);
    expect(formBody(drafts, "mail", undefined)).toEqual({
      topic: "mail",
      at: "06:00",
      daily: true,
    });
    drafts.set("schedule-days:mail", "mon,thu");
    drafts.set("schedule-tz:mail", "Asia/Taipei");
    drafts.set("schedule-lead:mail", "20");
    drafts.set("schedule-duration:mail", "30");
    drafts.set("schedule-rt:mail", "hard-rt");
    expect(formBody(drafts, "mail", undefined)).toEqual({
      topic: "mail",
      at: "06:00",
      weekly: "mon,thu",
      tz: "Asia/Taipei",
      lead: 20,
      duration: 30,
      rt: "hard-rt",
    });
    // Editing: the time stays unless typed, and rt has its own control.
    const editing = new Map<string, string>([
      ["schedule-rt:sync", "hard-rt"],
      ["schedule-tz:sync", "  "],
    ]);
    expect(formBody(editing, "sync", card())).toEqual({
      topic: "sync",
      at: "10:00",
      weekly: "mon",
    });
    expect(formBody(new Map(), "x", undefined)).toEqual({ topic: "x", at: "", daily: true });
  });

  it("says what each field is now, or what a new schedule takes", () => {
    expect(formHints(undefined, DEFAULT_SETTINGS)).toEqual({
      at: "時間 HH:MM，例如 10:00",
      tz: "時區（這台機器的時區）",
      lead: "提前幾分鐘（15）",
      duration: "時段長度（60 分）",
      save: "建立排程",
    });
    expect(
      formHints(undefined, { ...DEFAULT_SETTINGS, default_tz: "UTC", lead_min: 5 }),
    ).toMatchObject({
      tz: "時區（UTC）",
      lead: "提前幾分鐘（5）",
    });
    expect(formHints(card({ lead: 7, duration: 30 }), DEFAULT_SETTINGS)).toEqual({
      at: "時間（現在 10:00）",
      tz: "時區（Asia/Taipei）",
      lead: "提前幾分鐘（7）",
      duration: "時段長度（30 分）",
      save: "儲存",
    });
  });
});

describe("the settings panel and the buttons", () => {
  it("puts each setting in the panel's words", () => {
    expect(settingWords("lead_min", 15)).toBe("15 分");
    expect(settingWords("first_bell_min_ahead", 0)).toBe("0 分");
    expect(settingWords("max_active", 20)).toBe("20");
    expect(settingWords("aggregator_may_create", true)).toBe("可以");
    expect(settingWords("aggregator_may_set_rt", false)).toBe("不可以");
    expect(settingWords("aggregator_needs_enable", true)).toBe("要");
    expect(settingWords("aggregator_needs_enable", false)).toBe("不用");
    expect(settingWords("captain_locks_by_default", true)).toBe("上鎖");
    expect(settingWords("captain_locks_by_default", false)).toBe("不鎖");
    expect(settingWords("missed", "notice")).toBe("送一則「錯過」");
    expect(settingWords("missed", "due")).toBe("補送晚了的「到了」");
    expect(settingWords("missed", "record")).toBe("只記錄");
    expect(settingWords("default_tz", null)).toBe("這台機器的時區");
    expect(settingWords("default_tz", "UTC")).toBe("UTC");
    expect(settingWords("default_rt", "soft-rt")).toBe("soft-rt");
  });

  it("names what a lock press does", () => {
    expect(lockLabel("schedule", true, "plain")).toBe("解鎖排程（現在 plain 不能改）");
    expect(lockLabel("rt", false, "plain")).toBe("鎖上rt（plain 就不能改）");
  });

  it("says 啟用 enables every waiting schedule when there is more than one", () => {
    expect(enableLabel(1, "plain")).toBe("啟用（並把它標成看過）");
    expect(enableLabel(3, "plain")).toBe("啟用（plain 建的 3 筆新排程會一起啟用，並標成看過）");
  });
});
