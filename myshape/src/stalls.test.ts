import { describe, expect, it } from "vitest";
import type { StallMember } from "./lifecycle.js";
import {
  NO_TOPIC,
  askStall,
  deferStall,
  idleStep,
  stallKeyOf,
  stallState,
  stallStep,
} from "./stalls.js";

const NOW = Date.parse("2026-11-27T00:00:00Z");
const DAY = 86_400_000;
const at = (ms: number): string => new Date(NOW + ms).toISOString();
const names = (key: string): string => ({ hi: "High" })[key] ?? key;
/** The N3 setting's default: the aggregator has a day after 請 <aggregator> 處理. */
const ASK = 1440;

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
    expect(stallState({ since: at(0), members: ["a"] }, NOW, ASK)).toBe("N2");
    expect(stallState({ since: at(0), members: ["a"], deferred }, NOW, ASK)).toBe("N4");
    expect(stallState({ since: at(0), members: ["a", "new"], deferred }, NOW, ASK)).toBe("N2");
    expect(stallState({ since: at(0), members: ["a"], deferred }, NOW + DAY, ASK)).toBe("N2");
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
    const context = { nameOf: names, nowMs: NOW, askMinutes: ASK };
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
    expect(deferStall(stalls, "hi", 1, context)).toMatchObject({
      ok: true,
      line: "ok hi 延到 11-28",
    });
    expect(deferStall(stalls, "hi", 90, context)).toMatchObject({
      ok: true,
      line: "ok hi 延到 02-25",
    });
    for (const days of [0, 91, 1.5, "7"])
      expect(deferStall(stalls, "hi", days, context)).toMatchObject({ ok: false, code: "usage" });
    expect(deferStall(stalls, "nope", 7, context)).toMatchObject({ ok: false, code: "refused" });
    expect(deferStall({ hi: result.stall }, "hi", 7, context)).toMatchObject({
      ok: false,
      code: "refused",
    });
  });
});

describe("請 <aggregator> 處理 on a 沒人接 card", () => {
  const asked = { at: at(0), members: ["a"] };
  const members: StallMember[] = [
    {
      key: "queued\tmain\ta",
      kind: "queued",
      home: "main",
      id: "a",
      label: "main/a",
      states: ["Q5", "NT"],
      since: at(-3 * DAY),
    },
    {
      key: "todo\tvpn",
      kind: "todo",
      home: null,
      id: "vpn",
      label: "登入 VPN",
      states: ["O3"],
      since: at(-3 * DAY),
    },
  ];
  const stalls = { hi: { since: at(-DAY), members: ["queued\tmain\ta", "todo\tvpn"] } };
  const context = { nameOf: names, nowMs: NOW, label: "plain", members, askMinutes: ASK };

  it("gives the card to the aggregator (N3) for a day, for the members listed then, and back once", () => {
    expect(stallState({ since: at(-DAY), members: ["a"], asked }, NOW, ASK)).toBe("N3");
    expect(stallState({ since: at(-DAY), members: ["a"], asked }, NOW + DAY - 1, ASK)).toBe("N3");
    expect(stallState({ since: at(-DAY), members: ["a"], asked }, NOW + DAY, ASK)).toBe("N2");
    expect(stallState({ since: at(-DAY), members: ["a", "new"], asked }, NOW, ASK)).toBe("N2");
    // The captain's N3 setting decides how long the aggregator has.
    expect(stallState({ since: at(-DAY), members: ["a"], asked }, NOW + 3_600_000, 60)).toBe("N2");
    const previous = { hi: { since: at(-DAY), members: ["a"], asked } };
    expect(stallStep(previous, new Map([["hi", ["a", "b"]]]), names, NOW + 2 * DAY)).toEqual({
      stalls: { hi: { since: at(-DAY), members: ["a", "b"], asked } },
      records: [],
    });
    const put = deferStall(previous, "hi", 3, { nameOf: names, nowMs: NOW + DAY, askMinutes: ASK });
    expect(put).toMatchObject({ ok: true, stall: { asked } });
  });

  it("asks once, in one fixed sentence naming the members, on a topic's card in front of the captain", () => {
    const result = askStall(stalls, "hi", context);
    expect(result).toMatchObject({
      ok: true,
      stall: { ...stalls.hi, asked: { at: at(0), members: stalls.hi.members } },
      line: "ok hi 已請 plain 處理",
      records: [
        {
          kind: "lifecycle.answered",
          topic: "hi",
          outcome: "asked",
          text: "「沒人接」議題「High」：請 plain 處理這 2 張，1 天內沒有變化就回到你面前",
        },
      ],
      message: {
        topic: "hi",
        text:
          "使用者請你處理議題「High」（id hi）的「沒人接」卡：" +
          "main/a（停著、沒有日期也沒有等的項目；沒有議題的排隊項目與 agent）；" +
          "要你動手 vpn（按了做完了、等驗證的要你動手）。" +
          "1 天內這些卡沒有離開逾期的狀態，卡會回到使用者面前，那時不能再請你處理。",
      },
    });
    if (!result.ok) throw new Error("expected an ask");
    expect(result.message.id).toMatch(/^w-a-[0-9a-f]{16}$/);
    const again = askStall(stalls, "hi", { ...context, nowMs: NOW + 5 });
    if (!again.ok) throw new Error("expected an ask");
    expect(again.message.id).toBe(result.message.id);
    const short = askStall(stalls, "hi", { ...context, askMinutes: 120 });
    if (!short.ok) throw new Error("expected an ask");
    expect(short.message.text).toContain("。2 小時內這些卡沒有離開逾期的狀態");
    expect(short.records[0].text).toContain("，2 小時內沒有變化就回到你面前");
  });

  it("is refused on the card with no topic, a second time, and on a card not in front of the captain", () => {
    const refused = { ok: false, code: "refused" };
    const loose = { [NO_TOPIC]: { since: at(-DAY), members: ["queued\tmain\tb\tNT"] } };
    expect(askStall(loose, NO_TOPIC, context)).toMatchObject(refused);
    const once = { hi: { ...stalls.hi, asked: { at: at(-2 * DAY), members: stalls.hi.members } } };
    expect(askStall(once, "hi", context)).toMatchObject({
      ...refused,
      line: "這張「沒人接」卡已經請 plain 處理過一次了；現在只能延到或移到待辦。",
    });
    const put = {
      hi: { ...stalls.hi, deferred: { until: at(DAY), members: stalls.hi.members } },
    };
    expect(askStall(put, "hi", context)).toMatchObject(refused);
    expect(askStall(stalls, "nope", context)).toMatchObject(refused);
    expect(askStall(stalls, "hi", { ...context, members: [] })).toMatchObject(refused);
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
