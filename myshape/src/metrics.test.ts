import { describe, expect, it } from "vitest";
import {
  boardMetrics,
  FUTURE_SKEW_S,
  homeMetrics,
  ID_MAX,
  LABEL_MAX,
  MAX_GROUPS,
  MAX_ITEMS,
  metricFlags,
  nextReset,
  NOTE_MAX,
  parseMetrics,
  readMetric,
  STALE_AFTER_S,
  UNIT_MAX,
  VALUE_MAX,
} from "./metrics.js";
import type { Metric, Metrics } from "./metrics.js";

const NOW = Date.parse("2026-11-27T12:00:00Z");

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

const ITEM = {
  id: "claude:default.five_hour",
  group: "claude:default",
  label: "5 小時",
  value: 37,
  unit: "%",
  resets_at: "2026-11-27T15:00:00Z",
  measured_at: "2026-11-27T11:59:00Z",
  severity: "warn",
  stale_after_s: 600,
};

const BLOCK = {
  v: 1,
  stale_after_s: 900,
  groups: [{ id: "claude:default", label: "Claude", state: "ok", note: "" }],
  items: [ITEM],
};

type Ok = Extract<Metrics, { kind: "ok" }>;

function ok(raw: unknown): Ok {
  const parsed = parseMetrics(raw);
  if (parsed.kind !== "ok") throw new Error(`not ok: ${JSON.stringify(parsed)}`);
  return parsed;
}

/** The block with one item changed (or with a field removed when its value is undefined). */
function withItem(change: Record<string, unknown>): Ok {
  const item: Record<string, unknown> = { ...ITEM };
  for (const [key, value] of Object.entries(change)) {
    if (value === undefined) delete item[key];
    else item[key] = value;
  }
  return ok({ ...BLOCK, items: [item] });
}

function withGroup(change: Record<string, unknown>): Ok {
  return ok({ ...BLOCK, groups: [{ ...BLOCK.groups[0], ...change }], items: [] });
}

function kept(block: Ok): number {
  return block.items.length;
}

