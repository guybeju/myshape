import { describe, expect, it } from "vitest";
import { changesInLastHour } from "#board/oversight.js";
import { localLabel, occurrenceAfter, occurrenceKey, parseRule } from "#board/schedule-time.js";
import {
  WATCHED,
  addSchedule,
  closeOccurrence,
  deleteSchedule,
  editSchedule,
  effective,
  emptySchedules,
  hasEnded,
  isNew,
  isValidScheduleId,
  markSeen,
  nextOccurrence,
  overlapProblem,
  parseSchedules,
  pauseForArchive,
  revertChange,
  setAllPaused,
  setLock,
  setPaused,
  setRt,
  skipNext,
  takeOccurrence,
  updateSettings,
} from "#board/schedules.js";
import type {
  ScheduleEnv,
  ScheduleRecord,
  ScheduleInput,
  ScheduleResult,
  ScheduleStore,
  Series,
} from "#board/schedules.js";
import { emptyState } from "#board/topics.js";
import { generator } from "#board/seeded-random.test-helper.js";
import type { TopicState } from "#board/topics.js";

const MINUTE = 60_000;
// Thursday 2026-11-26 14:00 in Taipei.
const NOW = Date.UTC(2026, 10, 26, 6, 0);

function topicsFixture(): TopicState {
  const state = emptyState();
  const topic = (name: string) => ({
    name,
    goal: "g",
    status: "confirmed" as const,
    created_at: "T",
  });
  state.doc.topics = { sync: topic("週會"), mail: topic("看信"), hot: topic("Hot") };
  state.doc.queues = { high: ["hot"], normal: [], later: ["sync", "mail"] };
  state.archive.topics = { old: { ...topic("Old"), archived_at: "T" } };
  return state;
}

function env(
  by: "captain" | "aggregator" = "aggregator",
  extra: Partial<ScheduleEnv> = {},
): ScheduleEnv {
  return {
    topics: topicsFixture(),
    nowMs: NOW,
    actor: { by, label: "first-mate-label" },
    records: [],
    machineZone: "Asia/Taipei",
    ...extra,
  };
}

const WEEKLY: ScheduleInput = { topic: "sync", days: ["mon"], at: { hour: 10, minute: 0 } };

/** The store a change made; fails the test when it made none. */
function storeOf(result: ScheduleResult): ScheduleStore {
  if (!result.ok || !result.changed)
    throw new Error(`expected a change: ${JSON.stringify(result)}`);
  return result.store;
}

function lineOf(result: ScheduleResult): string {
  return result.ok ? result.line : `refused: ${result.line}`;
}

function added(by: "captain" | "aggregator" = "captain", input = WEEKLY): ScheduleStore {
  return storeOf(addSchedule(emptySchedules(), env(by), input));
}

function seriesOf(store: ScheduleStore, id = "sync"): Series {
  const series = store.series[id];
  if (series === undefined) throw new Error(`no schedule ${id}`);
  return series;
}

/** A store whose schedule `sync` has an occurrence opened by the clock (PR 2). */
function withOpen(store: ScheduleStore, at: number, closesBy: number): ScheduleStore {
  const next = structuredClone(store);
  next.occurrences[occurrenceKey("sync", at)] = {
    series: "sync",
    at: new Date(at).toISOString(),
    state: "upcoming",
    opened_at: new Date(at - 15 * MINUTE).toISOString(),
    closes_by: new Date(closesBy).toISOString(),
  };
  return next;
}

