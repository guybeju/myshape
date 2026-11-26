import { afterAll, describe, expect, it } from "vitest";

import { readBoard } from "./board-files.js";
import { dispatchOrder, topicEntry } from "./dispatch-order.js";
import type { DispatchOrder } from "./dispatch-order.js";
import { removeHomes, writeHome } from "./fixtures.test-helper.js";
import type { HomeFiles } from "./fixtures.test-helper.js";

afterAll(removeHomes);

const NOW = Date.parse("2026-12-07T02:30:00Z");

function topic(name: string, createdAt = "2026-11-20T00:00:00Z"): Record<string, string> {
  return { name, goal: `goal of ${name}`, status: "confirmed", created_at: createdAt };
}

function topicsFile(
  queues: Partial<Record<"high" | "normal" | "later", string[]>>,
  ids: string[],
  merged: Record<string, string> = {},
): unknown {
  return {
    v: 1,
    next_seq: 1,
    queues: { high: [], normal: [], later: [], ...queues },
    topics: Object.fromEntries(ids.map((id) => [id, topic(`name of ${id}`)])),
    merged,
  };
}

function series(topicId: string, rt: string): Record<string, unknown> {
  return { topic: topicId, title: topicId, rule: "daily 10:00", tz: "UTC", rt, state: "on" };
}

function occurrence(
  seriesId: string,
  at: string,
  closesBy = "2026-12-07T05:00:00Z",
  state = "due",
): Record<string, unknown> {
  return { series: seriesId, at, state, opened_at: at, closes_by: closesBy };
}

function schedulesFile(
  seriesMap: Record<string, unknown>,
  occurrences: Record<string, unknown>,
): unknown {
  return { v: 1, settings: {}, series: seriesMap, occurrences, recent: {}, removed: {} };
}

function orderOf(files: HomeFiles, nowMs = NOW): DispatchOrder {
  return dispatchOrder(readBoard(writeHome(files)), nowMs);
}

function topicsOf(result: DispatchOrder): string[] {
  return result.order.map((entry) => entry.topic);
}

describe("dispatchOrder over the queues", () => {
  it("takes high, then normal, in array order, then topics in no queue", () => {
    const result = orderOf({
      topics: topicsFile({ high: ["h2", "h1"], normal: ["n1", "n2"] }, [
        "loose",
        "n2",
        "h1",
        "n1",
        "h2",
      ]),
    });
    expect(topicsOf(result)).toEqual(["h2", "h1", "n1", "n2", "loose"]);
    expect(result.order[0]).toMatchObject({
      queue: "high",
      position: 1,
      occurrence: null,
      name: "name of h2",
      goal: "goal of name of h2",
      reason: "queue high, position 1",
    });
    expect(result.order[3]).toMatchObject({ queue: "normal", position: 2 });
    expect(result.order[4]).toMatchObject({ queue: "none", position: null, reason: "in no queue" });
    expect(result.skipped).toEqual([]);
  });

  it("orders topics in no queue by created_at, then by id as text", () => {
    const topics = {
      queues: { high: [], normal: [], later: [] },
      topics: {
        b: topic("b", "2026-11-01T00:00:00Z"),
        "9": topic("nine", "2026-11-02T00:00:00Z"),
        "10": topic("ten", "2026-11-02T00:00:00Z"),
        a: topic("a", "2026-11-01T00:00:00Z"),
      },
    };
    expect(topicsOf(orderOf({ topics }))).toEqual(["a", "b", "10", "9"]);
  });

  it("gives a topic in later no new work, and says so", () => {
    const result = orderOf({
      topics: topicsFile({ high: ["h"], later: ["l2", "l1"] }, ["h", "l1", "l2"]),
    });
    expect(topicsOf(result)).toEqual(["h"]);
    expect(result.skipped).toEqual([
      { topic: "l2", occurrence: null, reason: "in later (待辦) with no open occurrence" },
      { topic: "l1", occurrence: null, reason: "in later (待辦) with no open occurrence" },
    ]);
  });

  it("keeps a topic listed twice at its first place", () => {
    const result = orderOf({
      topics: topicsFile({ high: ["a", "b", "a"], normal: ["b"], later: ["a"] }, ["a", "b"]),
    });
    expect(topicsOf(result)).toEqual(["a", "b"]);
    expect(result.order[1]).toMatchObject({ queue: "high", position: 2 });
    expect(result.skipped).toEqual([]);
  });

  it("skips a queue id that is no topic", () => {
    const result = orderOf({ topics: topicsFile({ high: ["ghost", "a"] }, ["a"]) });
    expect(topicsOf(result)).toEqual(["a"]);
    expect(result.skipped).toEqual([
      { topic: "ghost", occurrence: null, reason: "listed in high as ghost, but no such topic" },
    ]);
  });
});