describe("parseMetrics", () => {
  it("reads a well formed block whole", () => {
    expect(ok(BLOCK)).toEqual({
      kind: "ok",
      stale_after_s: 900,
      groups: [{ id: "claude:default", label: "Claude", state: "ok", note: "" }],
      items: [{ ...ITEM, severity: "warn" }],
      dropped: 0,
      first_drop: null,
    });
  });

  it("gives every optional field its default", () => {
    const block = ok({
      v: 1,
      groups: [{ id: "g", label: "G" }],
      items: [{ id: "i", label: "I", value: -3.5 }],
    });
    expect(block.stale_after_s).toBe(STALE_AFTER_S.fallback);
    expect(block.groups).toEqual([{ id: "g", label: "G", state: "ok", note: "" }]);
    expect(block.items).toEqual([
      {
        id: "i",
        group: null,
        label: "I",
        value: -3.5,
        unit: "",
        resets_at: null,
        measured_at: null,
        severity: "normal",
        stale_after_s: STALE_AFTER_S.fallback,
      },
    ]);
  });

  it("is none for a missing or null block", () => {
    expect(parseMetrics(undefined)).toEqual({ kind: "none" });
    expect(parseMetrics(null)).toEqual({ kind: "none" });
  });

  it("does not use a block of another version, or one that is not an object", () => {
    expect(parseMetrics({ ...BLOCK, v: 2 })).toEqual({
      kind: "unreadable",
      reason: "格式版本是 2，看板只認得 1",
    });
    expect(parseMetrics({ ...BLOCK, v: "1" })).toEqual({
      kind: "unreadable",
      reason: "格式版本是 不是數字，看板只認得 1",
    });
    expect(parseMetrics({ items: [] })).toMatchObject({ kind: "unreadable" });
    expect(parseMetrics([BLOCK])).toEqual({ kind: "unreadable", reason: "metrics 不是物件" });
    expect(parseMetrics("metrics")).toEqual({ kind: "unreadable", reason: "metrics 不是物件" });
  });

  it("reads an empty block as no metrics, not as a problem", () => {
    expect(ok({ v: 1 })).toMatchObject({ groups: [], items: [], dropped: 0, first_drop: null });
    expect(ok({ v: 1, groups: [], items: [] })).toMatchObject({
      groups: [],
      items: [],
      dropped: 0,
    });
  });

  it("ignores fields it does not know", () => {
    const block = ok({ ...BLOCK, extra: 1, items: [{ ...ITEM, color: "red" }] });
    expect(block.items).toHaveLength(1);
    expect(block.items[0]).not.toHaveProperty("color");
    expect(block.dropped).toBe(0);
  });

  it("leaves out only the bad entry and says why the first one went", () => {
    const block = ok({
      ...BLOCK,
      items: [ITEM, "junk", { ...ITEM, id: "two", label: "" }, { ...ITEM, id: "three" }],
    });
    expect(block.items.map((item) => item.id)).toEqual(["claude:default.five_hour", "three"]);
    expect(block.dropped).toBe(2);
    expect(block.first_drop).toBe("items[1]：不是物件");
  });

  it("leaves out a repeated id and keeps the first", () => {
    const block = ok({ ...BLOCK, items: [ITEM, { ...ITEM, value: 99 }] });
    expect(block.items.map((item) => item.value)).toEqual([37]);
    expect(block.first_drop).toBe("items[1]：id claude:default.five_hour 重複");
    const groups = ok({ ...BLOCK, groups: [BLOCK.groups[0], BLOCK.groups[0]], items: [] });
    expect(groups.groups).toHaveLength(1);
    expect(groups.first_drop).toBe("groups[1]：id claude:default 重複");
  });

  it("counts a list that is not a list as one left-out entry", () => {
    const block = ok({ v: 1, groups: { id: "g" }, items: "none" });
    expect(block.dropped).toBe(2);
    expect(block.first_drop).toBe("groups 不是清單");
  });

  it(`keeps ${MAX_ITEMS} items and ${MAX_GROUPS} groups, and leaves out the rest`, () => {
    const items = Array.from({ length: MAX_ITEMS + 2 }, (_, index) => ({
      id: `i${index}`,
      label: "L",
      value: index,
    }));
    const groups = Array.from({ length: MAX_GROUPS + 1 }, (_, index) => ({
      id: `g${index}`,
      label: "G",
    }));
    const block = ok({ v: 1, groups, items });
    expect(block.items).toHaveLength(MAX_ITEMS);
    expect(block.groups).toHaveLength(MAX_GROUPS);
    expect(block.dropped).toBe(3);
    expect(block.first_drop).toBe(`groups[${MAX_GROUPS}]：超過 ${MAX_GROUPS} 筆`);
    expect(block.items.at(-1)?.id).toBe(`i${MAX_ITEMS - 1}`);
  });

  it("takes ids of the grammar up to its length", () => {
    expect(kept(withItem({ id: "a".repeat(ID_MAX) }))).toBe(1);
    expect(kept(withItem({ id: "a".repeat(ID_MAX + 1) }))).toBe(0);
    expect(kept(withItem({ id: "_a.b:c-d" }))).toBe(1);
    expect(kept(withItem({ id: "-a" }))).toBe(0);
    expect(kept(withItem({ id: ".a" }))).toBe(0);
    expect(kept(withItem({ id: "a b" }))).toBe(0);
    expect(kept(withItem({ id: "" }))).toBe(0);
    expect(kept(withItem({ id: 7 }))).toBe(0);
    expect(kept(withItem({ id: undefined }))).toBe(0);
    expect(withItem({ id: "a/b" }).first_drop).toBe("items[0]：id 不是合格的 id");
  });

  it("takes one line of plain text within each text field's length", () => {
    expect(kept(withItem({ label: "字".repeat(LABEL_MAX) }))).toBe(1);
    expect(kept(withItem({ label: "字".repeat(LABEL_MAX + 1) }))).toBe(0);
    expect(withItem({ label: "x".repeat(LABEL_MAX + 1) }).first_drop).toBe(
      `items[0]：label 不是 1 到 ${LABEL_MAX} 字的一行字`,
    );
    expect(kept(withItem({ label: "" }))).toBe(0);
    expect(kept(withItem({ label: undefined }))).toBe(0);
    expect(kept(withItem({ label: "兩\n行" }))).toBe(0);
    expect(kept(withItem({ label: "反‮向" }))).toBe(0);
    expect(kept(withItem({ label: 5 }))).toBe(0);
    expect(withItem({ label: "  5 小時  " }).items[0]?.label).toBe("5 小時");
    expect(kept(withItem({ unit: "u".repeat(UNIT_MAX) }))).toBe(1);
    expect(kept(withItem({ unit: "u".repeat(UNIT_MAX + 1), value: 1 }))).toBe(0);
    expect(withItem({ unit: "" }).items[0]?.unit).toBe("");
    expect(kept(withItem({ unit: 1 }))).toBe(0);
    expect(withGroup({ note: "n".repeat(NOTE_MAX) }).groups).toHaveLength(1);
    expect(withGroup({ note: "n".repeat(NOTE_MAX + 1) }).groups).toHaveLength(0);
    expect(withGroup({ note: "\t" }).groups).toHaveLength(0);
    expect(withGroup({ label: "" }).groups).toHaveLength(0);
  });

  it("takes a percentage from 0 to 100 and any other value up to its magnitude", () => {
    expect(kept(withItem({ value: 0 }))).toBe(1);
    expect(kept(withItem({ value: 100 }))).toBe(1);
    expect(kept(withItem({ value: -0.001 }))).toBe(0);
    expect(kept(withItem({ value: 100.001 }))).toBe(0);
    expect(withItem({ value: 101 }).first_drop).toBe("items[0]：百分比不在 0 到 100 之間");
    expect(kept(withItem({ unit: "USD", value: VALUE_MAX }))).toBe(1);
    expect(kept(withItem({ unit: "USD", value: -VALUE_MAX }))).toBe(1);
    expect(kept(withItem({ unit: "USD", value: VALUE_MAX + 1 }))).toBe(0);
    expect(withItem({ unit: "", value: -VALUE_MAX - 1 }).first_drop).toBe(
      "items[0]：value 超出範圍",
    );
    expect(kept(withItem({ value: "37" }))).toBe(0);
    expect(kept(withItem({ value: Number.NaN }))).toBe(0);
    expect(kept(withItem({ value: Number.POSITIVE_INFINITY, unit: "" }))).toBe(0);
    expect(withItem({ value: undefined }).first_drop).toBe("items[0]：value 不是數字");
  });

  it("takes ISO 8601 times with a zone and nothing else", () => {
    expect(kept(withItem({ measured_at: "2026-11-27T11:59:00.000Z" }))).toBe(1);
    expect(kept(withItem({ measured_at: "2026-11-27T19:59:00+08:00" }))).toBe(1);
    expect(kept(withItem({ resets_at: "2026-11-27T19:59+08:00" }))).toBe(1);
    expect(kept(withItem({ resets_at: "2026-11-27T19:59:00.123456789Z" }))).toBe(1);
    expect(kept(withItem({ measured_at: "2026-11-27" }))).toBe(0);
    expect(kept(withItem({ measured_at: "2026-11-27T11:59:00" }))).toBe(0);
    expect(kept(withItem({ measured_at: "2026-13-40T11:59:00Z" }))).toBe(0);
    expect(kept(withItem({ resets_at: " 2026-11-27T11:59:00Z" }))).toBe(0);
    expect(kept(withItem({ resets_at: 1795400000 }))).toBe(0);
    expect(withItem({ resets_at: "soon" }).first_drop).toBe(
      "items[0]：resets_at 不是 ISO 8601 的時間",
    );
    expect(withItem({ measured_at: undefined, resets_at: undefined }).items[0]).toMatchObject({
      measured_at: null,
      resets_at: null,
    });
  });

  it("takes only the known severities and group states", () => {
    expect(withItem({ severity: "critical" }).items[0]?.severity).toBe("critical");
    expect(withItem({ severity: "normal" }).items[0]?.severity).toBe("normal");
    expect(withItem({ severity: "urgent" }).first_drop).toBe(
      "items[0]：severity 不是 normal、warn、critical 其中之一",
    );
    expect(withGroup({ state: "unavailable" }).groups[0]?.state).toBe("unavailable");
    expect(withGroup({ state: "stale" }).groups[0]?.state).toBe("stale");
    expect(withGroup({ state: "down" }).groups).toHaveLength(0);
  });

  it("keeps an item only in a group the block lists", () => {
    expect(kept(withItem({ group: "nowhere" }))).toBe(0);
    expect(withItem({ group: "nowhere" }).first_drop).toBe(
      "items[0]：group nowhere 不在 groups 裡",
    );
    expect(kept(withItem({ group: "bad id" }))).toBe(0);
    const dropped = ok({ ...BLOCK, groups: [{ id: "claude:default", label: "" }] });
    expect(dropped.items).toHaveLength(0);
    expect(dropped.dropped).toBe(2);
    expect(withItem({ group: undefined }).items[0]?.group).toBeNull();
  });

  it("holds every stale limit within its bounds", () => {
    expect(ok({ v: 1, stale_after_s: 1 }).stale_after_s).toBe(STALE_AFTER_S.min);
    expect(ok({ v: 1, stale_after_s: 10 ** 9 }).stale_after_s).toBe(STALE_AFTER_S.max);
    expect(ok({ v: 1, stale_after_s: 60 }).stale_after_s).toBe(60);
    expect(ok({ v: 1, stale_after_s: "60" }).stale_after_s).toBe(STALE_AFTER_S.fallback);
    expect(withItem({ stale_after_s: 1 }).items[0]?.stale_after_s).toBe(STALE_AFTER_S.min);
    expect(withItem({ stale_after_s: 10 ** 9 }).items[0]?.stale_after_s).toBe(STALE_AFTER_S.max);
    expect(withItem({ stale_after_s: "60" }).first_drop).toBe("items[0]：stale_after_s 不是數字");
    expect(withItem({ stale_after_s: Number.POSITIVE_INFINITY }).first_drop).toBe(
      "items[0]：stale_after_s 不是數字",
    );
    expect(ok({ v: 1, stale_after_s: Number.POSITIVE_INFINITY }).stale_after_s).toBe(
      STALE_AFTER_S.fallback,
    );
    const block = ok({ v: 1, stale_after_s: 60, items: [{ id: "i", label: "I", value: 1 }] });
    expect(block.items[0]?.stale_after_s).toBe(60);
    expect(withItem({ stale_after_s: 30 }).items[0]?.stale_after_s).toBe(30);
  });
});

