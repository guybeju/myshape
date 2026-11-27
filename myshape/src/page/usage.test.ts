import { describe, expect, it } from "vitest";
import type { HomeMetricsView, MetricGroupView, MetricView } from "#board/metrics.js";
import { when } from "./parts.js";
import {
  ageText,
  itemClass,
  nonEmpty,
  resetText,
  shown,
  spanText,
  usageBlocks,
  usageCard,
  usageRow,
  valueText,
} from "./usage.js";

const NOW = Date.parse("2026-11-27T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function clock(offsetMs: number): string {
  return when((NOW + offsetMs) / 1000);
}

function item(change: Partial<MetricView> = {}): MetricView {
  return {
    id: "m",
    group: null,
    label: "M",
    value: 37,
    unit: "%",
    resets_at: null,
    measured_at: iso(-5 * MINUTE),
    severity: "normal",
    stale_after_s: 900,
    age_s: 300,
    stale: null,
    reset_passed: false,
    ...change,
  };
}

describe("spanText", () => {
  it("writes the two largest units that matter, rounded down", () => {
    expect(spanText(0)).toBe("不到 1 分");
    expect(spanText(MINUTE - 1)).toBe("不到 1 分");
    expect(spanText(MINUTE)).toBe("1 分");
    expect(spanText(59 * MINUTE + 59_999)).toBe("59 分");
    expect(spanText(HOUR)).toBe("1 小時");
    expect(spanText(2 * HOUR + 13 * MINUTE)).toBe("2 小時 13 分");
    expect(spanText(DAY - 1)).toBe("23 小時 59 分");
    expect(spanText(DAY)).toBe("1 天");
    expect(spanText(DAY + HOUR)).toBe("1 天 1 小時");
    expect(spanText(HOUR + MINUTE)).toBe("1 小時 1 分");
    expect(spanText(3 * DAY + 4 * HOUR + 5 * MINUTE)).toBe("3 天 4 小時");
  });
});

describe("resetText", () => {
  it("counts down to a reset still ahead and names its time", () => {
    expect(resetText(iso(2 * HOUR + 13 * MINUTE), NOW)).toBe(
      `2 小時 13 分後重置（${clock(2 * HOUR + 13 * MINUTE)}）`,
    );
    expect(resetText(iso(1), NOW)).toBe(`不到 1 分後重置（${clock(1)}）`);
  });

  it("says a reset has passed instead of counting below zero", () => {
    expect(resetText(iso(0), NOW)).toBe(`重置時間已過（${clock(0)}）`);
    expect(resetText(iso(-3 * HOUR), NOW)).toBe(`重置時間已過（${clock(-3 * HOUR)}）`);
  });

  it("says nothing for a metric with no reset", () => {
    expect(resetText(null, NOW)).toBeNull();
  });
});

describe("ageText", () => {
  it("says how long ago a metric was measured", () => {
    expect(ageText(item(), NOW)).toBe("5 分前量的");
    expect(ageText(item({ measured_at: iso(-MINUTE) }), NOW)).toBe("1 分前量的");
    expect(ageText(item({ measured_at: iso(-MINUTE + 1) }), NOW)).toBe("剛量的");
    expect(ageText(item({ measured_at: iso(30_000) }), NOW)).toBe("剛量的");
  });

  it("says when the board cannot tell", () => {
    expect(ageText(item({ measured_at: null, stale: "no-time" }), NOW)).toBe("沒說是什麼時候量的");
    expect(ageText(item({ measured_at: iso(2 * HOUR), stale: "future" }), NOW)).toBe(
      `量的時間（${clock(2 * HOUR)}）比看板的時鐘晚`,
    );
  });
});

describe("valueText", () => {
  it("writes a percentage to one decimal and any other value with its unit", () => {
    expect(valueText(item({ value: 37 }))).toBe("37%");
    expect(valueText(item({ value: 12.54 }))).toBe("12.5%");
    expect(valueText(item({ value: 1.5, unit: "USD" }))).toBe("1.5 USD");
    expect(valueText(item({ value: 3, unit: "" }))).toBe("3");
  });
});

describe("itemClass", () => {
  it("greys a stale metric and styles only a current one by its severity", () => {
    expect(itemClass(item())).toBe("usage-item");
    expect(itemClass(item({ severity: "warn" }))).toBe("usage-item sev-warn");
    expect(itemClass(item({ severity: "critical" }))).toBe("usage-item sev-critical");
    expect(itemClass(item({ severity: "critical", stale: "old" }))).toBe("usage-item stale");
    expect(itemClass(item({ stale: "group" }))).toBe("usage-item stale");
  });
});