describe("schedule add", () => {
  it("puts a captain's schedule on a topic in 待辦, locked, with the earliest occurrence", () => {
    const result = addSchedule(emptySchedules(), env("captain"), WEEKLY);
    expect(lineOf(result)).toBe(
      "ok sync 已排程：每週一 10:00（Asia/Taipei），最快的一場是 11-30（一）10:00",
    );
    const series = seriesOf(storeOf(result));
    expect(series).toMatchObject({
      topic: "sync",
      title: "週會",
      rule: "weekly mon 10:00",
      tz: "Asia/Taipei",
      duration_min: null,
      lead_min: null,
      rt: "none",
      state: "on",
      locked: true,
      by: "captain",
    });
    expect(series.seen).toBeUndefined();
    if (!result.ok || !result.changed) throw new Error("no change");
    expect(result.records[0]).toMatchObject({ kind: "schedule.created", topic: "sync" });
    expect(result.records[0].text).toMatch(/（你在頁面上）$/);
  });

  it("makes the aggregator's schedule unlocked and new until the captain sees it", () => {
    const series = seriesOf(added("aggregator"));
    expect(series).toMatchObject({ locked: false, by: "aggregator", seen: false });
    expect(isNew(series)).toBe(true);
  });

  it("refuses a topic outside 待辦, an archived one and a missing one", () => {
    expect(lineOf(addSchedule(emptySchedules(), env(), { ...WEEKLY, topic: "hot" }))).toContain(
      "先把議題移到待辦",
    );
    expect(lineOf(addSchedule(emptySchedules(), env(), { ...WEEKLY, topic: "old" }))).toContain(
      "已封存",
    );
    expect(lineOf(addSchedule(emptySchedules(), env(), { ...WEEKLY, topic: "nope" }))).toContain(
      "沒有 nope",
    );
  });

  it("keeps one schedule per topic: the same again changes nothing, another is refused", () => {
    const store = added();
    expect(addSchedule(store, env("captain"), WEEKLY)).toMatchObject({ ok: true, changed: false });
    expect(lineOf(addSchedule(store, env(), { ...WEEKLY, at: { hour: 9, minute: 0 } }))).toContain(
      "一個議題最多一筆排程",
    );
  });

  it("takes the zone, minutes and rt it is given, and checks their ranges", () => {
    const store = storeOf(
      addSchedule(emptySchedules(), env("captain"), {
        ...WEEKLY,
        tz: "America/New_York",
        duration: 30,
        lead: 0,
        rt: "hard-rt",
      }),
    );
    expect(seriesOf(store)).toMatchObject({
      tz: "America/New_York",
      duration_min: 30,
      lead_min: 0,
      rt: "hard-rt",
    });
    for (const bad of [{ tz: "Mars/Base" }, { duration: 4 }, { duration: 481 }, { lead: 121 }]) {
      expect(addSchedule(emptySchedules(), env(), { ...WEEKLY, ...bad })).toMatchObject({
        ok: false,
        code: "usage",
      });
    }
    for (const partial of [{ days: ["mon"] as const }, { at: { hour: 9, minute: 0 } }, {}]) {
      expect(addSchedule(emptySchedules(), env(), { topic: "sync", ...partial })).toMatchObject({
        code: "usage",
      });
    }
  });

  it("uses the settings' zone and rt for a schedule made without them", () => {
    const store = emptySchedules();
    store.settings.default_tz = "Europe/London";
    store.settings.default_rt = "soft-rt";
    expect(seriesOf(storeOf(addSchedule(store, env("captain"), WEEKLY)))).toMatchObject({
      tz: "Europe/London",
      rt: "soft-rt",
    });
    expect(seriesOf(added()).tz).toBe("Asia/Taipei");
  });

  it("holds the aggregator to the settings: creating, the active cap and setting rt", () => {
    const closed = emptySchedules();
    closed.settings.aggregator_may_create = false;
    expect(lineOf(addSchedule(closed, env(), WEEKLY))).toContain(
      "關掉了 first-mate-label 建立排程",
    );
    expect(addSchedule(closed, env("captain"), WEEKLY)).toMatchObject({ changed: true });
    const full = emptySchedules();
    full.settings.max_active = 1;
    const one = storeOf(addSchedule(full, env(), WEEKLY));
    const mail = { topic: "mail", days: "daily" as const, at: { hour: 6, minute: 0 } };
    expect(lineOf(addSchedule(one, env(), mail))).toContain("啟用中的排程已有 1 筆（上限 1）");
    expect(addSchedule(one, env("captain"), mail)).toMatchObject({ changed: true });
    const noRt = emptySchedules();
    noRt.settings.aggregator_may_set_rt = false;
    expect(lineOf(addSchedule(noRt, env(), { ...WEEKLY, rt: "hard-rt" }))).toContain("設 rt");
  });

  it("counts against the aggregator's hourly cap, and only the aggregator's", () => {
    const records = Array.from({ length: 10 }, (_, n) => ({
      rid: `r-${n}`,
      ts: NOW / 1000 - 60 * n,
      kind: "schedule.edited",
      by: "aggregator",
    }));
    const capped = env("aggregator", { records });
    expect(lineOf(addSchedule(emptySchedules(), capped, WEEKLY))).toContain(
      "refused: 超過每小時上限：一小時內已經改了 10 次，上限是 10 次。",
    );
    expect(
      addSchedule(emptySchedules(), env("aggregator", { records: records.slice(1) }), WEEKLY),
    ).toMatchObject({
      changed: true,
    });
    const captain = env("captain", { records });
    expect(addSchedule(emptySchedules(), captain, WEEKLY)).toMatchObject({ changed: true });
    // A repeat that changes nothing is not refused by the cap.
    expect(addSchedule(added("aggregator"), capped, WEEKLY)).toMatchObject({ changed: false });
  });

  it("refuses minutes that would open two occurrences of one schedule at once", () => {
    const store = emptySchedules();
    store.settings.max_open_min = 1440;
    const daily = { topic: "mail", days: "daily" as const, at: { hour: 6, minute: 0 } };
    expect(lineOf(addSchedule(store, env("captain"), daily))).toContain("會同時開著兩場");
    expect(
      addSchedule(store, env("captain"), { ...daily, days: ["mon"], lead: 120 }),
    ).toMatchObject({ changed: true });
  });

  it("gives a schedule the topic's id, never one in use or deleted, within 64 characters", () => {
    const long = "x".repeat(64);
    const topics = topicsFixture();
    topics.doc.topics[long] = { name: "L", goal: "g", status: "confirmed", created_at: "T" };
    topics.doc.queues.later.push(long);
    const input = { ...WEEKLY, topic: long };
    const first = storeOf(addSchedule(emptySchedules(), env("captain", { topics }), input));
    expect(Object.keys(first.series)).toEqual([long]);
    const deleted = storeOf(deleteSchedule(first, env("captain", { topics }), long));
    const again = storeOf(addSchedule(deleted, env("captain", { topics }), input));
    const ids = Object.keys(again.series);
    expect(ids).toEqual([`${"x".repeat(60)}-2`]);
    expect(ids.every(isValidScheduleId)).toBe(true);
    expect(isValidScheduleId("x".repeat(65))).toBe(false);
    expect(isValidScheduleId("-x")).toBe(false);
    expect(isValidScheduleId("a b")).toBe(false);
  });
});