function metric(change: Partial<Metric> = {}): Metric {
  return {
    id: "m",
    group: null,
    label: "M",
    value: 1,
    unit: "%",
    resets_at: null,
    measured_at: iso(-30_000),
    severity: "normal",
    stale_after_s: 900,
    ...change,
  };
}

describe("readMetric", () => {
  it("reads a recent metric as current, with its age", () => {
    expect(readMetric(metric(), "ok", NOW)).toMatchObject({
      age_s: 30,
      stale: null,
      reset_passed: false,
    });
  });

  it("reads a metric past its limit as old, and one at its limit as current", () => {
    expect(readMetric(metric({ measured_at: iso(-900_000) }), "ok", NOW).stale).toBeNull();
    expect(readMetric(metric({ measured_at: iso(-900_001) }), "ok", NOW)).toMatchObject({
      stale: "old",
      age_s: 900,
    });
  });

  it("reads a metric against its own limit", () => {
    const own = metric({ measured_at: iso(-120_000), stale_after_s: 60 });
    expect(readMetric(own, "ok", NOW).stale).toBe("old");
    expect(readMetric({ ...own, stale_after_s: 120 }, "ok", NOW).stale).toBeNull();
  });

  it("never reads a metric of a group that is not ok as current", () => {
    expect(readMetric(metric(), "stale", NOW).stale).toBe("group");
    expect(readMetric(metric(), "unavailable", NOW).stale).toBe("group");
  });

  it("never reads a metric with no measured time as current", () => {
    expect(readMetric(metric({ measured_at: null }), "ok", NOW)).toMatchObject({
      age_s: null,
      stale: "no-time",
    });
  });

  it("allows a little clock skew, and no more", () => {
    const edge = readMetric(metric({ measured_at: iso(FUTURE_SKEW_S * 1000) }), "ok", NOW);
    expect(edge).toMatchObject({ age_s: 0, stale: null });
    const ahead = readMetric(metric({ measured_at: iso(FUTURE_SKEW_S * 1000 + 1) }), "ok", NOW);
    expect(ahead).toMatchObject({ age_s: null, stale: "future" });
  });

  it("reads a metric whose reset has passed as passed, not as a countdown", () => {
    expect(readMetric(metric({ resets_at: iso(0) }), "ok", NOW)).toMatchObject({
      reset_passed: true,
      stale: "reset",
    });
    expect(readMetric(metric({ resets_at: iso(1) }), "ok", NOW)).toMatchObject({
      reset_passed: false,
      stale: null,
    });
    expect(readMetric(metric({ resets_at: iso(-1), measured_at: null }), "ok", NOW)).toMatchObject({
      reset_passed: true,
      stale: "no-time",
    });
  });
});

