import { afterAll, describe, expect, it } from "vitest";

import { boardPath, removeHomes, writeHome } from "./fixtures.test-helper.js";
import { USAGE, printOrder } from "./print-order.js";

afterAll(removeHomes);

function run(args: string[]): { code: number; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = printOrder(args, {
    nowMs: Date.parse("2026-12-07T02:30:00Z"),
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { code, stdout, stderr };
}

describe("printOrder", () => {
  it("prints one JSON line per entry, in order, then one per skipped topic", () => {
    const home = writeHome({
      topics: {
        v: 1,
        queues: { high: ["b"], normal: ["a"], later: ["c"] },
        topics: { a: { name: "A", goal: "do a" }, b: { name: "B" }, c: { name: "C" } },
      },
    });
    const { code, stdout, stderr } = run([home]);
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const lines = stdout.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => [line["kind"], line["topic"]])).toEqual([
      ["dispatch", "b"],
      ["dispatch", "a"],
      ["skip", "c"],
    ]);
    expect(lines[1]).toEqual({
      kind: "dispatch",
      topic: "a",
      name: "A",
      goal: "do a",
      queue: "normal",
      position: 1,
      occurrence: null,
      hashtags: [],
      reason: "queue normal, position 1",
    });
  });

  it("prints nothing for an empty home", () => {
    expect(run([writeHome({})])).toEqual({ code: 0, stdout: [], stderr: [] });
  });

  it("exits 1 with the file's problem and prints no order when a file is malformed", () => {
    const home = writeHome({ topics: { queues: { high: ["a"] } }, schedules: "[" });
    const { code, stdout, stderr } = run([home]);
    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(
      new RegExp(`^print-order: ${boardPath(home, "schedules")}: is not valid JSON \\(`),
    );
  });

  it.each([[[]], [["a", "b"]], [["relative/home"]], [[""]]])(
    "exits 2 with the usage for arguments %j",
    (args) => {
      expect(run(args)).toEqual({ code: 2, stdout: [], stderr: [USAGE] });
    },
  );
});