describe("the first-ring rule", () => {
  // Thursday 09:30 in Taipei: a daily 10:00 with 15 minutes' lead rings at 09:45.
  const morning = Date.UTC(2026, 10, 26, 1, 30);
  const daily: ScheduleInput = { topic: "mail", days: "daily", at: { hour: 10, minute: 0 } };

  it("skips the aggregator's occurrences that would ring within the hour, and says the earliest", () => {
    const result = addSchedule(emptySchedules(), env("aggregator", { nowMs: morning }), daily);
    expect(lineOf(result)).toBe(
      "ok mail 已排程：每天 10:00（Asia/Taipei），60 分鐘內的 1 場略過，最快的一場是 11-27（五）10:00",
    );
    const store = storeOf(result);
    expect(store.recent["mail"]).toEqual([
      {
        key: "mail:20261126T0200Z",
        outcome: "skipped",
        by: "board",
        note: "first-mate-label 建立或改時間後 60 分鐘內不響",
        closed_at: "2026-11-26T01:30:00Z",
      },
    ]);
    expect(nextOccurrence(store, "mail", morning)).toBe(Date.UTC(2026, 10, 27, 2, 0));
  });

  it("does not hold back the captain", () => {
    const result = addSchedule(emptySchedules(), env("captain", { nowMs: morning }), daily);
    expect(lineOf(result)).toContain("最快的一場是 11-26（四）10:00");
    expect(storeOf(result).recent).toEqual({});
  });

  it("measures the bell: a longer lead makes an occurrence ring sooner", () => {
    const early = Date.UTC(2026, 10, 26, 0, 30); // 08:30, 90 minutes before 10:00
    const fine = addSchedule(emptySchedules(), env("aggregator", { nowMs: early }), daily);
    expect(lineOf(fine)).toContain("最快的一場是 11-26（四）10:00");
    const long = addSchedule(emptySchedules(), env("aggregator", { nowMs: early }), {
      ...daily,
      lead: 45,
    });
    expect(lineOf(long)).toContain("略過，最快的一場是 11-27（五）10:00");
  });

  it("follows first_bell_min_ahead, and skips nothing at 0", () => {
    const store = emptySchedules();
    store.settings.first_bell_min_ahead = 0;
    const result = addSchedule(store, env("aggregator", { nowMs: morning }), daily);
    expect(lineOf(result)).toContain("最快的一場是 11-26（四）10:00");
    expect(storeOf(result).recent).toEqual({});
  });

  it("holds an aggregator's retime and lead change to it too, but not a duration change", () => {
    const store = storeOf(
      addSchedule(emptySchedules(), env("captain"), { ...daily, at: { hour: 18, minute: 0 } }),
    );
    const unlocked = storeOf(setLock(store, env("captain"), "mail", "schedule", false));
    const retimed = editSchedule(unlocked, env("aggregator", { nowMs: morning }), {
      topic: "mail",
      at: { hour: 10, minute: 0 },
    });
    expect(lineOf(retimed)).toContain("略過，最快的一場是 11-27（五）10:00");
    const longer = editSchedule(
      unlocked,
      env("aggregator", { nowMs: Date.UTC(2026, 10, 26, 9, 30) }),
      {
        topic: "mail",
        lead: 60,
      },
    );
    expect(lineOf(longer)).toContain("略過，最快的一場是 11-27（五）18:00");
    const duration = editSchedule(
      unlocked,
      env("aggregator", { nowMs: Date.UTC(2026, 10, 26, 9, 30) }),
      {
        topic: "mail",
        duration: 30,
      },
    );
    expect(lineOf(duration)).toContain("最快的一場是 11-26（四）18:00");
  });
});

describe("schedule edit", () => {
  it("changes the rule, time, zone and minutes, and says when the next one is", () => {
    const store = added("aggregator");
    const result = editSchedule(store, env(), {
      topic: "sync",
      days: ["tue", "fri"],
      at: { hour: 9, minute: 30 },
      duration: 45,
    });
    expect(lineOf(result)).toBe(
      "ok sync 排程已改：每週二、五 09:30（Asia/Taipei），最快的一場是 11-27（五）09:30",
    );
    expect(seriesOf(storeOf(result))).toMatchObject({
      rule: "weekly tue,fri 09:30",
      duration_min: 45,
    });
    expect(editSchedule(storeOf(result), env(), { topic: "sync", duration: 45 })).toMatchObject({
      changed: false,
    });
  });

  it("keeps the days of a schedule whose time alone changes, and its time when only the days do", () => {
    const daily = storeOf(
      addSchedule(emptySchedules(), env(), {
        topic: "mail",
        days: "daily",
        at: { hour: 6, minute: 0 },
      }),
    );
    const later = storeOf(
      editSchedule(daily, env(), { topic: "mail", at: { hour: 7, minute: 15 } }),
    );
    expect(seriesOf(later, "mail").rule).toBe("daily 07:15");
    const weekly = storeOf(editSchedule(later, env(), { topic: "mail", days: ["sat"] }));
    expect(seriesOf(weekly, "mail").rule).toBe("weekly sat 07:15");
    const daysKept = storeOf(
      editSchedule(weekly, env(), { topic: "mail", at: { hour: 8, minute: 0 } }),
    );
    expect(seriesOf(daysKept, "mail").rule).toBe("weekly sat 08:00");
  });

  it("refuses the aggregator on a locked schedule, and lets the captain", () => {
    const locked = added("captain");
    expect(lineOf(editSchedule(locked, env(), { topic: "sync", lead: 5 }))).toContain("上了鎖");
    expect(editSchedule(locked, env("captain"), { topic: "sync", lead: 5 })).toMatchObject({
      changed: true,
    });
  });

  it("leaves an open occurrence alone and applies the new rule after it closes", () => {
    const at = Date.UTC(2026, 10, 30, 2, 0);
    const open = withOpen(added("aggregator"), at, at + 3 * 60 * MINUTE);
    const result = editSchedule(open, env("aggregator", { nowMs: at }), {
      topic: "sync",
      days: "daily",
      at: { hour: 11, minute: 0 },
    });
    const store = storeOf(result);
    expect(store.occurrences).toEqual(open.occurrences);
    // 11:00 that day opens at 10:45, before the open one closes at 13:00.
    expect(localLabel("Asia/Taipei", nextOccurrence(store, "sync", at))).toBe("12-01（二）11:00");
  });

  it("drops a skip made in advance that the new rule no longer has", () => {
    const skipped = storeOf(skipNext(added("aggregator"), env(), "sync"));
    expect(skipped.recent["sync"]).toHaveLength(1);
    const kept = storeOf(editSchedule(skipped, env(), { topic: "sync", duration: 30 }));
    expect(kept.recent["sync"]).toHaveLength(1);
    const moved = storeOf(editSchedule(skipped, env("captain"), { topic: "sync", days: ["tue"] }));
    expect(moved.recent["sync"]).toBeUndefined();
  });

  it("refuses minutes that would overlap, and a topic with no schedule", () => {
    const daily = storeOf(
      addSchedule(emptySchedules(), env(), {
        topic: "mail",
        days: "daily",
        at: { hour: 6, minute: 0 },
      }),
    );
    const store = structuredClone(daily);
    store.settings.max_open_min = 1300;
    expect(lineOf(editSchedule(store, env(), { topic: "mail", lead: 30 }))).toContain(
      "同時開著兩場",
    );
    expect(lineOf(editSchedule(daily, env(), { topic: "sync", lead: 1 }))).toContain("沒有排程");
    expect(editSchedule(daily, env(), { topic: "mail", rt: "hard-rt" })).toMatchObject({
      code: "usage",
    });
  });
});

