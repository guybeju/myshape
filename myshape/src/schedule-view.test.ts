// What the page gets of the schedules (schedule-view.ts): the 現在 strip's
// order and its closes_by cut, each schedule's card, and the aggregator's
// recent changes.
import { describe, expect, it } from "vitest";
import { nowOrder, openKeys, scheduleView } from "#board/schedule-view.js";
import { emptySchedules } from "#board/schedules.js";
import type { Occurrence, ScheduleRecord, ScheduleStore, Series } from "#board/schedules.js";
import { emptyState } from "#board/topics.js";
import type { TopicState } from "#board/topics.js";

const MINUTE = 60_000;
// Monday 2026-11-30 10:00 in Taipei.
const T = Date.UTC(2026, 10, 30, 2, 0);

function topics(): TopicState {
  const state = emptyState();
  const topic = (name: string) => ({
    name,
    goal: "g",
    status: "confirmed" as const,
    created_at: "T",
  });
  state.doc.topics = { sync: topic("週會"), mail: topic("看信"), ops: topic("值班") };
  state.doc.queues = { high: [], normal: [], later: ["sync", "mail", "ops"] };
  state.doc.merged = { "old-sync": "sync" };
  return state;
}

function series(topic: string, extra: Partial<Series> = {}): Series {
  return {
    topic,
    title: topic,
    rule: "weekly mon 10:00",
    tz: "Asia/Taipei",
    duration_min: null,
    lead_min: null,
    rt: "none",
    rt_locked: false,
    state: "on",
    locked: true,
    by: "captain",
    created_at: "2026-11-26T06:00:00Z",
    ...extra,
  };
}

function open(id: string, atMs: number, extra: Partial<Occurrence> = {}): Occurrence {
  return {
    series: id,
    at: new Date(atMs).toISOString(),
    state: "upcoming",
    opened_at: new Date(atMs - 15 * MINUTE).toISOString(),
    closes_by: new Date(atMs + 60 * MINUTE).toISOString(),
    ...extra,
  };
}