describe("nextReset", () => {
  it("is the soonest reset still ahead", () => {
    const items = [
      metric({ resets_at: iso(7_200_000) }),
      metric({ resets_at: iso(-1) }),
      metric({ resets_at: iso(0) }),
      metric({ resets_at: iso(3_600_000) }),
      metric({ resets_at: iso(5_000_000) }),
      metric(),
    ];
    expect(nextReset(items, NOW)).toBe(iso(3_600_000));
    expect(nextReset([metric({ resets_at: iso(0) }), metric()], NOW)).toBeNull();
    expect(nextReset([], NOW)).toBeNull();
    const same = new Date(NOW + 3_600_000).toISOString().replace("Z", "+00:00");
    expect(
      nextReset([metric({ resets_at: iso(3_600_000) }), metric({ resets_at: same })], NOW),
    ).toBe(iso(3_600_000));
  });
});

describe("homeMetrics", () => {
  const block = ok({
    v: 1,
    groups: [
      { id: "b", label: "B" },
      { id: "a", label: "A", state: "unavailable", note: "讀不到" },
      { id: "empty", label: "E" },
    ],
    items: [
      { id: "loose", label: "L", value: 5, measured_at: iso(-1000) },
      { id: "a1", group: "a", label: "A1", value: 99, unit: "%", measured_at: iso(-1000) },
      {
        id: "b2",
        group: "b",
        label: "B2",
        value: 2,
        measured_at: iso(-1000),
        resets_at: iso(9000),
      },
      {
        id: "b1",
        group: "b",
        label: "B1",
        value: 1,
        measured_at: iso(-1000),
        resets_at: iso(4000),
      },
    ],
  });

  it("keeps the report's order, groups first and the metrics in no group last", () => {
    const view = homeMetrics("main", block, NOW);
    expect(view?.groups.map((group) => [group.id, group.items.map((item) => item.id)])).toEqual([
      ["b", ["b2", "b1"]],
      ["a", ["a1"]],
      ["empty", []],
      [null, ["loose"]],
    ]);
    expect(view?.groups[0]?.next_reset).toBe(iso(4000));
    expect(view?.groups[1]).toMatchObject({
      state: "unavailable",
      note: "讀不到",
      next_reset: null,
    });
    expect(view?.groups[1]?.items[0]?.stale).toBe("group");
    expect(view?.groups[3]).toMatchObject({ label: "", state: "ok", note: "" });
    expect(view?.groups[3]?.items[0]?.stale).toBeNull();
    expect(view).toMatchObject({ home: "main", problem: null, dropped: 0, first_drop: null });
  });

  it("lists no group for metrics in no group when there are none", () => {
    expect(homeMetrics("main", ok(BLOCK), NOW)?.groups.map((group) => group.id)).toEqual([
      "claude:default",
    ]);
  });

  it("uses the block's limit", () => {
    const strict = ok({
      v: 1,
      stale_after_s: 10,
      items: [{ id: "i", label: "I", value: 1, measured_at: iso(-11_000) }],
    });
    expect(homeMetrics("main", strict, NOW)?.groups[0]?.items[0]?.stale).toBe("old");
  });

  it("says why a block could not be used, and has nothing for no block", () => {
    expect(homeMetrics("sm1", parseMetrics({ v: 3 }), NOW)).toEqual({
      home: "sm1",
      problem: "格式版本是 3，看板只認得 1",
      dropped: 0,
      first_drop: null,
      groups: [],
    });
    expect(homeMetrics("main", parseMetrics(undefined), NOW)).toBeNull();
  });

  it("carries how many entries were left out", () => {
    const view = homeMetrics("main", ok({ ...BLOCK, items: [ITEM, 3] }), NOW);
    expect(view).toMatchObject({ dropped: 1, first_drop: "items[1]：不是物件" });
  });
});

describe("boardMetrics and metricFlags", () => {
  it("lists the homes with metrics in the homes' order", () => {
    const views = boardMetrics(
      [
        { id: "main", metrics: ok(BLOCK) },
        { id: "sm1", metrics: null },
        { id: "far1", metrics: parseMetrics(undefined) },
        { id: "sm2", metrics: parseMetrics({ v: 2 }) },
      ],
      NOW,
    );
    expect(views.map((view) => view.home)).toEqual(["main", "sm2"]);
  });

  it("flags each metric's staleness and passed reset, so time alone changes the page's version", () => {
    const fresh = boardMetrics([{ id: "main", metrics: ok(BLOCK) }], NOW);
    expect(metricFlags(fresh)).toEqual(['["main","claude:default.five_hour",null,false]']);
    const later = boardMetrics([{ id: "main", metrics: ok(BLOCK) }], Date.parse(ITEM.resets_at));
    expect(metricFlags(later)).toEqual(['["main","claude:default.five_hour","reset",true]']);
    expect(metricFlags([])).toEqual([]);
  });
});