describe("pause, resume, skip and rt", () => {
  it("pauses and resumes, each once", () => {
    const paused = storeOf(setPaused(added("aggregator"), env(), "sync", true));
    expect(seriesOf(paused).state).toBe("paused");
    expect(setPaused(paused, env(), "sync", true)).toMatchObject({ changed: false });
    expect(seriesOf(storeOf(setPaused(paused, env(), "sync", false))).state).toBe("on");
  });

  it("keeps an open occurrence open while paused", () => {
    const at = Date.UTC(2026, 10, 30, 2, 0);
    const open = withOpen(added("aggregator"), at, at + 60 * MINUTE);
    expect(storeOf(setPaused(open, env(), "sync", true)).occurrences).toEqual(open.occurrences);
  });

  it("makes an aggregator's new schedule wait for the captain when the settings ask", () => {
    const store = storeOf(setPaused(added("aggregator"), env(), "sync", true));
    store.settings.aggregator_needs_enable = true;
    expect(lineOf(setPaused(store, env(), "sync", false))).toContain("要等 captain 在頁面上按啟用");
    const seen = storeOf(markSeen(store, env("captain")));
    expect(setPaused(seen, env(), "sync", false)).toMatchObject({ changed: true });
  });

  it("does not let the aggregator resume past the active cap", () => {
    const store = storeOf(setPaused(added("aggregator"), env(), "sync", true));
    const other = storeOf(
      addSchedule(store, env(), { topic: "mail", days: "daily", at: { hour: 6, minute: 0 } }),
    );
    other.settings.max_active = 1;
    expect(lineOf(setPaused(other, env(), "sync", false))).toContain("上限 1");
    expect(setPaused(other, env("captain"), "sync", false)).toMatchObject({ changed: true });
  });

  it("skips the next occurrence once; asking again changes nothing", () => {
    const store = added("aggregator");
    const result = skipNext(store, env(), "sync");
    expect(lineOf(result)).toBe("ok sync 跳過 11-30（一）10:00 那一場，下一場是 12-07（一）10:00");
    const skipped = storeOf(result);
    expect(skipNext(skipped, env(), "sync")).toMatchObject({ changed: false });
    expect(nextOccurrence(skipped, "sync", NOW)).toBe(Date.UTC(2026, 11, 7, 2, 0));
  });

  it("skips past the first-ring rule's skips, not onto them", () => {
    const morning = Date.UTC(2026, 10, 26, 1, 30);
    const daily: ScheduleInput = { topic: "mail", days: "daily", at: { hour: 10, minute: 0 } };
    const store = storeOf(
      addSchedule(emptySchedules(), env("aggregator", { nowMs: morning }), daily),
    );
    expect(lineOf(skipNext(store, env("aggregator", { nowMs: morning }), "mail"))).toContain(
      "跳過 11-27（五）10:00 那一場",
    );
  });

  it("sets rt unless the schedule or its rt is locked, or the settings forbid it", () => {
    const store = added("aggregator");
    const hard = storeOf(setRt(store, env(), "sync", "hard-rt"));
    expect(seriesOf(hard).rt).toBe("hard-rt");
    expect(setRt(hard, env(), "sync", "hard-rt")).toMatchObject({ changed: false });
    const rtLocked = storeOf(setLock(store, env("captain"), "sync", "rt", true));
    expect(lineOf(setRt(rtLocked, env(), "sync", "soft-rt"))).toContain("rt 上了鎖");
    expect(setPaused(rtLocked, env(), "sync", true)).toMatchObject({ changed: true });
    const off = structuredClone(store);
    off.settings.aggregator_may_set_rt = false;
    expect(lineOf(setRt(off, env(), "sync", "soft-rt"))).toContain("關掉了");
    expect(setRt(off, env("captain"), "sync", "soft-rt")).toMatchObject({ changed: true });
  });
});

describe("schedule delete", () => {
  it("keeps the deleted schedule for 30 days and says so; a repeat changes nothing", () => {
    const result = deleteSchedule(added("aggregator"), env(), "sync");
    expect(lineOf(result)).toBe("ok sync 排程已刪除");
    const store = storeOf(result);
    expect(store.series).toEqual({});
    expect(store.removed["sync"]).toMatchObject({
      topic: "sync",
      removed_at: "2026-11-26T06:00:00Z",
      removed_by: "aggregator",
    });
    expect(deleteSchedule(store, env(), "sync")).toMatchObject({ changed: false });
  });

  it("lets the aggregator delete only its own unlocked schedules", () => {
    expect(lineOf(deleteSchedule(added("captain"), env(), "sync"))).toContain("上了鎖");
    const unlocked = storeOf(setLock(added("captain"), env("captain"), "sync", "schedule", false));
    expect(lineOf(deleteSchedule(unlocked, env(), "sync"))).toContain("只能刪自己建的排程");
    expect(deleteSchedule(unlocked, env("captain"), "sync")).toMatchObject({ changed: true });
  });

  it("ends an open occurrence of the deleted schedule", () => {
    const at = Date.UTC(2026, 10, 30, 2, 0);
    const result = deleteSchedule(withOpen(added("aggregator"), at, at + MINUTE), env(), "sync");
    const store = storeOf(result);
    expect(store.occurrences).toEqual({});
    expect(store.recent["sync"]?.[0]).toMatchObject({ outcome: "skipped", note: "排程已刪除" });
    if (!result.ok || !result.changed) throw new Error("no change");
    expect(result.records.map((record) => record.kind)).toEqual([
      "schedule.deleted",
      "occurrence.closed",
    ]);
  });

  it("forgets deleted schedules older than 30 days at the next deletion", () => {
    const store = storeOf(deleteSchedule(added("aggregator"), env(), "sync"));
    const later = env("aggregator", { nowMs: NOW + 31 * 24 * 60 * MINUTE });
    const mail = storeOf(
      addSchedule(store, later, { topic: "mail", days: "daily", at: { hour: 6, minute: 0 } }),
    );
    expect(Object.keys(mail.removed)).toEqual(["sync"]);
    expect(Object.keys(storeOf(deleteSchedule(mail, later, "mail")).removed)).toEqual(["mail"]);
  });
});