describe("dispatchOrder over merges", () => {
  it("follows a chain of merges to the topic that is left", () => {
    const result = orderOf({
      topics: topicsFile({ high: ["old"], normal: ["c"] }, ["c"], { old: "mid", mid: "c" }),
    });
    expect(topicsOf(result)).toEqual(["c"]);
    expect(result.order[0]).toMatchObject({
      queue: "high",
      position: 1,
      reason: "queue high, position 1 (listed as old, merged)",
    });
  });

  it("follows merges from a schedule's topic", () => {
    const result = orderOf({
      topics: topicsFile({ later: ["new"] }, ["new"], { old: "mid", mid: "new" }),
      schedules: schedulesFile(
        { s: series("old", "none") },
        { "s:20261207T0200Z": occurrence("s", "2026-12-07T02:00:00Z") },
      ),
    });
    expect(topicsOf(result)).toEqual(["new"]);
    expect(result.order[0]?.occurrence?.key).toBe("s:20261207T0200Z");
  });

  it("ends a cycle of merges instead of looping", () => {
    const result = orderOf({
      topics: topicsFile({ high: ["x", "a"] }, ["a"], { x: "y", y: "x" }),
    });
    expect(topicsOf(result)).toEqual(["a"]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toMatch(/^listed in high as x, but no such topic$/);
  });

  it("counts a merged topic's hashtags on the topic it went into, once per key", () => {
    const result = orderOf({
      topics: topicsFile({ high: ["c"] }, ["c"], { old: "c" }),
      hashtags: {
        v: 1,
        hashtags: {
          AI_INFRA: { key: "ai_infra" },
          URGENT: { key: "urgent" },
          ai_infra: { key: "ai_infra" },
        },
        topics: { c: ["URGENT"], old: ["ai_infra", "AI_INFRA", "ＵＲＧＥＮＴ"] },
      },
    });
    expect(result.order[0]?.hashtags).toEqual(["URGENT", "ai_infra"]);
  });

  it("does not let hashtags change the order", () => {
    const topics = topicsFile({ high: ["a", "b"], normal: ["c"] }, ["a", "b", "c", "d"]);
    const hashtags = { v: 1, hashtags: {}, topics: { c: ["FIRST"], d: ["FIRST"] } };
    expect(topicsOf(orderOf({ topics, hashtags }))).toEqual(topicsOf(orderOf({ topics })));
  });
});

describe("dispatchOrder over archived topics", () => {
  it("gives an archived topic no new work, even when a queue still lists it", () => {
    const result = orderOf({
      topics: topicsFile({ high: ["gone", "a"] }, ["a", "gone"]),
      archive: {
        v: 1,
        topics: { gone: { ...topic("gone"), archived_at: "2026-11-25T00:00:00Z" } },
      },
    });
    expect(topicsOf(result)).toEqual(["a"]);
    expect(result.skipped).toEqual([
      {
        topic: "gone",
        occurrence: null,
        reason: "listed in high as gone, but the topic is archived",
      },
    ]);
  });

  it("does not dispatch an archived topic for an open occurrence", () => {
    const result = orderOf({
      topics: topicsFile({}, []),
      archive: { v: 1, topics: { gone: topic("gone") } },
      schedules: schedulesFile(
        { s: series("gone", "hard-rt") },
        { "s:20261207T0200Z": occurrence("s", "2026-12-07T02:00:00Z") },
      ),
    });
    expect(result.order).toEqual([]);
    expect(result.skipped).toEqual([
      { topic: "gone", occurrence: "s:20261207T0200Z", reason: "open, but the topic is archived" },
    ]);
  });

  it("lists no archived topic that nothing points at", () => {
    const result = orderOf({
      topics: topicsFile({}, ["a"]),
      archive: { v: 1, topics: { gone: topic("gone") } },
    });
    expect(topicsOf(result)).toEqual(["a"]);
    expect(result.skipped).toEqual([]);
  });
});

describe("dispatchOrder over schedule occurrences", () => {
  const files = (occurrences: Record<string, unknown>, rts: Record<string, string>): HomeFiles => ({
    topics: topicsFile({ high: ["q"], later: Object.keys(rts) }, ["q", ...Object.keys(rts)]),
    schedules: schedulesFile(
      Object.fromEntries(Object.entries(rts).map(([id, rt]) => [id, series(id, rt)])),
      occurrences,
    ),
  });

  it("puts open occurrences first, hard-rt, then soft-rt, then none, before their T", () => {
    const result = orderOf(
      files(
        {
          "n:20261207T0000Z": occurrence("n", "2026-12-07T00:00:00Z"),
          "s:20261207T0100Z": occurrence("s", "2026-12-07T01:00:00Z"),
          "h:20261207T0300Z": occurrence("h", "2026-12-07T03:00:00Z", undefined, "upcoming"),
        },
        { n: "none", s: "soft-rt", h: "hard-rt" },
      ),
    );
    expect(topicsOf(result)).toEqual(["h", "s", "n", "q"]);
    expect(result.order[0]).toMatchObject({
      queue: "later",
      position: 3,
      occurrence: {
        key: "h:20261207T0300Z",
        series: "h",
        at: "2026-12-07T03:00:00Z",
        state: "upcoming",
        rt: "hard-rt",
        closes_by: "2026-12-07T05:00:00Z",
      },
      reason:
        "open occurrence h:20261207T0300Z (upcoming, hard-rt) at 2026-12-07T03:00:00Z; " +
        "the topic is in later",
    });
    expect(result.skipped).toEqual([]);
  });

  it("breaks a tie in rt by T, and a tie in T by key", () => {
    const result = orderOf(
      files(
        {
          "b:20261207T0100Z": occurrence("b", "2026-12-07T01:00:00Z"),
          "a:20261207T0200Z": occurrence("a", "2026-12-07T02:00:00Z"),
          "c:20261207T0100Z": occurrence("c", "2026-12-07T01:00:00.000Z"),
        },
        { a: "soft-rt", b: "soft-rt", c: "soft-rt" },
      ),
    );
    expect(topicsOf(result)).toEqual(["b", "c", "a", "q"]);
  });

  it("treats an occurrence at or past its closes_by as ended", () => {
    const result = orderOf(
      files(
        {
          "a:20261207T0000Z": occurrence("a", "2026-12-07T00:00:00Z", "2026-12-07T02:30:00Z"),
          "b:20261207T0000Z": occurrence("b", "2026-12-07T00:00:00Z", "2026-12-07T01:00:00Z"),
          "c:20261207T0000Z": occurrence("c", "2026-12-07T00:00:00Z", "2026-12-07T02:30:01Z"),
        },
        { a: "hard-rt", b: "hard-rt", c: "none" },
      ),
    );
    expect(topicsOf(result)).toEqual(["c", "q"]);
    expect(result.skipped.map((entry) => entry.topic)).toEqual(["a", "b"]);
  });

  it("takes a queued topic with an open occurrence once, at its occurrence", () => {
    const result = orderOf({
      topics: topicsFile({ high: ["a", "b"] }, ["a", "b"]),
      schedules: schedulesFile(
        { s: series("b", "none") },
        { "s:20261207T0200Z": occurrence("s", "2026-12-07T02:00:00Z") },
      ),
    });
    expect(topicsOf(result)).toEqual(["b", "a"]);
    expect(result.order[0]).toMatchObject({ queue: "high", position: 2 });
  });

  it("reads an unknown rt as none", () => {
    const result = orderOf(
      files(
        {
          "x:20261207T0000Z": occurrence("x", "2026-12-07T00:00:00Z"),
          "y:20261207T0100Z": occurrence("y", "2026-12-07T01:00:00Z"),
        },
        { x: "urgent", y: "soft-rt" },
      ),
    );
    expect(topicsOf(result)).toEqual(["y", "x", "q"]);
    expect(result.order[1]?.occurrence?.rt).toBe("none");
  });

  it("skips an occurrence whose schedule is missing, or whose topic is unknown", () => {
    const result = orderOf({
      topics: topicsFile({}, ["a"]),
      schedules: schedulesFile(
        { s: series("nobody", "none") },
        {
          "s:20261207T0200Z": occurrence("s", "2026-12-07T02:00:00Z"),
          "lost:20261207T0200Z": occurrence("lost", "2026-12-07T02:00:00Z"),
        },
      ),
    });
    expect(topicsOf(result)).toEqual(["a"]);
    expect(result.skipped).toEqual([
      {
        topic: null,
        occurrence: "lost:20261207T0200Z",
        reason: "open, but its schedule lost is not in the file",
      },
      { topic: "nobody", occurrence: "s:20261207T0200Z", reason: "open, but no such topic" },
    ]);
  });

  it("dispatches a topic once when two open occurrences reach it", () => {
    const result = orderOf({
      topics: topicsFile({ later: ["t"] }, ["t"], { old: "t" }),
      schedules: schedulesFile(
        { s1: series("t", "soft-rt"), s2: series("old", "hard-rt") },
        {
          "s1:20261207T0100Z": occurrence("s1", "2026-12-07T01:00:00Z"),
          "s2:20261207T0200Z": occurrence("s2", "2026-12-07T02:00:00Z"),
        },
      ),
    });
    expect(topicsOf(result)).toEqual(["t"]);
    expect(result.order[0]?.occurrence?.key).toBe("s2:20261207T0200Z");
    expect(result.skipped).toEqual([
      {
        topic: "t",
        occurrence: "s1:20261207T0100Z",
        reason: "open, but the topic already has an earlier open occurrence",
      },
    ]);
  });
});

describe("topicEntry", () => {
  it("gives a live topic in later its place and details, and nothing for an archived or unknown one", () => {
    const home = writeHome({
      topics: {
        topics: {
          s: { name: "週會", goal: "整理紀錄", created_at: "2026-11-27T00:00:00Z" },
          old: { name: "舊", goal: "", created_at: "2026-11-27T00:00:00Z" },
        },
        queues: { high: [], normal: [], later: ["old", "s"] },
        merged: {},
      },
      archive: { topics: { gone: {} } },
      hashtags: { topics: { s: ["會議"] }, hashtags: {} },
    });
    const board = readBoard(home);
    expect(topicEntry(board, "s", "make-up")).toEqual({
      topic: "s",
      name: "週會",
      goal: "整理紀錄",
      queue: "later",
      position: 2,
      occurrence: null,
      hashtags: ["會議"],
      reason: "make-up",
    });
    expect(topicEntry(board, "gone", "x")).toBeUndefined();
    expect(topicEntry(board, "nobody", "x")).toBeUndefined();
  });
});