function group(change: Partial<MetricGroupView> = {}): MetricGroupView {
  return {
    id: "g",
    label: "Claude",
    state: "ok",
    note: "",
    next_reset: null,
    items: [item()],
    ...change,
  };
}

describe("usageRow", () => {
  it("writes a current percentage with its meter, reset and age", () => {
    expect(usageRow(item({ resets_at: iso(HOUR), severity: "warn" }), NOW)).toEqual({
      id: "m",
      class: "usage-item sev-warn",
      label: "M",
      value: "37%",
      meter: { min: 0, max: 100, value: 37 },
      note: `1 小時後重置（${clock(HOUR)}） · 5 分前量的`,
    });
  });

  it("says why a stale metric is not current, and draws no meter for a value that is not a percentage", () => {
    expect(usageRow(item({ unit: "USD", value: 2, stale: "old" }), NOW)).toMatchObject({
      class: "usage-item stale",
      value: "2 USD",
      meter: null,
      note: "5 分前量的 · 已經過時",
    });
    expect(usageRow(item({ stale: "group" }), NOW).note).toBe("5 分前量的 · 這組的數字不是現在的");
    expect(usageRow(item({ stale: "reset" }), NOW).note).toBe(
      "5 分前量的 · 重置之後還沒有新的數字",
    );
    expect(usageRow(item({ measured_at: null, stale: "no-time" }), NOW).note).toBe(
      "沒說是什麼時候量的 · 不知道是不是現在的",
    );
    expect(usageRow(item({ measured_at: iso(2 * HOUR), stale: "future" }), NOW).note).toBe(
      `量的時間（${clock(2 * HOUR)}）比看板的時鐘晚 · 不當成現在的數字`,
    );
  });
});

describe("usageCard", () => {
  it("titles a group, and marks one whose numbers are not current", () => {
    expect(usageCard(group(), NOW)).toMatchObject({
      id: "g",
      class: "usage-group",
      title: { label: "Claude", pill: null },
      note: null,
      next: null,
    });
    expect(
      usageCard(group({ state: "unavailable", note: "讀不到", items: [] }), NOW),
    ).toMatchObject({
      class: "usage-group off",
      title: { label: "Claude", pill: "讀不到" },
      note: "讀不到",
      rows: [],
    });
    expect(usageCard(group({ state: "stale" }), NOW).title).toEqual({
      label: "Claude",
      pill: "舊的數字",
    });
  });

  it("gives the metrics in no group no title", () => {
    expect(usageCard(group({ id: null, label: "" }), NOW)).toMatchObject({ id: null, title: null });
  });

  it("writes the soonest reset only for a card of more than one metric", () => {
    const next = iso(HOUR);
    expect(
      usageCard(group({ next_reset: next, items: [item(), item({ id: "n" })] }), NOW).next,
    ).toBe(`最快：1 小時後重置（${clock(HOUR)}）`);
    expect(usageCard(group({ next_reset: next }), NOW).next).toBeNull();
    expect(usageCard(group({ items: [item(), item({ id: "n" })] }), NOW).next).toBeNull();
  });
});

describe("usageBlocks", () => {
  const home = (change: Partial<HomeMetricsView> = {}): HomeMetricsView => ({
    home: "main",
    problem: null,
    dropped: 0,
    first_drop: null,
    groups: [group()],
    ...change,
  });

  it("names every home but the main one, in the board's order", () => {
    const blocks = usageBlocks([home(), home({ home: "sm1" })], NOW);
    expect(blocks.map((block) => block.home)).toEqual([null, "home sm1"]);
    expect(blocks[0]).toMatchObject({ problem: null, dropped: null });
    expect(blocks[0]?.cards.map((card) => card.id)).toEqual(["g"]);
  });

  it("says why a block was not used and how many entries were left out", () => {
    expect(
      usageBlocks([home({ problem: "格式版本是 2，看板只認得 1", groups: [] })], NOW)[0],
    ).toMatchObject({
      problem: "看板沒有用這份用量資料：格式版本是 2，看板只認得 1",
      cards: [],
    });
    expect(
      usageBlocks([home({ dropped: 2, first_drop: "items[1]：不是物件" })], NOW)[0]?.dropped,
    ).toBe("看板略過了 2 筆不合格式的用量資料（第一筆：items[1]：不是物件）");
  });
});

describe("nonEmpty", () => {
  it("is the list, or null for an empty one", () => {
    expect(nonEmpty([1])).toEqual([1]);
    expect(nonEmpty([])).toBeNull();
  });
});

describe("shown", () => {
  it("renders a value and nothing for null", () => {
    expect(shown("x", (value) => `<${value}>`)).toBe("<x>");
    expect(shown(0, (value) => value + 1)).toBe(1);
    expect(shown(null, () => "never")).toBeNull();
  });
});