describe("taking and closing an occurrence", () => {
  const at = Date.UTC(2026, 10, 30, 2, 0);
  const key = "sync:20261130T0200Z";
  const open = (): ScheduleStore => withOpen(added("captain"), at, at + 60 * MINUTE);

  it("takes one on a locked schedule, keeps it open up to its time plus the longest open time", () => {
    const result = takeOccurrence(
      open(),
      env("aggregator", { nowMs: at + 2 * MINUTE }),
      key,
      "10:40 有空位再開",
    );
    expect(lineOf(result)).toBe("ok sync:20261130T0200Z 已接下，最晚 11-30（一）13:00 結束");
    expect(storeOf(result).occurrences[key]).toMatchObject({
      state: "taken",
      taken_at: "2026-11-30T02:02:00Z",
      note: "10:40 有空位再開",
      closes_by: "2026-11-30T05:00:00Z",
    });
    const again = takeOccurrence(storeOf(result), env(), key);
    expect(again).toMatchObject({ changed: false });
  });

  it("takes one before its time too", () => {
    const result = takeOccurrence(open(), env("aggregator", { nowMs: at - 10 * MINUTE }), key);
    expect(storeOf(result).occurrences[key]?.state).toBe("taken");
  });

  it("treats one past its closes_by as ended, and refuses an unknown key", () => {
    expect(hasEnded(open().occurrences[key] as never, at + 60 * MINUTE)).toBe(true);
    expect(
      lineOf(takeOccurrence(open(), env("aggregator", { nowMs: at + 61 * MINUTE }), key)),
    ).toContain("已在");
    expect(lineOf(takeOccurrence(open(), env(), "sync:20261207T0200Z"))).toContain(
      "不是開著的一場",
    );
    expect(takeOccurrence(open(), env(), key, "兩\n行")).toMatchObject({ code: "usage" });
  });

  it("closes one into the last ten, once", () => {
    const result = closeOccurrence(open(), env(), key, "done", "會議紀錄已整理");
    const store = storeOf(result);
    expect(store.occurrences).toEqual({});
    expect(store.recent["sync"]).toEqual([
      {
        key,
        outcome: "done",
        by: "aggregator",
        note: "會議紀錄已整理",
        closed_at: "2026-11-26T06:00:00Z",
      },
    ]);
    expect(closeOccurrence(store, env(), key, "done")).toMatchObject({ changed: false });
    expect(lineOf(closeOccurrence(store, env(), key, "skipped"))).toContain("已經結束（done）");
    if (!result.ok || !result.changed) throw new Error("no change");
    expect(result.records[0]).toMatchObject({
      kind: "occurrence.closed",
      outcome: "done",
      topic: "sync",
    });
  });

  it("keeps the last ten of a schedule", () => {
    let store = added("captain");
    for (let week = 0; week < 12; week += 1) {
      const when = at + week * 7 * 24 * 60 * MINUTE;
      store = storeOf(
        closeOccurrence(
          withOpen(store, when, when + MINUTE),
          env(),
          occurrenceKey("sync", when),
          "done",
        ),
      );
    }
    expect(store.recent["sync"]).toHaveLength(10);
    expect(store.recent["sync"]?.[0]?.key).toBe(
      occurrenceKey("sync", at + 2 * 7 * 24 * 60 * MINUTE),
    );
  });
});

