import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { BoardFileError, readBoard } from "./board-files.js";
import { boardPath, removeHomes, writeHome } from "./fixtures.test-helper.js";
import type { HomeFiles } from "./fixtures.test-helper.js";

afterAll(removeHomes);

const FILES = ["topics", "archive", "hashtags", "schedules"] as const;

function readError(files: HomeFiles): string {
  const home = writeHome(files);
  try {
    readBoard(home);
  } catch (error) {
    expect(error).toBeInstanceOf(BoardFileError);
    return (error as Error).message.replace(home, "<home>");
  }
  throw new Error("readBoard did not fail");
}

describe("readBoard", () => {
  it("reads a home with none of the files as an empty board", () => {
    const board = readBoard(writeHome({}));
    expect(board.topics.topics.size).toBe(0);
    expect(board.topics.queues).toEqual({ high: [], normal: [], later: [] });
    expect(board.topics.merged.size).toBe(0);
    expect(board.archived.size).toBe(0);
    expect(board.hashtags.topics.size).toBe(0);
    expect(board.schedules.series.size).toBe(0);
    expect(board.schedules.occurrences.size).toBe(0);
  });

  it("reads a home that does not exist as an empty board", () => {
    const board = readBoard(join(writeHome({}), "missing"));
    expect(board.topics.topics.size).toBe(0);
  });

  it("reads files without their optional top-level fields", () => {
    const board = readBoard(writeHome({ topics: {}, archive: {}, hashtags: {}, schedules: {} }));
    expect(board.topics.queues.high).toEqual([]);
    expect(board.archived.size).toBe(0);
  });

  for (const file of FILES) {
    it(`fails on ${file} that is not JSON, naming the file`, () => {
      const message = readError({ [file]: "{ not json" });
      expect(message).toContain(`${boardPath("<home>", file)}: is not valid JSON (`);
    });

    it(`fails on ${file} whose top level is not an object`, () => {
      expect(readError({ [file]: "[]" })).toBe(
        `${boardPath("<home>", file)}: is not a JSON object`,
      );
      expect(readError({ [file]: "null" })).toBe(
        `${boardPath("<home>", file)}: is not a JSON object`,
      );
    });

    it(`fails on ${file} with a version other than 1`, () => {
      expect(readError({ [file]: { v: 2 } })).toBe(
        `${boardPath("<home>", file)}: has version 2; only v 1 is known`,
      );
    });

    it(`fails on ${file} that cannot be read`, () => {
      const home = writeHome({});
      mkdirSync(boardPath(home, file));
      expect(() => readBoard(home)).toThrow(`${boardPath(home, file)}: cannot be read (`);
    });
  }

  it.each([
    ["topics", { topics: [] }, '"topics" is not an object'],
    ["topics", { queues: [] }, '"queues" is not an object'],
    ["topics", { queues: { normal: "a" } }, '"queues.normal" is not an array'],
    ["topics", { merged: "a" }, '"merged" is not an object'],
    ["archive", { topics: [] }, '"topics" is not an object'],
    ["hashtags", { topics: 1 }, '"topics" is not an object'],
    ["hashtags", { hashtags: [] }, '"hashtags" is not an object'],
    ["schedules", { series: [] }, '"series" is not an object'],
    ["schedules", { occurrences: "x" }, '"occurrences" is not an object'],
  ] as const)("fails on %s with %j", (file, content, problem) => {
    expect(readError({ [file]: content })).toBe(`${boardPath("<home>", file)}: ${problem}`);
  });

  it("skips topic entries it cannot use", () => {
    const board = readBoard(
      writeHome({
        topics: {
          v: 1,
          queues: { high: ["a", 3, null], later: ["b"] },
          topics: { a: { name: "A", goal: 7 }, "-bad": { name: "bad" }, b: "not a topic" },
          merged: { old: "a", worse: 4 },
        },
        archive: { topics: { c: {}, ".bad": {} } },
      }),
    );
    expect([...board.topics.topics]).toEqual([["a", { name: "A", goal: "", created_at: "" }]]);
    expect(board.topics.queues).toEqual({ high: ["a"], normal: [], later: ["b"] });
    expect([...board.topics.merged]).toEqual([["old", "a"]]);
    expect([...board.archived]).toEqual(["c"]);
  });

  it("skips hashtag entries it cannot use", () => {
    const board = readBoard(
      writeHome({
        hashtags: {
          hashtags: { A: { key: "a" }, B: { color: "c1" }, C: "x" },
          topics: { t: ["A", 1], u: "A" },
        },
      }),
    );
    expect([...board.hashtags.topics]).toEqual([["t", ["A"]]]);
    expect([...board.hashtags.keys]).toEqual([["A", "a"]]);
  });

  it("skips schedules and occurrences it cannot use, and reads an unknown rt as none", () => {
    const good = {
      series: "s",
      at: "2026-12-07T02:00:00Z",
      state: "due",
      closes_by: "2026-12-07T03:00:00Z",
    };
    const board = readBoard(
      writeHome({
        schedules: {
          series: { s: { topic: "t", rt: "soft-rt" }, r: { topic: "t", rt: "max" }, x: {}, y: 1 },
          occurrences: {
            good,
            state: { ...good, state: "closed" },
            at: { ...good, at: "someday" },
            closes: { ...good, closes_by: "never" },
            series: { ...good, series: 9 },
            missing: { series: "s", state: "due" },
            scalar: "x",
          },
        },
      }),
    );
    expect([...board.schedules.series]).toEqual([
      ["s", { topic: "t", rt: "soft-rt" }],
      ["r", { topic: "t", rt: "none" }],
    ]);
    expect([...board.schedules.occurrences]).toEqual([
      [
        "good",
        {
          ...good,
          atMs: Date.parse(good.at),
          closesByMs: Date.parse(good.closes_by),
        },
      ],
    ]);
  });
});
