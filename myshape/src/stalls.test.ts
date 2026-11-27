import { describe, expect, it } from "vitest";
import { NO_TOPIC, deferStall, idleStep, stallKeyOf, stallState, stallStep } from "./stalls.js";

const NOW = Date.parse("2026-11-27T00:00:00Z");
const DAY = 86_400_000;
const at = (ms: number): string => new Date(NOW + ms).toISOString();
const names = (key: string): string => ({ hi: "High" })[key] ?? key;

describe("the 沒人接 card", () => {
  it("is raised once for a topic whose cards passed their deadline, and once for work with no topic", () => {
    const step = stallStep(
      {},
      new Map([
        ["hi", ["queued\tmain\ta", "agent\tmain\tb"]],
        [NO_TOPIC, ["queued\tmain\tc\tNT"]],
        ["empty", []],
      ]),
      names,
      NOW,
    );
    expect(step.stalls).toEqual({
      hi: { since: at(0), members: ["queued\tmain\ta", "agent\tmain\tb"] },
      [NO_TOPIC]: { since: at(0), members: ["queued\tmain\tc\tNT"] },
    });
    expect(step.records).toEqual([
      {
        kind: "stall.raised",
        topic: "hi",
        outcome: "stall",
        text: "「沒人接」：議題「High」有 2 張卡過了期限，交給你決定",
      },
      {
        kind: "stall.raised",
        topic: null,
        outcome: "stall",
        text: "「沒人接」：沒有議題的工作有 1 張卡過了期限，交給你決定",
      },
    ]);
    expect(stallKeyOf(null)).toBe(NO_TOPIC);
    expect(stallKeyOf("hi")).toBe("hi");
  });

  it("keeps its first time while its members change, and settles once none is left", () => {
    const previous = { hi: { since: at(-DAY), members: ["a"] } };
    const kept = stallStep(previous, new Map([["hi", ["a", "b"]]]), names, NOW);
    expect(kept).toEqual({ stalls: { hi: { since: at(-DAY), members: ["a", "b"] } }, records: [] });
    const settled = stallStep(previous, new Map(), names, NOW);
    expect(settled.stalls).toEqual({});
    expect(settled.records).toEqual([
      {
        kind: "stall.settled",
        topic: "hi",
        outcome: "stall",
        text: "「沒人接」議題「High」已不需要：每張卡都離開了逾期的狀態",
      },
    ]);
  });

  it("is put off (N4) only while the captain's 延到 runs and covers every member", () => {
    const deferred = { until: at(DAY), members: ["a"] };
    expect(stallState({ since: at(0), members: ["a"] }, NOW)).toBe("N2");
    expect(stallState({ since: at(0), members: ["a"], deferred }, NOW)).toBe("N4");
    expect(stallState({ since: at(0), members: ["a", "new"], deferred }, NOW)).toBe("N2");
    expect(stallState({ since: at(0), members: ["a"], deferred }, NOW + DAY)).toBe("N2");
    // A deferral that ran out is dropped at the next look; one still running is kept.
    const previous = { hi: { since: at(0), members: ["a"], deferred } };
    expect(
      stallStep(previous, new Map([["hi", ["a"]]]), names, NOW).stalls["hi"]?.deferred,
    ).toEqual(deferred);
    expect(stallStep(previous, new Map([["hi", ["a"]]]), names, NOW + DAY).stalls["hi"]).toEqual({
      since: at(0),
      members: ["a"],
    });
  });

  it("takes 延到 for 1 to 90 days, only while it is in front of the captain", () => {
    const stalls = { hi: { since: at(-DAY), members: ["a", "b"] } };
    const context = { nameOf: names, nowMs: NOW };
    const result = deferStall(stalls, "hi", 7, context);
    expect(result).toMatchObject({
      ok: true,
      stall: {
        since: at(-DAY),
        members: ["a", "b"],
        deferred: { until: at(7 * DAY), members: ["a", "b"] },
      },
      records: [{ kind: "lifecycle.answered", topic: "hi", outcome: "deferred" }],
    });
    if (!result.ok) throw new Error("expected a deferral");
    expect(result.records[0].text).toMatch(
      /^「沒人接」議題「High」：延到 \d\d-\d\d，只延現在列出的 2 張$/,
    );
    for (const days of [0, 91, 1.5, "7"])
      expect(deferStall(stalls, "hi", days, context)).toMatchObject({ ok: false, code: "usage" });
    expect(deferStall(stalls, "nope", 7, context)).toMatchObject({ ok: false, code: "refused" });
    expect(deferStall({ hi: result.stall }, "hi", 7, context)).toMatchObject({
      ok: false,
      code: "refused",
    });
  });
});

describe("the 沒人處理的議題 card", () => {
  it("is raised once per topic with no work past its deadline, and settles when it leaves that state", () => {
    const raised = idleStep({}, ["hi"], names, NOW);
    expect(raised).toEqual({
      idle: { hi: at(0) },
      records: [
        {
          kind: "stall.raised",
          topic: "hi",
          outcome: "idle",
          text: "「沒人處理的議題」：議題「High」過了期限還沒有任何工作，交給你決定",
        },
      ],
    });
    expect(idleStep(raised.idle, ["hi"], names, NOW + DAY)).toEqual({
      idle: { hi: at(0) },
      records: [],
    });
    expect(idleStep(raised.idle, [], names, NOW + DAY)).toEqual({
      idle: {},
      records: [
        {
          kind: "stall.settled",
          topic: "hi",
          outcome: "idle",
          text: "「沒人處理的議題」議題「High」已不需要：它離開了沒有工作的狀態",
        },
      ],
    });
  });
});