describe("the captain's settings and presses", () => {
  it("changes settings within their ranges, with a record of before and after", () => {
    const result = updateSettings(emptySchedules(), env("captain"), {
      lead_min: 30,
      missed: "record",
    });
    expect(lineOf(result)).toBe("ok 排程設定已改");
    if (!result.ok || !result.changed) throw new Error("no change");
    expect(result.records[0].text).toBe(
      "排程設定：提前幾分鐘送第一則 15 → 30；錯過的場次 notice → record（你在頁面上）",
    );
    expect(JSON.parse(result.records[0].after ?? "{}")).toMatchObject({ lead_min: 30 });
    expect(updateSettings(result.store, env("captain"), { lead_min: 30 })).toMatchObject({
      changed: false,
    });
    for (const bad of [
      { lead_min: 121 },
      { duration_min: 4 },
      { max_open_min: 14 },
      { max_active: 0 },
      { aggregator_changes_per_hour: 101 },
      { first_bell_min_ahead: 1441 },
      { late_after_min: 0 },
      { missed: "loud" },
      { default_rt: "rt" },
      { default_tz: "Nowhere/City" },
      { captain_locks_by_default: "yes" },
      { all_paused: true },
      { nonsense: 1 },
    ]) {
      expect(updateSettings(emptySchedules(), env("captain"), bad)).toMatchObject({
        code: "usage",
      });
    }
    expect(updateSettings(emptySchedules(), env("captain"), { default_tz: null })).toMatchObject({
      changed: false,
    });
  });

  it("refuses settings under which a schedule would have two occurrences open at once", () => {
    const store = storeOf(
      addSchedule(emptySchedules(), env("captain"), {
        topic: "mail",
        days: "daily",
        at: { hour: 6, minute: 0 },
      }),
    );
    expect(lineOf(updateSettings(store, env("captain"), { max_open_min: 1440 }))).toContain(
      "排程「看信」這樣設的話",
    );
    expect(updateSettings(store, env("captain"), { max_open_min: 1305 })).toMatchObject({
      changed: true,
    });
  });

  it("pauses everything at once, and locks and unlocks", () => {
    const paused = storeOf(setAllPaused(emptySchedules(), env("captain"), true));
    expect(paused.settings.all_paused).toBe(true);
    expect(setAllPaused(paused, env("captain"), true)).toMatchObject({ changed: false });
    const unlocked = storeOf(setLock(added(), env("captain"), "sync", "schedule", false));
    expect(seriesOf(unlocked).locked).toBe(false);
    expect(setLock(unlocked, env("captain"), "sync", "schedule", false)).toMatchObject({
      changed: false,
    });
  });

  it("marks the aggregator's changes and new schedules seen at once, with the seen record", () => {
    const result = markSeen(added("aggregator"), env("captain"));
    expect(lineOf(result)).toBe("ok 看過 first-mate-label 最近的排程改動（0 筆，新的排程 1 筆）");
    const seen = storeOf(result);
    expect(isNew(seriesOf(seen))).toBe(false);
    if (!result.ok || !result.changed) throw new Error("no change");
    expect(result.records[0]).toMatchObject({ kind: WATCHED.seen, topic: null });
    expect(markSeen(seen, env("captain"))).toMatchObject({ changed: false });
    expect(markSeen(added("captain"), env("captain"))).toMatchObject({ changed: false });
    const change = { rid: "r-1", ts: NOW / 1000, kind: "schedule.edited", by: "aggregator" };
    const counted = markSeen(added("captain"), env("captain", { records: [change] }));
    expect(lineOf(counted)).toContain("（1 筆，新的排程 0 筆）");
    const after = { rid: "r-2", ts: NOW / 1000, kind: "schedule.seen", by: "captain" };
    expect(markSeen(added("captain"), env("captain", { records: [change, after] }))).toMatchObject({
      changed: false,
    });
  });
});

describe("undoing a change from its record", () => {
  function logged(result: ScheduleResult, rid: string, by = "aggregator"): ScheduleRecord {
    if (!result.ok || !result.changed) throw new Error("no change");
    const [record] = result.records;
    return {
      rid,
      ts: NOW / 1000,
      kind: record.kind,
      by,
      ...(record.before === undefined ? {} : { before: record.before }),
      ...(record.after === undefined ? {} : { after: record.after }),
    };
  }

  function undo(store: ScheduleStore, records: ScheduleRecord[], rid: string, extra = {}) {
    return revertChange(store, env("captain", { records, ...extra }), rid);
  }

  it("takes back the aggregator's edit while the schedule is still as the edit left it, once", () => {
    const edit = editSchedule(added("aggregator"), env(), {
      topic: "sync",
      at: { hour: 15, minute: 0 },
    });
    const log = [logged(edit, "r-1")];
    const undone = undo(storeOf(edit), log, "r-1");
    expect(lineOf(undone)).toBe("ok 已撤回 r-1");
    expect(seriesOf(storeOf(undone)).rule).toBe("weekly mon 10:00");
    if (!undone.ok || !undone.changed) throw new Error("no change");
    expect(undone.records[0]).toMatchObject({ kind: WATCHED.reverted, ref: "r-1", topic: "sync" });
    const reverted = {
      rid: "r-9",
      ts: NOW / 1000,
      kind: "schedule.reverted",
      by: "captain",
      ref: "r-1",
    };
    expect(undo(storeOf(undone), [...log, reverted], "r-1")).toMatchObject({ changed: false });
    const moved = storeOf(setRt(storeOf(edit), env(), "sync", "soft-rt"));
    expect(lineOf(undo(moved, log, "r-1"))).toContain("在那之後又改過");
  });

  it("keeps the captain's seen mark when it takes a change back", () => {
    const seen = storeOf(markSeen(added("aggregator"), env("captain")));
    const edit = editSchedule(seen, env(), { topic: "sync", lead: 5 });
    const undone = storeOf(undo(storeOf(edit), [logged(edit, "r-1")], "r-1"));
    expect(seriesOf(undone)).toMatchObject({ lead_min: null, seen: true });
  });

  it("takes back a creation, a skip and a deletion", () => {
    const create = addSchedule(emptySchedules(), env(), WEEKLY);
    const gone = storeOf(undo(storeOf(create), [logged(create, "r-c")], "r-c"));
    expect(gone.series).toEqual({});
    expect(gone.removed["sync"]).toBeDefined();
    const skip = skipNext(added("aggregator"), env(), "sync");
    const unskipped = storeOf(undo(storeOf(skip), [logged(skip, "r-s")], "r-s"));
    expect(unskipped.recent["sync"]).toBeUndefined();
    const removal = deleteSchedule(added("aggregator"), env(), "sync");
    const back = undo(storeOf(removal), [logged(removal, "r-d")], "r-d");
    expect(seriesOf(storeOf(back))).toMatchObject({ rule: "weekly mon 10:00", by: "aggregator" });
    expect(storeOf(back).removed).toEqual({});
  });

  it("refuses the captain's own change, a deletion no longer kept, and a record that is not a change", () => {
    const edit = editSchedule(added("captain"), env("captain"), { topic: "sync", lead: 5 });
    expect(lineOf(undo(storeOf(edit), [logged(edit, "r-1", "captain")], "r-1"))).toContain(
      "不是 aggregator 做的改動",
    );
    const removal = deleteSchedule(added("aggregator"), env(), "sync");
    const forgotten = structuredClone(storeOf(removal));
    forgotten.removed = {};
    expect(lineOf(undo(forgotten, [logged(removal, "r-d")], "r-d"))).toContain(
      "刪掉已經超過 30 天",
    );
    const own = editSchedule(added("aggregator"), env(), { topic: "sync", lead: 5 });
    expect(lineOf(undo(storeOf(own), [], "r-3"))).toContain("找不到紀錄");
    const take = { rid: "r-4", ts: NOW / 1000, kind: "occurrence.taken", by: "aggregator" };
    expect(lineOf(undo(storeOf(own), [take], "r-4"))).toContain("不是 aggregator 做的改動");
    const blank = { rid: "r-5", ts: NOW / 1000, kind: "schedule.edited", by: "aggregator" };
    expect(lineOf(undo(storeOf(own), [blank], "r-5"))).toContain("改前改後讀不懂");
  });

  it("does not put a deleted schedule back on a topic that left 待辦", () => {
    const removal = deleteSchedule(added("aggregator"), env(), "sync");
    const topics = topicsFixture();
    topics.doc.queues = { high: ["hot", "sync"], normal: [], later: ["mail"] };
    expect(lineOf(undo(storeOf(removal), [logged(removal, "r-d")], "r-d", { topics }))).toContain(
      "先把議題移到待辦",
    );
  });
});

