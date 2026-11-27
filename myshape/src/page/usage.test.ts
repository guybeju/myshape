import { describe, expect, it } from "vitest";
import type { MetricView } from "#board/metrics.js";
import { when } from "./parts.js";
import { ageText, itemClass, resetText, spanText, valueText } from "./usage.js";

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
    stale_after_s: null,
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
