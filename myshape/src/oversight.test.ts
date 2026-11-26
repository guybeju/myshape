import { describe, expect, it } from "vitest";
import {
  capProblem,
  changesInLastHour,
  isReverted,
  lastSeenAt,
  revertable,
  unseenChanges,
} from "./oversight.js";
import type { Watched, WatchedRecord } from "./oversight.js";

const WATCHED: Watched = {
  changes: new Set(["thing.added", "thing.removed"]),
  reverted: "thing.reverted",
  seen: "thing.seen",
};
const NOW = 1_800_000_000;

function change(rid: string, ts: number, by = "aggregator", kind = "thing.added"): WatchedRecord {
  return { rid, ts, kind, by };
}

describe("the hourly cap", () => {
  it("counts only the aggregator's watched changes in the last hour", () => {
    const records = [
      change("r1", NOW - 3600),
      change("r2", NOW - 3599),
      change("r3", NOW - 10, "captain"),
      change("r4", NOW - 10, "aggregator", "thing.other"),
      change("r5", NOW, "aggregator", "thing.removed"),
    ];
    expect(changesInLastHour(records, WATCHED, NOW)).toBe(2);
  });

  it("refuses the change that would go over the cap and says the captain can raise it", () => {
    const records = [change("r1", NOW - 5), change("r2", NOW - 4)];
    expect(capProblem(records, WATCHED, NOW, 3)).toBeNull();
    const problem = capProblem(records, WATCHED, NOW, 2);
    expect(problem).toContain("超過每小時上限");
    expect(problem).toContain("已經改了 2 次，上限是 2 次");
    expect(problem).toContain("請使用者在頁面上調高上限");
    expect(capProblem([], WATCHED, NOW, 0)).toContain("上限是 0 次");
  });
});

describe("the seen mark", () => {
  it("leaves only the aggregator's changes after the latest mark", () => {
    const records = [
      change("r1", 1),
      { rid: "s1", ts: 2, kind: "thing.seen", by: "captain" },
      change("r2", 3),
      change("r3", 4, "captain"),
      change("r4", 5),
    ];
    expect(unseenChanges(records, WATCHED).map((record) => record.rid)).toEqual(["r2", "r4"]);
    expect(lastSeenAt(records, WATCHED)).toBe(2);
  });

  it("with no mark, every change is unseen and nothing was seen", () => {
    const records = [change("r1", 1), change("r2", 2)];
    expect(unseenChanges(records, WATCHED)).toHaveLength(2);
    expect(lastSeenAt(records, WATCHED)).toBeNull();
  });
});

describe("a revert", () => {
  const records = [
    change("r1", 1),
    change("r2", 2, "captain"),
    change("r3", 3),
    { rid: "r4", ts: 4, kind: "thing.reverted", by: "captain", ref: "r3" },
  ];

  it("finds the aggregator's change to take back", () => {
    expect(revertable(records, WATCHED, "r1")).toEqual({ record: records[0] });
  });

  it("says a change already taken back is reverted", () => {
    expect(isReverted(records, WATCHED, "r3")).toBe(true);
    expect(isReverted(records, WATCHED, "r1")).toBe(false);
    expect(revertable(records, WATCHED, "r3")).toEqual({ reverted: true });
  });

  it("refuses a record that is missing or not the aggregator's change", () => {
    expect(revertable(records, WATCHED, "nope")).toEqual({ problem: "找不到紀錄 nope。" });
    expect(revertable(records, WATCHED, "r2")).toEqual({
      problem: "紀錄 r2 不是 aggregator 做的改動，不能撤回。",
    });
  });
});