describe("where the clock starts counting again", () => {
  const LATER = NOW + 3 * 24 * 60 * MINUTE;
  const checked = (store: ScheduleStore): string | undefined => seriesOf(store).checked_through;
  const at = (ms: number) => env("captain", { nowMs: ms });

  it("restarts at a resume, so nothing paused is reported missed", () => {
    const paused = storeOf(setPaused(added(), env("captain"), "sync", true));
    expect(checked(paused)).toBeUndefined();
    expect(checked(storeOf(setPaused(paused, at(LATER), "sync", false)))).toBe(
      "2026-11-29T06:00:00Z",
    );
  });

  it("restarts when everything is switched back on, and not when it is switched off", () => {
    const all = storeOf(setAllPaused(added(), env("captain"), true));
    expect(checked(all)).toBeUndefined();
    expect(checked(storeOf(setAllPaused(all, at(LATER), false)))).toBe("2026-11-29T06:00:00Z");
  });

  it("restarts at a retime but not at an edit that moves no ring", () => {
    const store = added();
    expect(
      checked(storeOf(editSchedule(store, at(LATER), { topic: "sync", duration: 30 }))),
    ).toBeUndefined();
    expect(
      checked(
        storeOf(editSchedule(store, at(LATER), { topic: "sync", at: { hour: 9, minute: 0 } })),
      ),
    ).toBe("2026-11-29T06:00:00Z");
  });

  it("restarts the aggregator's schedules when the captain enables them", () => {
    const store = added("aggregator");
    store.settings.aggregator_needs_enable = true;
    expect(checked(storeOf(markSeen(store, at(LATER))))).toBe("2026-11-29T06:00:00Z");
    const lifted = storeOf(updateSettings(store, at(LATER), { aggregator_needs_enable: false }));
    expect(checked(lifted)).toBe("2026-11-29T06:00:00Z");
    expect(
      checked(storeOf(updateSettings(store, at(LATER), { late_after_min: 9 }))),
    ).toBeUndefined();
  });

  it("never moves it back", () => {
    const store = added();
    seriesOf(store).checked_through = "2026-12-31T00:00:00Z";
    const paused = storeOf(setPaused(store, env("captain"), "sync", true));
    expect(checked(storeOf(setPaused(paused, at(LATER), "sync", false)))).toBe(
      "2026-12-31T00:00:00Z",
    );
  });
});

describe("the aggregator's hourly cap", () => {
  it("counts the aggregator's schedule changes in the last hour only", () => {
    const now = NOW / 1000;
    const records: ScheduleRecord[] = [
      { ts: now - 10, kind: "schedule.edited", by: "aggregator" },
      { ts: now - 3599, kind: "schedule.rt_changed", by: "aggregator" },
      { ts: now - 3600, kind: "schedule.created", by: "aggregator" },
      { ts: now - 5, kind: "schedule.edited", by: "captain" },
      { ts: now - 5, kind: "occurrence.taken", by: "aggregator" },
    ];
    expect(changesInLastHour(records, WATCHED, now)).toBe(2);
  });
});

describe("archiving a scheduled topic", () => {
  it("pauses the schedule and ends an open occurrence, each with a record", () => {
    const at = Date.UTC(2026, 10, 30, 2, 0);
    const store = withOpen(added("aggregator"), at, at + MINUTE);
    const paused = pauseForArchive(store, env(), "sync");
    expect(paused?.store.series["sync"]?.state).toBe("paused");
    expect(paused?.store.occurrences).toEqual({});
    expect(paused?.records.map((record) => [record.kind, record.topic])).toEqual([
      ["schedule.paused", "sync"],
      ["occurrence.closed", "sync"],
    ]);
    expect(pauseForArchive(paused?.store as ScheduleStore, env(), "sync")).toBeNull();
    expect(pauseForArchive(store, env(), "mail")).toBeNull();
  });

  it("pauses a schedule with nothing open, and ends what is open on one already paused", () => {
    const on = pauseForArchive(added("aggregator"), env(), "sync");
    expect(on?.records.map((record) => record.kind)).toEqual(["schedule.paused"]);
    const at = Date.UTC(2026, 10, 30, 2, 0);
    const paused = storeOf(
      setPaused(withOpen(added("aggregator"), at, at + MINUTE), env(), "sync", true),
    );
    const closed = pauseForArchive(paused, env(), "sync");
    expect(closed?.records.map((record) => record.kind)).toEqual(["occurrence.closed"]);
    expect(closed?.store.occurrences).toEqual({});
  });
});

