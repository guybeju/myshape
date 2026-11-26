// The schedule clock (schedule-clock.ts) against a fake time: opening, the
// two notices and their fixed ids, ending by time and after a take, pauses,
// skips, a restart inside and after a window, one missed notice per
// schedule, a clock that goes back, and checked_through saved only when
// something happens.
import { describe, expect, it } from "vitest";
import { endedNotices, rings, tick } from "#board/schedule-clock.js";
import type { TickResult } from "#board/schedule-clock.js";
import { isOccurrence, parseOccurrenceKey, parseRule } from "#board/schedule-time.js";
import { emptySchedules, takeOccurrence } from "#board/schedules.js";
import type { ScheduleStore, Series } from "#board/schedules.js";
import { generator } from "#board/seeded-random.test-helper.js";
import { emptyState } from "#board/topics.js";
import type { TopicState } from "#board/topics.js";

const MINUTE = 60_000;
// Monday 2026-11-30 10:00 in Taipei.
const T = Date.UTC(2026, 10, 30, 2, 0);
const KEY = "sync:20261130T0200Z";
const PRE = "w-s-sync-20261130T0200Z-pre";
const START = "w-s-sync-20261130T0200Z-start";

function topics(): TopicState {
  const state = emptyState();
  const topic = (name: string) => ({
    name,
    goal: "g",
    status: "confirmed" as const,
    created_at: "T",
  });
  state.doc.topics = { sync: topic("週會"), "mail-check": topic("看信") };
  state.doc.queues = { high: [], normal: [], later: ["sync", "mail-check"] };
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

function at(nowMs: number, from: ScheduleStore, state = topics()): TickResult {
  return tick(from, { topics: state, nowMs });
}

/** The store after a tick that changed it; fails when it changed nothing. */
function after(result: TickResult): ScheduleStore {
  if (result.change === null) throw new Error(`expected a change: ${result.line}`);
  return result.change.store;
}

function kinds(result: TickResult): string[] {
  return result.change?.records.map((record) => record.kind) ?? [];
}

const opened = (): ScheduleStore => after(at(T - 15 * MINUTE + 10_000, store()));

describe("opening and the two notices", () => {
  it("does nothing before the coming-up moment", () => {
    const result = at(T - 15 * MINUTE - 1, store());
    expect(result.change).toBeNull();
    expect(result.notices).toEqual([]);
    expect(result.line).toBe("ok schedule tick：沒有要做的");
  });

  it("opens the occurrence at its time less the lead, with the coming-up notice", () => {
    const now = T - 15 * MINUTE + 10_000;
    const result = at(now, store());
    const next = after(result);
    expect(next.occurrences[KEY]).toEqual({
      series: "sync",
      at: "2026-11-30T02:00:00Z",
      state: "upcoming",
      opened_at: "2026-11-30T01:45:10Z",
      closes_by: "2026-11-30T03:00:00Z",
      notices: { pre: PRE },
    });
    expect(next.series["sync"]?.checked_through).toBe("2026-11-30T01:45:10Z");
    expect(kinds(result)).toEqual(["occurrence.opened"]);
    expect(result.line).toBe("ok schedule tick：開了 1 場、新的通知 1 則");
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toEqual({
      topic: "sync",
      fixed: { id: PRE },
      action: {
        kind: "notice",
        event: "schedule.upcoming",
        text: "排程「週會」11-30（一）10:00 開始，還有 15 分鐘（議題 sync，這一場 sync:20261130T0200Z）（hard-rt）",
        topic: { id: "sync", name: "週會" },
        occurrence: {
          key: KEY,
          at: "2026-11-30T02:00:00Z",
          local: "2026-11-30T10:00+08:00",
          phase: "pre",
          late_min: 0,
          rt: "hard-rt",
          expires_at: "2026-11-30T02:00:00Z",
        },
      },
    });
  });

  it("names the topic as it is called now, never the schedule's title, and no rt word for none", () => {
    const state = topics();
    (state.doc.topics["sync"] as { name: string }).name = "新週會";
    const result = at(T - 15 * MINUTE, store({ rt: "none" }), state);
    expect(result.notices[0]?.action.text).toBe(
      "排程「新週會」11-30（一）10:00 開始，還有 15 分鐘（議題 sync，這一場 sync:20261130T0200Z）",
    );
    expect(result.notices[0]?.action.text).not.toContain("old title");
  });

  it("makes it due at its time, with a due notice that supersedes the coming-up one", () => {
    const result = at(T + 5_000, opened());
    const next = after(result);
    expect(next.occurrences[KEY]?.state).toBe("due");
    expect(next.occurrences[KEY]?.notices).toEqual({ pre: PRE, start: START });
    expect(kinds(result)).toEqual(["occurrence.due"]);
    const due = result.notices[0];
    expect(due?.fixed).toEqual({ id: START, supersedes: [PRE] });
    expect(due?.action.event).toBe("schedule.due");
    expect(due?.action.text).toBe(
      "排程「週會」11-30（一）10:00 時間到了（議題 sync，這一場 sync:20261130T0200Z）（hard-rt）",
    );
    expect(due?.action.occurrence).toMatchObject({
      phase: "start",
      late_min: 0,
      expires_at: "2026-11-30T03:00:00Z",
    });
  });

  it("opens straight as due, with no coming-up notice, when the lead is 0", () => {
    const result = at(T + 1000, store({ lead_min: 0 }));
    const next = after(result);
    expect(next.occurrences[KEY]?.state).toBe("due");
    expect(next.occurrences[KEY]?.notices).toEqual({ start: START });
    expect(result.notices.map((notice) => notice.fixed?.id)).toEqual([START]);
  });

  it("is idempotent: the same tick again changes nothing and hands in only the same ids", () => {
    const first = at(T - 10 * MINUTE, store());
    const second = at(T - 10 * MINUTE, after(first));
    expect(second.change).toBeNull();
    expect(second.notices.map((notice) => notice.fixed?.id)).toEqual([PRE]);
  });
});

describe("ending", () => {
  it("ends an occurrence nobody took at its time plus the duration, by the board", () => {
    const due = after(at(T + 1000, opened()));
    expect(at(T + 60 * MINUTE - 1, due).change).toBeNull();
    const result = at(T + 60 * MINUTE, due);
    const next = after(result);
    expect(next.occurrences).toEqual({});
    expect(next.recent["sync"]).toEqual([
      {
        key: KEY,
        outcome: "untaken",
        by: "board",
        note: "沒有人接（時間到）",
        closed_at: "2026-11-30T03:00:00Z",
        notices: { pre: PRE, start: START },
      },
    ]);
    expect(result.change?.records).toEqual([
      expect.objectContaining({ kind: "occurrence.closed", outcome: "untaken", topic: "sync" }),
    ]);
    expect(endedNotices(next).toSorted()).toEqual([PRE, START]);
    expect(result.notices).toEqual([]);
  });

  it("keeps a taken occurrence open until its closes_by, then ends it as timed out", () => {
    const due = after(at(T + 1000, opened()));
    const took = takeOccurrence(
      due,
      {
        topics: topics(),
        nowMs: T + 2 * MINUTE,
        actor: { by: "aggregator", label: "fm" },
        records: [],
        machineZone: "Asia/Taipei",
      },
      KEY,
      "10:40 有空位再開",
    );
    if (!took.ok || !took.changed) throw new Error("take failed");
    expect(at(T + 61 * MINUTE, took.store).change).toBeNull();
    const result = at(T + 180 * MINUTE, took.store);
    expect(after(result).recent["sync"]?.[0]).toMatchObject({
      outcome: "timed_out",
      by: "board",
      note: "10:40 有空位再開",
    });
  });

  it("sends no due notice for an occurrence the aggregator took before its time", () => {
    const pre = opened();
    (pre.occurrences[KEY] as { state: string }).state = "taken";
    (pre.occurrences[KEY] as { closes_by: string }).closes_by = "2026-11-30T05:00:00Z";
    const result = at(T + 1000, pre);
    expect(result.change).toBeNull();
    expect(result.notices.map((notice) => notice.fixed?.id)).toEqual([PRE]);
  });

  it("honours a closes_by already past whatever the state says, after a long stop", () => {
    const result = at(T + 5 * 60 * MINUTE, opened());
    expect(after(result).recent["sync"]?.[0]?.outcome).toBe("untaken");
    expect(kinds(result)).toEqual(["occurrence.closed"]);
  });
});

describe("what keeps the clock quiet", () => {
  it("opens nothing for a paused schedule, and later reports nothing missed", () => {
    const paused = store({ state: "paused" });
    expect(at(T - 10 * MINUTE, paused).change).toBeNull();
    expect(at(T + 6 * 60 * MINUTE, paused).change).toBeNull();
  });

  it("opens nothing while everything is paused", () => {
    const all = store();
    all.settings.all_paused = true;
    expect(at(T - 10 * MINUTE, all).change).toBeNull();
    expect(rings(all, all.series["sync"] as Series)).toBe(false);
  });

  it("makes an open occurrence due without a notice while paused, and sends none later", () => {
    const open = opened();
    (open.series["sync"] as Series).state = "paused";
    const result = at(T + 1000, open);
    const next = after(result);
    expect(next.occurrences[KEY]?.state).toBe("due");
    expect(next.occurrences[KEY]?.notices).toEqual({ pre: PRE });
    expect(result.change?.records[0]?.text).toContain("排程暫停中，沒有送通知");
    expect(result.notices).toEqual([]);
    (next.series["sync"] as Series).state = "on";
    expect(at(T + 2 * MINUTE, next).notices.map((notice) => notice.fixed?.id)).toEqual([PRE]);
  });

  it("waits for the captain's enable on an aggregator's schedule while that is required", () => {
    const waiting = store({ by: "aggregator", seen: false, locked: false });
    waiting.settings.aggregator_needs_enable = true;
    expect(at(T - 10 * MINUTE, waiting).change).toBeNull();
    (waiting.series["sync"] as Series).seen = true;
    expect(after(at(T - 10 * MINUTE, waiting)).occurrences[KEY]?.state).toBe("upcoming");
  });

  it("skips an occurrence skipped in advance, and does not report it missed", () => {
    const skipped = store();
    skipped.recent["sync"] = [
      { key: KEY, outcome: "skipped", by: "captain", closed_at: "2026-11-29T00:00:00Z" },
    ];
    expect(at(T - 10 * MINUTE, skipped).change).toBeNull();
    expect(at(T + 6 * 60 * MINUTE, skipped).change).toBeNull();
  });

  it("does not open an occurrence while the schedule has one open", () => {
    const daily = store({ rule: "daily 10:00", lead_min: 0, duration_min: 60 });
    daily.settings.max_open_min = 1300;
    const result = at(T + 1000, daily);
    const next = after(result);
    (next.occurrences[KEY] as { state: string }).state = "taken";
    (next.occurrences[KEY] as { closes_by: string }).closes_by = "2026-12-01T02:30:00Z";
    expect(at(T + 24 * 60 * MINUTE + 1000, next).change).toBeNull();
  });
});

describe("restarts", () => {
  it("opens late inside the window and says how late: 05:52 for 06:00 with a 15-minute lead", () => {
    const late = store({ checked_through: "2026-11-30T01:00:00Z" });
    const result = at(T - 8 * MINUTE, late);
    expect(result.notices[0]?.action.text).toBe(
      "排程「週會」11-30（一）10:00 開始，還有 8 分鐘（議題 sync，這一場 sync:20261130T0200Z）（晚了 7 分鐘）（hard-rt）",
    );
    expect(result.notices[0]?.action.occurrence?.late_min).toBe(7);
  });

  it("opens after its time as due only, saying how late, with no coming-up notice", () => {
    const late = store({ checked_through: "2026-11-30T01:00:00Z" });
    const result = at(T + 3 * MINUTE, late);
    const next = after(result);
    expect(next.occurrences[KEY]?.state).toBe("due");
    expect(next.occurrences[KEY]?.notices).toEqual({ start: START });
    expect(result.notices.map((notice) => notice.fixed?.id)).toEqual([START]);
    expect(result.notices[0]?.action.text).not.toContain("晚了");
    const later = at(T + 10 * MINUTE, late);
    expect(later.notices[0]?.action.text).toContain(
      "時間到了（議題 sync，這一場 sync:20261130T0200Z）（晚了 10 分鐘）（hard-rt）",
    );
  });

  it("does not count a schedule made inside a window as late", () => {
    const made = store({ created_at: "2026-11-30T01:55:00Z" });
    const result = at(T - 4 * MINUTE, made);
    expect(result.notices[0]?.action.occurrence?.late_min).toBe(1);
    expect(result.notices[0]?.action.text).not.toContain("晚了");
  });

  it("hands in again, under the same id, a notice the store has and the engine may have lost", () => {
    const due = after(at(T + 1000, opened()));
    const result = at(T + 2 * MINUTE, due);
    expect(result.change).toBeNull();
    expect(result.notices.map((notice) => notice.fixed?.id)).toEqual([PRE, START]);
  });
});

describe("missed while the board was not running", () => {
  // Daily 06:00 in Taipei, 30 minutes; the board was down from 11-24 to 11-27 09:10.
  const mail = (): ScheduleStore => {
    const fresh = emptySchedules();
    fresh.series["mail-0600"] = series({
      topic: "mail-check",
      title: "看信",
      rule: "daily 06:00",
      duration_min: 30,
      rt: "soft-rt",
      checked_through: "2026-11-24T00:00:00Z",
    });
    return fresh;
  };
  const BACK = Date.UTC(2026, 10, 27, 1, 10);
  const LATEST = "mail-0600:20261126T2200Z";

  it("records every missed occurrence in one entry and sends one missed notice for the latest", () => {
    const result = at(BACK, mail());
    const next = after(result);
    expect(next.recent["mail-0600"]).toEqual([
      {
        key: LATEST,
        outcome: "missed",
        by: "board",
        closed_at: "2026-11-27T01:10:00Z",
        notice: "w-s-mail-0600-20261126T2200Z-missed",
        count: 3,
        from: "2026-11-24T22:00:00Z",
        to: "2026-11-26T22:00:00Z",
      },
    ]);
    expect(kinds(result)).toEqual(["occurrence.missed"]);
    expect(result.change?.records[0]?.text).toBe(
      "排程「看信」錯過 3 場（11-25（三）06:00 到 11-27（五）06:00）：看板當時沒在跑",
    );
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toEqual({
      topic: "mail-check",
      fixed: { id: "w-s-mail-0600-20261126T2200Z-missed" },
      action: {
        kind: "notice",
        event: "schedule.missed",
        text: "排程「看信」11-27（五）06:00 錯過了：看板當時沒在跑，這一場沒有通知（議題 mail-check，這一場 mail-0600:20261126T2200Z）（soft-rt）",
        topic: { id: "mail-check", name: "看信" },
        occurrence: {
          key: LATEST,
          at: "2026-11-26T22:00:00Z",
          local: "2026-11-27T06:00+08:00",
          phase: "missed",
          rt: "soft-rt",
          expires_at: "2026-11-27T21:45:00Z",
        },
      },
    });
  });

  it("sends the missed notice once however often the board starts again", () => {
    const once = after(at(BACK, mail()));
    const again = at(BACK + 5 * MINUTE, once);
    expect(again.change).toBeNull();
    expect(again.notices.map((notice) => notice.fixed?.id)).toEqual([
      "w-s-mail-0600-20261126T2200Z-missed",
    ]);
  });

  it("keeps a single missed occurrence without a count", () => {
    const one = mail();
    (one.series["mail-0600"] as Series).checked_through = "2026-11-26T12:00:00Z";
    expect(after(at(BACK, one)).recent["mail-0600"]?.[0]).not.toHaveProperty("count");
  });

  it("only records the earlier ones when the latest is still inside its window", () => {
    const result = at(Date.UTC(2026, 10, 26, 22, 10), mail());
    const next = after(result);
    expect(kinds(result)).toEqual(["occurrence.missed", "occurrence.opened"]);
    expect(next.recent["mail-0600"]?.[0]).toMatchObject({ outcome: "missed", count: 2 });
    expect(next.recent["mail-0600"]?.[0]).not.toHaveProperty("notice");
    expect(next.occurrences[LATEST]?.state).toBe("due");
    expect(result.notices.map((notice) => notice.action.event)).toEqual(["schedule.due"]);
  });

  it("only records under the record setting", () => {
    const quiet = mail();
    quiet.settings.missed = "record";
    const result = at(BACK, quiet);
    expect(after(result).recent["mail-0600"]?.[0]).not.toHaveProperty("notice");
    expect(result.change?.records[0]?.text).toContain("只記下來");
    expect(result.notices).toEqual([]);
  });

  it("reopens the latest as due now, with a late due notice, under the due setting", () => {
    const reopen = mail();
    reopen.settings.missed = "due";
    const result = at(BACK, reopen);
    const next = after(result);
    expect(next.occurrences[LATEST]).toMatchObject({
      state: "due",
      closes_by: "2026-11-27T01:40:00Z",
    });
    expect(next.recent["mail-0600"]?.[0]).toMatchObject({ outcome: "missed", count: 2 });
    expect(result.notices[0]?.action.text).toContain("（晚了 3 小時 10 分）（soft-rt）");
  });

  it("reports nothing missed before the schedule was made", () => {
    const made = mail();
    const fresh = made.series["mail-0600"] as Series;
    delete fresh.checked_through;
    fresh.created_at = "2026-11-27T01:00:00Z";
    expect(at(BACK, made).change).toBeNull();
  });
});

describe("a clock that goes back", () => {
  it("never reopens an occurrence already handled, and never lowers checked_through", () => {
    const closed = after(at(T + 60 * MINUTE, after(at(T + 1000, opened()))));
    expect(at(T - 10 * MINUTE, closed).change).toBeNull();
    const moved = after(at(T + 1000, opened()));
    const back = at(T - 30 * MINUTE, moved);
    expect(back.change).toBeNull();
    const reopened = after(at(T + 60 * MINUTE, moved));
    expect(reopened.series["sync"]?.checked_through).toBe("2026-11-30T03:00:00Z");
    const forward = store({ checked_through: "2026-11-30T03:00:00Z" });
    forward.occurrences[KEY] = {
      series: "sync",
      at: "2026-11-30T02:00:00Z",
      state: "upcoming",
      opened_at: "2026-11-30T01:45:00Z",
      closes_by: "2026-11-30T03:00:00Z",
    };
    const ended = after(at(T + 60 * MINUTE + 1, forward));
    expect(ended.series["sync"]?.checked_through).toBe("2026-11-30T03:00:00Z");
  });
});

describe("checked_through", () => {
  it("is saved only when an occurrence opens, comes due, closes or is missed, not on each tick", () => {
    let current = store();
    const saved: string[] = [];
    for (let now = T - 60 * MINUTE; now <= T + 90 * MINUTE; now += 30_000) {
      const result = at(now, current);
      if (result.change !== null) {
        saved.push(...kinds(result));
        current = result.change.store;
      }
    }
    expect(saved).toEqual(["occurrence.opened", "occurrence.due", "occurrence.closed"]);
  });
});

describe("properties", () => {
  it("over random daily and weekly schedules and stops, opens each occurrence at most once and never two at a time", () => {
    const random = generator(20_261_130);
    const rules = ["daily 06:00", "daily 23:30", "weekly mon,thu 10:00", "weekly sun 00:15"];
    const zones = ["Asia/Taipei", "America/New_York", "Europe/London"];
    for (let round = 0; round < 25; round += 1) {
      const rule = rules[Math.floor(random() * rules.length)] as string;
      const zone = zones[Math.floor(random() * zones.length)] as string;
      let current = store({ rule, tz: zone, lead_min: 15, duration_min: 30 });
      const seen = new Map<string, number>();
      let now = T - 2 * 24 * 60 * MINUTE;
      for (let step = 0; step < 120; step += 1) {
        // Mostly 30-second ticks, sometimes a stop of up to two days.
        now += random() < 0.9 ? 30_000 : Math.floor(random() * 2 * 24 * 60) * MINUTE;
        const result = at(now, current);
        if (result.change === null) continue;
        current = result.change.store;
        const open = Object.keys(current.occurrences);
        expect(open.length).toBeLessThanOrEqual(1);
        for (const record of result.change.records) {
          if (record.kind !== "occurrence.opened") continue;
          const key = open[0] as string;
          seen.set(key, (seen.get(key) ?? 0) + 1);
        }
      }
      for (const count of seen.values()) expect(count).toBe(1);
      const parsed = parseRule(rule);
      if (parsed === null) throw new Error(rule);
      for (const key of seen.keys()) {
        const instant = parseOccurrenceKey(key)?.at ?? Number.NaN;
        expect(isOccurrence(parsed, zone, instant)).toBe(true);
      }
    }
  });
});