function key(id: string, atMs: number): string {
  const d = new Date(atMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${id}:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z`;
}

/** Three schedules open at once: none at T, hard-rt at T + 30 min, soft-rt at T - 5 min. */
function busy(): ScheduleStore {
  const store = emptySchedules();
  store.series["sync"] = series("old-sync", { rule: "daily 10:00" });
  store.series["mail"] = series("mail", { rule: "daily 10:30", rt: "hard-rt" });
  store.series["ops"] = series("ops", { rule: "daily 09:55", rt: "soft-rt" });
  store.occurrences[key("sync", T)] = open("sync", T);
  store.occurrences[key("mail", T + 30 * MINUTE)] = open("mail", T + 30 * MINUTE);
  store.occurrences[key("ops", T - 5 * MINUTE)] = open("ops", T - 5 * MINUTE, {
    state: "taken",
    taken_at: new Date(T - 4 * MINUTE).toISOString(),
    note: "10:40 有空位再開",
  });
  return store;
}

describe("the 現在 strip", () => {
  it("orders hard-rt, then soft-rt, then none, then by time", () => {
    const view = scheduleView(busy(), topics(), [], T);
    expect(view.now.map((entry) => [entry.series, entry.rt])).toEqual([
      ["mail", "hard-rt"],
      ["ops", "soft-rt"],
      ["sync", "none"],
    ]);
    const same = [
      { rt: "none" as const, at: 2 },
      { rt: "none" as const, at: 1 },
      { rt: "soft-rt" as const, at: 3 },
    ].toSorted(nowOrder);
    expect(same).toEqual([
      { rt: "soft-rt", at: 3 },
      { rt: "none", at: 1 },
      { rt: "none", at: 2 },
    ]);
  });

  it("shows local times, state, who took it and the merged-into topic", () => {
    const view = scheduleView(busy(), topics(), [], T);
    const ops = view.now.find((entry) => entry.series === "ops");
    expect(ops).toMatchObject({
      local: "11-30（一）09:55",
      state: "taken",
      taken_local: "11-30（一）09:56",
      note: "10:40 有空位再開",
      closes_local: "11-30（一）10:55",
      closes_by: T + 55 * MINUTE,
    });
    expect(view.now.find((entry) => entry.series === "sync")).toMatchObject({
      topic: "sync",
      state: "upcoming",
      taken_at: null,
      note: null,
    });
  });

  it("treats an occurrence past its closes_by as ended, though the file still holds it", () => {
    const store = busy();
    expect(openKeys(store, T + 55 * MINUTE - 1)).toHaveLength(3);
    expect(openKeys(store, T + 55 * MINUTE)).toEqual([
      key("mail", T + 30 * MINUTE),
      key("sync", T),
    ]);
    const view = scheduleView(store, topics(), [], T + 60 * MINUTE);
    expect(view.now.map((entry) => entry.series)).toEqual(["mail"]);
    expect(view.series.find((entry) => entry.id === "sync")?.open).toBeNull();
    expect(view.series.find((entry) => entry.id === "mail")?.open).toBe(
      key("mail", T + 30 * MINUTE),
    );
    expect(scheduleView(emptySchedules(), topics(), [], T).now).toEqual([]);
  });
});

describe("a schedule's card", () => {
  it("names its rule, next occurrences, effective minutes and the topic it is on now", () => {
    const store = emptySchedules();
    store.series["sync"] = series("old-sync", { rule: "weekly mon,thu 10:00", lead_min: 5 });
    const [card] = scheduleView(store, topics(), [], T + 1).series;
    expect(card).toMatchObject({
      id: "sync",
      topic: "sync",
      rule_text: "每週一、四 10:00",
      days: ["mon", "thu"],
      at: "10:00",
      lead_min: 5,
      duration_min: null,
      lead: 5,
      duration: 60,
      rings: true,
      new: false,
      awaiting_enable: false,
      open: null,
      strip: [],
    });
    expect(card?.next.map((entry) => entry.local)).toEqual([
      "12-03（四）10:00",
      "12-07（一）10:00",
      "12-10（四）10:00",
    ]);
    const daily = emptySchedules();
    daily.series["mail"] = series("mail", { rule: "daily 06:00" });
    expect(scheduleView(daily, topics(), [], T).series[0]).toMatchObject({
      days: "daily",
      at: "06:00",
    });
  });

  it("marks the aggregator's unseen schedule 新, and as waiting for 啟用 when the setting says so", () => {
    const store = emptySchedules();
    store.series["mail"] = series("mail", { by: "aggregator", seen: false, locked: false });
    store.series["ops"] = series("ops", { by: "aggregator", seen: true, locked: false });
    let [mail, ops] = scheduleView(store, topics(), [], T).series;
    expect([mail?.new, mail?.awaiting_enable, mail?.rings]).toEqual([true, false, true]);
    expect([ops?.new, ops?.awaiting_enable]).toEqual([false, false]);
    store.settings.aggregator_needs_enable = true;
    [mail, ops] = scheduleView(store, topics(), [], T).series;
    expect([mail?.new, mail?.awaiting_enable, mail?.rings]).toEqual([true, true, false]);
    expect(ops?.rings).toBe(true);
    store.settings.all_paused = true;
    expect(scheduleView(store, topics(), [], T).series[1]?.rings).toBe(false);
  });

  it("lists its last ten newest first, saying which skips came before their time", () => {
    const store = emptySchedules();
    store.series["sync"] = series("sync");
    const week = 7 * 24 * 60 * MINUTE;
    store.recent["sync"] = [
      { key: key("sync", T - 2 * week), outcome: "missed", by: "board", count: 3 },
      {
        key: key("sync", T - week),
        outcome: "done",
        by: "aggregator",
        note: "會議紀錄已整理",
        closed_at: new Date(T - week + 80 * MINUTE).toISOString(),
      },
      {
        key: key("sync", T),
        outcome: "skipped",
        by: "captain",
        closed_at: new Date(T - 3 * 24 * 60 * MINUTE).toISOString(),
      },
    ];
    const strip = scheduleView(store, topics(), [], T - 4 * 24 * 60 * MINUTE).series[0]?.strip;
    expect(strip).toEqual([
      {
        key: key("sync", T),
        local: "11-30（一）10:00",
        outcome: "skipped",
        by: "captain",
        advance: true,
        note: null,
        closed_at: T - 3 * 24 * 60 * MINUTE,
        count: null,
      },
      {
        key: key("sync", T - week),
        local: "11-23（一）10:00",
        outcome: "done",
        by: "aggregator",
        advance: false,
        note: "會議紀錄已整理",
        closed_at: T - week + 80 * MINUTE,
        count: null,
      },
      {
        key: key("sync", T - 2 * week),
        local: "11-16（一）10:00",
        outcome: "missed",
        by: "board",
        advance: false,
        note: null,
        closed_at: null,
        count: 3,
      },
    ]);
  });
});

describe("the settings and the recent changes", () => {
  it("hands the page the settings with their defaults, ranges and choices", () => {
    const store = emptySchedules();
    store.settings.lead_min = 20;
    store.series["sync"] = series("sync");
    store.series["mail"] = series("mail", { state: "paused" });
    const view = scheduleView(store, topics(), [], T);
    expect(view.settings.lead_min).toBe(20);
    expect(view.defaults.lead_min).toBe(15);
    expect(view.ranges.lead_min).toEqual([0, 120]);
    expect(view.missed_modes).toEqual(["notice", "due", "record"]);
    expect(view.rt_values).toEqual(["none", "soft-rt", "hard-rt"]);
    expect(view.active).toBe(1);
    expect(view.series.map((entry) => entry.id)).toEqual(["mail", "sync"]);
  });

  it("lists the aggregator's schedule changes since the last seen mark, with their reverts", () => {
    const records: (ScheduleRecord & { topic: string | null; text: string })[] = [
      { rid: "r1", ts: 1, kind: "schedule.created", by: "aggregator", topic: "mail", text: "建了" },
      { rid: "r2", ts: 2, kind: "schedule.seen", by: "captain", topic: null, text: "看過" },
      { rid: "r3", ts: 3, kind: "schedule.paused", by: "aggregator", topic: "mail", text: "停了" },
      { rid: "r4", ts: 4, kind: "schedule.edited", by: "captain", topic: "mail", text: "改了" },
      { rid: "r5", ts: 5, kind: "schedule.rt_changed", by: "aggregator", topic: "ops", text: "rt" },
      {
        rid: "r6",
        ts: 6,
        kind: "schedule.reverted",
        by: "captain",
        topic: "ops",
        text: "撤",
        ref: "r5",
      },
      { rid: "r7", ts: 7, kind: "occurrence.taken", by: "aggregator", topic: "ops", text: "接了" },
    ];
    expect(scheduleView(emptySchedules(), topics(), records, T).recent).toEqual([
      { rid: "r5", ts: 5, topic: "ops", text: "rt", reverted: true },
      { rid: "r3", ts: 3, topic: "mail", text: "停了", reverted: false },
    ]);
  });
});