describe("reading schedules.json", () => {
  it("reads the design's example, keeping what the clock writes", () => {
    const raw = {
      v: 1,
      settings: {
        lead_min: 15,
        duration_min: 60,
        max_open_min: 180,
        missed: "notice",
        all_paused: false,
      },
      series: {
        "weekly-sync": {
          topic: "weekly-sync",
          title: "週會",
          rule: "weekly mon 10:00",
          tz: "Asia/Taipei",
          duration_min: 60,
          lead_min: null,
          rt: "hard-rt",
          rt_locked: false,
          state: "on",
          locked: true,
          by: "captain",
          created_at: "2026-11-26T06:00:00Z",
          checked_through: "2026-12-07T02:02:30Z",
        },
      },
      occurrences: {
        "weekly-sync:20261207T0200Z": {
          series: "weekly-sync",
          at: "2026-12-07T02:00:00Z",
          state: "taken",
          opened_at: "2026-12-07T01:45:03Z",
          taken_at: "2026-12-07T02:02:10Z",
          note: "10:40 有空位再開",
          closes_by: "2026-12-07T05:00:00Z",
          notices: { pre: "w-s-weekly-sync-20261207T0200Z-pre" },
        },
      },
      recent: {
        "weekly-sync": [
          {
            key: "weekly-sync:20261130T0200Z",
            outcome: "missed",
            by: "board",
            notice: "w-s-x",
            count: 3,
            from: "a",
            to: "b",
          },
        ],
      },
      removed: {},
    };
    const store = parseSchedules(raw);
    expect(store.series["weekly-sync"]?.checked_through).toBe("2026-12-07T02:02:30Z");
    expect(store.occurrences["weekly-sync:20261207T0200Z"]?.notices).toEqual({
      pre: "w-s-weekly-sync-20261207T0200Z-pre",
    });
    expect(store.recent["weekly-sync"]?.[0]).toMatchObject({
      notice: "w-s-x",
      count: 3,
      from: "a",
      to: "b",
    });
    expect(store.settings).toMatchObject({
      first_bell_min_ahead: 60,
      max_active: 20,
      default_tz: null,
    });
  });

  it("reads a bad setting as its default and skips entries that are not whole or whose id is not usable", () => {
    const series = (rule: string) => ({
      topic: "t",
      title: "T",
      rule,
      tz: "UTC",
      created_at: "T",
    });
    const store = parseSchedules({
      v: 1,
      settings: { lead_min: 500, missed: "loud", default_tz: "Nowhere/City" },
      series: {
        good: series("daily 06:00"),
        bad: series("hourly"),
        "-x": series("daily 06:00"),
        ["y".repeat(65)]: series("daily 06:00"),
      },
      occurrences: {
        nokey: { series: "good", at: "a", state: "due", opened_at: "a", closes_by: "b" },
      },
    });
    expect(store.settings).toMatchObject({ lead_min: 15, missed: "notice", default_tz: null });
    expect(Object.keys(store.series)).toEqual(["good"]);
    expect(store.series["good"]).toMatchObject({
      state: "paused",
      by: "captain",
      duration_min: null,
    });
    expect(store.occurrences).toEqual({});
    expect(() => parseSchedules({ v: 2 })).toThrow("v: 1");
  });
});

describe("properties", () => {
  const ZONES = [
    "Asia/Taipei",
    "America/New_York",
    "Australia/Lord_Howe",
    "Antarctica/Troll",
    "America/Santiago",
  ];
  const RULES = [
    "daily 00:00",
    "daily 02:30",
    "daily 23:45",
    "weekly mon 10:00",
    "weekly sun,sat 01:00",
    "weekly tue,wed,thu 00:30",
  ];

  it("never offers an occurrence again once it was handled, however the clock jumps", () => {
    const random = generator(2026);
    for (let run = 0; run < 40; run += 1) {
      const store = emptySchedules();
      const zone = ZONES[Math.floor(random() * ZONES.length)] as string;
      const rule = RULES[Math.floor(random() * RULES.length)] as string;
      store.series["s"] = { ...seriesOf(added()), topic: "sync", rule, tz: zone };
      let clock = Date.UTC(2026, 0, 1) + Math.floor(random() * 300) * 24 * 60 * MINUTE;
      const handled = new Set<string>();
      let latest = Number.NEGATIVE_INFINITY;
      for (let step = 0; step < 30; step += 1) {
        // Mostly forward, sometimes back by up to three days.
        clock += Math.floor((random() - 0.25) * 4 * 24 * 60) * MINUTE;
        const at = nextOccurrence(store, "s", clock);
        const key = occurrenceKey("s", at);
        expect(handled.has(key), `${zone} ${rule} ${key}`).toBe(false);
        expect(at).toBeGreaterThan(Math.max(clock, latest));
        handled.add(key);
        latest = Math.max(latest, at);
        const recent = store.recent["s"] ?? [];
        store.recent["s"] = [
          ...recent,
          { key, outcome: random() < 0.5 ? "done" : "missed", by: "board" },
        ].slice(-10);
      }
    }
  });

  it("never has two occurrences of one schedule open at once under settings it accepts", () => {
    const random = generator(77);
    let checked = 0;
    for (let run = 0; run < 300; run += 1) {
      const rule = parseRule(RULES[Math.floor(random() * RULES.length)] as string);
      if (rule === null) throw new Error("bad rule");
      const zone = ZONES[Math.floor(random() * ZONES.length)] as string;
      const minutes = {
        lead: Math.floor(random() * 121),
        duration: 5 + Math.floor(random() * 476),
        maxOpen: 15 + Math.floor(random() * 1426),
      };
      if (overlapProblem(rule, minutes) !== null) continue;
      checked += 1;
      let at = occurrenceAfter(
        rule,
        zone,
        Date.UTC(2025, 0, 1) + Math.floor(random() * 700) * 24 * 60 * MINUTE,
      );
      for (let step = 0; step < 20; step += 1) {
        const following = occurrenceAfter(rule, zone, at);
        const closes = at + Math.max(minutes.duration, minutes.maxOpen) * MINUTE;
        expect(
          following - minutes.lead * MINUTE,
          `${zone} ${JSON.stringify(minutes)}`,
        ).toBeGreaterThanOrEqual(closes);
        at = following;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("uses the settings for minutes a schedule leaves to them", () => {
    const settings = emptySchedules().settings;
    expect(effective({ lead_min: null, duration_min: 30 }, settings)).toEqual({
      lead: 15,
      duration: 30,
      maxOpen: 180,
    });
  });
});
