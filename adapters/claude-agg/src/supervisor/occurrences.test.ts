import { describe, expect, it } from "vitest";

import type { SchedulesFile } from "./board-files.js";
import {
  isOccurrenceKey,
  missedAction,
  missedReport,
  missedReportId,
  NOTE,
  NOTE_MAX,
  occurrencePhase,
  scheduleWork,
  workId,
  workOf,
  type ScheduleNotice,
  type TaskState,
  type WorkView,
} from "./occurrences.js";

const KEY = "s:20261207T0200Z";
const AT = Date.parse("2026-12-07T02:00:00Z");
const MIN = 60_000;

function schedules(
  occurrences: Record<string, { atMs?: number; closesByMs?: number; series?: string }> = {
    [KEY]: {},
  },
  rings = true,
): SchedulesFile {
  return {
    series: new Map([
      ["s", { topic: "t", rt: "hard-rt", rings }],
      ["u", { topic: "u", rt: "soft-rt", rings }],
    ]),
    occurrences: new Map(
      Object.entries(occurrences).map(([key, o]) => {
        const atMs = o.atMs ?? AT;
        const closesByMs = o.closesByMs ?? AT + 60 * MIN;
        return [
          key,
          {
            series: o.series ?? key.split(":")[0] ?? "",
            at: new Date(atMs).toISOString(),
            atMs,
            state: "upcoming" as const,
            closes_by: new Date(closesByMs).toISOString(),
            closesByMs,
          },
        ];
      }),
    ),
  };
}

function view(extra: Partial<WorkView> = {}): WorkView {
  return {
    schedules: schedules(),
    nowMs: AT - 5 * MIN,
    tasks: new Map(),
    queued: [],
    live: new Set(),
    planned: new Map(),
    usable: () => true,
    ...extra,
  };
}

describe("occurrence work ids", () => {
  it("names an occurrence's tasks after it and reads them back", () => {
    const work = { key: KEY, makeUp: false };
    const makeUp = { key: KEY, makeUp: true };
    expect(workId(work, 1)).toBe("s-at-20261207T0200Z-1");
    expect(workId(makeUp, 2)).toBe("s-at-20261207T0200Z-makeup-2");
    expect(workOf("s-at-20261207T0200Z-1")).toEqual(work);
    expect(workOf("s-at-20261207T0200Z-makeup-2")).toEqual(makeUp);
    expect(workOf("weekly.sync-at-20261207T0200Z-12")).toEqual({
      key: "weekly.sync:20261207T0200Z",
      makeUp: false,
    });
  });

  it("reads no occurrence from other task ids, or from the report carrier", () => {
    for (const id of [
      "s-1",
      "s-at-1",
      missedReportId(KEY),
      "s-at-20261207T0200Z-0",
      "s-at-20261207T02000Z-1",
      "-at-20261207T0200Z-1",
    ])
      expect(workOf(id), id).toBeUndefined();
    expect(missedReportId(KEY)).toBe("s-at-20261207T0200Z-missed");
  });

  it("accepts only occurrence keys of the board's grammar", () => {
    expect(isOccurrenceKey(KEY)).toBe(true);
    for (const key of ["s", "s:2026", "-s:20261207T0200Z", "s:20261207T0200Z\n", ":20261207T0200Z"])
      expect(isOccurrenceKey(key), key).toBe(false);
    expect(isOccurrenceKey(`${"a".repeat(64)}:20261207T0200Z`)).toBe(true);
    expect(isOccurrenceKey(`${"a".repeat(65)}:20261207T0200Z`)).toBe(false);
  });
});

describe("occurrencePhase", () => {
  it("is notYet before T, due from T, ended at closes_by", () => {
    const file = schedules();
    expect(occurrencePhase(file, KEY, AT - 1)).toBe("notYet");
    expect(occurrencePhase(file, KEY, AT)).toBe("due");
    expect(occurrencePhase(file, KEY, AT + 60 * MIN - 1)).toBe("due");
    expect(occurrencePhase(file, KEY, AT + 60 * MIN)).toBe("ended");
  });

  it("is ended when the occurrence or its schedule is not in the file, silent when it does not ring", () => {
    expect(occurrencePhase(schedules(), "s:20261208T0200Z", AT)).toBe("ended");
    expect(occurrencePhase(schedules({ [KEY]: { series: "gone" } }), KEY, AT)).toBe("ended");
    expect(occurrencePhase(schedules(undefined, false), KEY, AT)).toBe("silent");
  });
});

