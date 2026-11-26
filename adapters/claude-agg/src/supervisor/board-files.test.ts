import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { BoardFileError, HASHTAG_DEFAULTS, readBoard, readTodos } from "./board-files.js";
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
      ["s", { topic: "t", rt: "soft-rt", rings: true }],
      ["r", { topic: "t", rt: "none", rings: true }],
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

describe("what the intervention reads", () => {
  it("names the topics that carry a close proposal", () => {
    const board = readBoard(
      writeHome({
        topics: {
          topics: {
            a: { name: "A", close_proposal: { at: "2026-11-27T00:00:00Z", reason: "r" } },
            b: { name: "B" },
            c: { name: "C", close_proposal: "x" },
          },
        },
      }),
    );
    expect([...board.topics.proposed]).toEqual(["a"]);
  });

  it("reads the hashtag settings, at their defaults when missing or out of range", () => {
    const defaults = readBoard(writeHome({ hashtags: {} })).hashtags.settings;
    expect(defaults).toEqual(HASHTAG_DEFAULTS);
    const set = readBoard(
      writeHome({
        hashtags: {
          settings: {
            aggregator_may_tag: false,
            aggregator_may_create: "no",
            per_topic_max: 33,
            board_max: 500,
            aggregator_hourly_max: 0,
          },
        },
      }),
    ).hashtags.settings;
    expect(set).toEqual({
      aggregator_may_tag: false,
      aggregator_may_create: true,
      per_topic_max: 8,
      board_max: 500,
      aggregator_hourly_max: 0,
    });
    const low = readBoard(
      writeHome({
        hashtags: { settings: { per_topic_max: 0, board_max: 1.5, aggregator_hourly_max: 1001 } },
      }),
    ).hashtags.settings;
    expect([low.per_topic_max, low.board_max, low.aggregator_hourly_max]).toEqual([8, 50, 20]);
  });

  it("reads which hashtags are locked, by key", () => {
    const board = readBoard(
      writeHome({
        hashtags: { hashtags: { AI: { key: "ai", locked: true }, B: { key: "b", locked: "yes" } } },
      }),
    );
    expect([...board.hashtags.locked]).toEqual(["ai"]);
  });

  it("reads the board's todo items, skipping those it cannot use", () => {
    const home = writeHome({});
    writeFileSync(
      join(home, "data", "myshape", "todos.json"),
      JSON.stringify({
        v: 1,
        items: {
          a: { state: "claimed", ref: "t-1", title: "A" },
          b: { state: "open" },
          c: { state: "gone", ref: "t-1" },
          d: "x",
        },
      }),
    );
    expect([...readTodos(home)]).toEqual([
      ["a", { state: "claimed", ref: "t-1", title: "A" }],
      ["b", { state: "open", ref: "", title: "" }],
    ]);
    expect(readTodos(join(home, "missing")).size).toBe(0);
  });

  it("says which schedules ring: not paused, not all paused, not waiting for the captain's enable", () => {
    const read = (settings: object, series: object) =>
      [...readBoard(writeHome({ schedules: { settings, series } })).schedules.series].map(
        ([id, entry]) => `${id} ${String(entry.rings)}`,
      );
    const series = {
      on: { topic: "t", state: "on", by: "captain" },
      paused: { topic: "t", state: "paused", by: "captain" },
      mine: { topic: "t", state: "on", by: "aggregator", seen: false },
      seen: { topic: "t", state: "on", by: "aggregator", seen: true },
    };
    expect(read({}, series)).toEqual(["on true", "paused false", "mine true", "seen true"]);
    expect(read({ aggregator_needs_enable: true }, series)).toEqual([
      "on true",
      "paused false",
      "mine false",
      "seen true",
    ]);
    expect(read({ all_paused: true }, series)).toEqual([
      "on false",
      "paused false",
      "mine false",
      "seen false",
    ]);
  });
});