describe("scheduleWork", () => {
  const tasks = (entries: Record<string, TaskState>) => new Map(Object.entries(entries));

  it("keeps a place for an open occurrence until its work starts, before and after T", () => {
    expect([...scheduleWork(view()).reserved]).toEqual([KEY]);
    expect([...scheduleWork(view({ nowMs: AT + MIN })).reserved]).toEqual([KEY]);
    expect([...scheduleWork(view({ queued: ["s-at-20261207T0200Z-1"] })).reserved]).toEqual([KEY]);
    expect(scheduleWork(view({ live: new Set([KEY]) })).reserved.size).toBe(0);
    const started = view({ tasks: tasks({ "s-at-20261207T0200Z-1": "working" }) });
    expect(scheduleWork(started).reserved.size).toBe(0);
  });

  it("keeps no place for an ended, silent or unusable occurrence, or one planned to nothing", () => {
    expect(scheduleWork(view({ nowMs: AT + 60 * MIN })).reserved.size).toBe(0);
    expect(scheduleWork(view({ schedules: schedules(undefined, false) })).reserved.size).toBe(0);
    expect(scheduleWork(view({ usable: () => false })).reserved.size).toBe(0);
    const failed = view({ planned: new Map([[KEY, "failed" as const]]) });
    expect(scheduleWork(failed).reserved.size).toBe(0);
  });

  it("does not count other tasks of the topic, or a make-up, as the occurrence's work", () => {
    const others = view({
      tasks: tasks({ "t-1": "working", "s-at-20261207T0200Z-makeup-1": "done" }),
    });
    expect([...scheduleWork(others).reserved]).toEqual([KEY]);
    expect(scheduleWork(others).close).toEqual([]);
  });

  it("closes an open occurrence once every task of it has ended and none waits", () => {
    const ended = tasks({ "s-at-20261207T0200Z-2": "failed", "s-at-20261207T0200Z-1": "done" });
    expect(scheduleWork(view({ nowMs: AT + MIN, tasks: ended })).close).toEqual([
      {
        key: KEY,
        note: "claude-agg：2 個 task 結束（s-at-20261207T0200Z-1 done、s-at-20261207T0200Z-2 failed）",
      },
    ]);
    const running = tasks({ "s-at-20261207T0200Z-1": "done", "s-at-20261207T0200Z-2": "paused" });
    expect(scheduleWork(view({ tasks: running })).close).toEqual([]);
    const waiting = view({ tasks: ended, queued: ["s-at-20261207T0200Z-3"] });
    expect(scheduleWork(waiting).close).toEqual([]);
    expect(scheduleWork(view({ tasks: ended, live: new Set([KEY]) })).close).toEqual([]);
    expect(scheduleWork(view({ tasks: ended, nowMs: AT + 60 * MIN })).close).toEqual([]);
    expect(
      scheduleWork(view({ tasks: ended, schedules: schedules(undefined, false) })).close,
    ).toHaveLength(1);
  });

  it("closes an occurrence its planner planned nothing for", () => {
    const nothing = view({ nowMs: AT, planned: new Map([[KEY, "nothing" as const]]) });
    expect(scheduleWork(nothing).close).toEqual([{ key: KEY, note: NOTE.nothing }]);
    expect(scheduleWork(nothing).reserved.size).toBe(0);
  });

  it("drops queued work of an ended occurrence, never a make-up or other work", () => {
    const queued = [
      "s-at-20261206T0200Z-1",
      "s-at-20261207T0200Z-1",
      "s-at-20261206T0200Z-makeup-1",
      "t-1",
    ];
    expect(scheduleWork(view({ queued })).drop).toEqual(["s-at-20261206T0200Z-1"]);
  });

  it("keeps every close note within the board's note limit", () => {
    const many = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`s-at-20261207T0200Z-${String(i + 1)}`, "done"]),
    ) as Record<string, TaskState>;
    const [close] = scheduleWork(view({ tasks: tasks(many) })).close;
    expect([...(close?.note ?? "")].length).toBeLessThanOrEqual(NOTE_MAX);
    expect(close?.note).toMatch(/…$/);
  });
});

describe("a missed occurrence", () => {
  const notice = (rt: ScheduleNotice["rt"], expiresAtMs: number | null): ScheduleNotice => ({
    event: "schedule.missed",
    key: KEY,
    topic: "t",
    at: "2026-12-07T02:00:00Z",
    local: "2026-12-07T10:00+08:00",
    rt,
    expiresAtMs,
  });

  it("is made up once when soft-rt, and reported when hard-rt or none", () => {
    expect(missedAction(notice("soft-rt", AT), AT - 1)).toBe("makeUp");
    expect(missedAction(notice("soft-rt", null), AT)).toBe("makeUp");
    expect(missedAction(notice("soft-rt", AT), AT)).toBe("expired");
    expect(missedAction(notice("hard-rt", null), AT)).toBe("report");
    expect(missedAction(notice("none", AT), AT + 1)).toBe("report");
  });

  it("is reported with a fixed sentence naming the occurrence and its local time", () => {
    expect(missedReport(notice("hard-rt", null))).toBe(
      "排程的這一場 s:20261207T0200Z（2026-12-07T10:00+08:00）錯過了：看板當時沒在跑，沒有開工。hard-rt 不補做。",
    );
    expect(missedReport({ ...notice("none", null), local: "" })).toContain(
      "（2026-12-07T02:00:00Z）錯過了",
    );
    expect(missedReport({ ...notice("none", null), local: "" })).toContain("rt 是 none，不補做");
  });
});
