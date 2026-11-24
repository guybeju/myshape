import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyConfirmations } from "./confirmations.js";
import * as files from "./files.js";
import { Journal, Offsets, Summaries } from "./journal.js";
import { boardPaths, parseConfigArgs } from "./layout.js";
import type { BoardPaths } from "./layout.js";
import type { StoredRecord } from "./records.js";
import { commitChange, loadBoard, readBoard } from "./store.js";
import type { CommitTarget, StoredBoard } from "./store.js";
import { addItem, claimItem, emptyTodos, withProjection } from "./todos.js";
import { archive, create, emptyState, reopen } from "./topics.js";
import type { TopicResult, TopicState } from "./topics.js";

let dir: string;
let paths: BoardPaths;
let saved: StoredRecord[];
let target: CommitTarget;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-storage-"));
  paths = boardPaths({
    state: path.join(dir, "state"),
    data: path.join(dir, "data"),
    config: path.join(dir, "config"),
  });
  fs.mkdirSync(paths.boardDataDir, { recursive: true });
  saved = [];
  let n = 0;
  target = {
    paths,
    sink: {
      has: (rid) => saved.some((record) => record.rid === rid),
      append: (record) => void saved.push(record),
    },
    nextRid: () => `r-test-${(n += 1)}`,
    nowSeconds: () => 100,
  };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** What the files hold, read without writing anything. */
function loadTopicState(at: BoardPaths): { state: TopicState; confirmed: unknown[] } {
  const read = readBoard(at);
  return { state: read.board.topics as TopicState, confirmed: read.confirmed };
}

function boardOf(state: TopicState): StoredBoard {
  return {
    topics: state,
    todos: emptyTodos(),
    confirmations: emptyConfirmations(),
    outbox: { topics: [], todos: [], confirmations: [] },
  };
}

/** Saves `next` over `previous` as one topic change with one record. */
function saveTopicState(at: BoardPaths, previous: TopicState, next: TopicState): void {
  void at;
  const records = [{ kind: "topic.moved" as const, topic: "a", text: "moved" }] as const;
  const result = commitChange(
    target,
    boardOf(previous),
    { file: "topics", next, records },
    {
      by: "aggregator",
      label: "plain",
    },
  );
  if (!result.ok) throw new Error(result.line);
}

const mode = (file: string): number => fs.statSync(file).mode & 0o777;

describe("files", () => {
  it("replaces a file atomically with the given mode and leaves no temp file", () => {
    const file = path.join(dir, "f.json");
    files.writeFileAtomic(file, "one", 0o600);
    files.writeFileAtomic(file, "two", 0o600);
    expect(fs.readFileSync(file, "utf8")).toBe("two");
    expect(mode(file)).toBe(0o600);
    expect(fs.readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("removes only stale temp files", () => {
    for (const name of ["a.json.tmp-123", "b.tmp-9", "keep.json", "c.tmp-x", "tmp-5"])
      fs.writeFileSync(path.join(dir, name), "");
    expect(files.removeStaleTemps(dir).toSorted()).toEqual(["a.json.tmp-123", "b.tmp-9"]);
    expect(fs.readdirSync(dir).toSorted()).toEqual(["c.tmp-x", "data", "keep.json", "tmp-5"]);
    expect(files.removeStaleTemps(path.join(dir, "missing"))).toEqual([]);
  });

  it("returns complete lines and cuts off a half-written last line", () => {
    const file = path.join(dir, "log.jsonl");
    expect(files.readCompleteLines(file)).toEqual([]);
    fs.writeFileSync(file, "one\ntwo\nthr");
    expect(files.readCompleteLines(file)).toEqual(["one", "two"]);
    expect(fs.readFileSync(file, "utf8")).toBe("one\ntwo\n");
    expect(files.readCompleteLines(file)).toEqual(["one", "two"]);
    fs.writeFileSync(file, "half");
    expect(files.readCompleteLines(file)).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe("");
    fs.writeFileSync(file, "one\n");
    expect(files.readCompleteLines(file)).toEqual(["one"]);
  });

  it("appends lines, creating the directory and applying the mode", () => {
    const file = path.join(dir, "deep", "er", "log");
    files.appendLine(file, "a", 0o600);
    files.appendLine(file, "b", 0o600);
    expect(fs.readFileSync(file, "utf8")).toBe("a\nb\n");
    expect(mode(file)).toBe(0o600);
    expect(files.fileSize(file)).toBe(4);
    expect(files.fileSize(path.join(dir, "missing"))).toBe(0);
  });

  it("reads JSON, pids, and typed fields defensively", () => {
    const file = path.join(dir, "x");
    expect(files.readJsonFile(file)).toBeNull();
    expect(files.readPidFile(file)).toBeNull();
    fs.writeFileSync(file, "1\n");
    expect(files.readPidFile(file)).toBe(1);
    fs.writeFileSync(file, "42\n");
    expect(files.readJsonFile(file)).toBe(42);
    expect(files.readPidFile(file)).toBe(42);
    for (const bad of ["0", "-3", "1.5", "abc", ""]) {
      fs.writeFileSync(file, bad);
      expect(files.readPidFile(file)).toBeNull();
    }
    expect(files.isAlive(process.pid)).toBe(true);
    expect(files.isAlive(2 ** 22 + 12345)).toBe(false);
    expect(files.isRecord({})).toBe(true);
    expect([null, [], "s", 1].map(files.isRecord)).toEqual([false, false, false, false]);
    expect(files.stringField({ a: "x", b: 1 }, "a")).toBe("x");
    expect(files.stringField({ a: "x", b: 1 }, "b")).toBeNull();
    expect(files.stringField({}, "a")).toBeNull();
    expect(files.textField({ a: "x", b: 1 }, "a")).toBe("x");
    expect(files.textField({ a: "x", b: 1 }, "b")).toBe("");
    expect(files.stringRecord({ a: "x", b: 1, c: "y" })).toEqual({ a: "x", c: "y" });
    expect(files.stringRecord([1])).toEqual({});
    expect(files.orNull(undefined)).toBeNull();
    expect(files.orNull(0)).toBe(0);
    expect(new files.CodedError(69, "why")).toMatchObject({ code: 69, message: "why" });
  });
});

describe("layout", () => {
  it("derives every path from the state and data directories", () => {
    const result = boardPaths({ state: "/s", data: "/d", config: "/c" });
    expect(result).toEqual({
      runtimeDir: "/s/myshape",
      socket: "/s/myshape/board.sock",
      token: "/s/myshape/token",
      port: "/s/myshape/port",
      pid: "/s/myshape/pid",
      log: "/s/myshape/service.log",
      startupError: "/s/myshape/startup-error",
      audit: "/s/myshape/audit.jsonl",
      topics: "/d/topics.json",
      archive: "/d/topics-archive.json",
      dataDir: "/d",
      boardDataDir: "/d/myshape",
      events: "/d/myshape/events.jsonl",
      summaries: "/d/myshape/summaries.jsonl",
      notifyPending: "/d/myshape/notify-pending.json",
      aggregator: "/d/myshape/aggregator.json",
      todos: "/d/myshape/todos.json",
      decisions: "/d/myshape/decisions.json",
      binding: "/c/myshape-aggregator.json",
      confirmations: "/d/myshape/confirmations.json",
    });
  });

  it("parses the shared flags and returns what follows the separator", () => {
    const argv = [
      "--home",
      "/h",
      "--root",
      "/r",
      "--commit",
      "abc",
      "--port",
      "47819",
      "--state",
      "/s",
      "--data",
      "/d",
      "--config",
      "/c",
      "--binding",
      "-",
      "--exempt",
      "bin/a.sh,bin/b",
    ];
    expect(parseConfigArgs([...argv, "--", "move", "--first"])).toEqual({
      config: {
        home: "/h",
        root: "/r",
        commit: "abc",
        port: 47819,
        state: "/s",
        data: "/d",
        config: "/c",
        binding: "-",
        exempt: ["bin/a.sh", "bin/b"],
      },
      rest: ["move", "--first"],
    });
    const none = argv.map((value) => (value === "bin/a.sh,bin/b" ? "-" : value));
    expect(parseConfigArgs(none).config.exempt).toEqual([]);
    // A start without the binding's flags is refused rather than read as "no binding".
    expect(() => parseConfigArgs(argv.slice(0, -6))).toThrow("missing --binding");
    expect(() => parseConfigArgs(argv.slice(0, -2))).toThrow("missing --exempt");
    expect(() =>
      parseConfigArgs(argv.map((value) => (value === "-" ? "not-a-sha" : value))),
    ).toThrow("--binding is not a SHA-256 or -");
    expect(parseConfigArgs(argv).rest).toEqual([]);
    expect(() => parseConfigArgs(argv.slice(2))).toThrow("missing --home");
    expect(() => parseConfigArgs(["--bogus", "x", ...argv])).toThrow(
      "unexpected argument: --bogus",
    );
    expect(() => parseConfigArgs(["stray", ...argv])).toThrow("unexpected argument: stray");
    expect(() => parseConfigArgs([...argv, "--home"])).toThrow("unexpected argument: --home");
    expect(() => parseConfigArgs([...argv.slice(0, 1), "", ...argv.slice(2)])).toThrow(
      "missing --home",
    );
    for (const port of ["0", "65536", "1.5", "x"]) {
      expect(() =>
        parseConfigArgs(argv.map((value) => (value === "47819" ? port : value))),
      ).toThrow("--port is not a port number");
    }
    expect(
      parseConfigArgs(argv.map((value) => (value === "47819" ? "65535" : value))).config.port,
    ).toBe(65535);
    expect(
      parseConfigArgs(argv.map((value) => (value === "47819" ? "1" : value))).config.port,
    ).toBe(1);
  });
});

function done(result: TopicResult): TopicState {
  if (!result.ok) throw new Error(result.line);
  return result.state as TopicState;
}

describe("store", () => {
  it("loads an empty state when nothing is on disk", () => {
    expect(loadTopicState(paths)).toEqual({ state: emptyState(), confirmed: [] });
  });

  it("round-trips topics, queues, merges, and the archive", () => {
    let state = emptyState();
    state = done(create(state, { name: "A", goal: "ga", id: "a", queue: "high" }, "T"));
    state = done(create(state, { name: "B", goal: "gb", id: "b" }, "T"));
    state.doc.topics["a"]!.close_proposal = { at: "T2", reason: "done" };
    state.doc.merged = { old: "a" };
    state.doc.next_seq = 7;
    saveTopicState(paths, emptyState(), state);
    expect(loadTopicState(paths).state).toEqual(state);
    expect(fs.readFileSync(paths.topics, "utf8").endsWith("}\n")).toBe(true);
    expect(fs.existsSync(paths.archive)).toBe(false);

    const archived = done(archive(state, "a", "T3"));
    saveTopicState(paths, state, archived);
    expect(loadTopicState(paths).state).toEqual(archived);
    expect(mode(paths.topics)).toBe(0o644);
  });

  it("writes the archive only when it changes, and never todos.json for a topic change", () => {
    const state = done(create(emptyState(), { name: "A", goal: "g", id: "a" }, "T"));
    saveTopicState(paths, emptyState(), state);
    expect(fs.existsSync(paths.archive)).toBe(false);
    const archived = done(archive(state, "a", "T2"));
    saveTopicState(paths, state, archived);
    const inode = fs.statSync(paths.archive).ino;
    saveTopicState(paths, archived, archived);
    expect(fs.statSync(paths.archive).ino).toBe(inode);
    expect(fs.existsSync(paths.todos)).toBe(false);
  });

  it("writes the file that gains the topic first, so a crash never loses it", () => {
    const live = done(create(emptyState(), { name: "A", goal: "g", id: "a" }, "T"));
    const archived = done(archive(live, "a", "T2"));
    const block = (file: string): void => {
      fs.mkdirSync(file);
      fs.writeFileSync(path.join(file, "in-the-way"), "");
    };
    // Archiving: the archive must be on disk before the topic leaves topics.json.
    block(paths.topics);
    expect(() => saveTopicState(paths, live, archived)).toThrow();
    expect(JSON.parse(fs.readFileSync(paths.archive, "utf8")).topics.a.archived_at).toBe("T2");
    fs.rmSync(paths.topics, { recursive: true });
    fs.rmSync(paths.archive);
    // Reopening: topics.json must have the topic before it leaves the archive.
    block(paths.archive);
    expect(() => saveTopicState(paths, archived, live)).toThrow();
    expect(JSON.parse(fs.readFileSync(paths.topics, "utf8")).topics.a.status).toBe("confirmed");
  });

  it("keeps the live copy of a topic a crash left in both files", () => {
    const live = {
      v: 1,
      topics: { a: { name: "A", goal: "g", status: "confirmed" } },
      queues: { normal: ["a"] },
    };
    const gone = {
      v: 1,
      topics: {
        a: { name: "A", goal: "g", status: "confirmed", archived_at: "T" },
        z: { name: "Z", goal: "g", status: "confirmed" },
      },
    };
    fs.writeFileSync(paths.topics, JSON.stringify(live));
    fs.writeFileSync(paths.archive, JSON.stringify(gone));
    const { state } = loadTopicState(paths);
    expect(Object.keys(state.doc.topics)).toEqual(["a"]);
    expect(state.archive.topics).toEqual({
      z: {
        name: "Z",
        goal: "g",
        status: "confirmed",
        created_at: "",
        archived_at: "",
      },
    });
  });

  it("loads a file written before hands-on items existed, and drops marks it cannot read", () => {
    fs.mkdirSync(path.dirname(paths.topics), { recursive: true });
    const base = { v: 1, next_seq: 1, queues: {}, topics: {} };
    fs.writeFileSync(paths.topics, JSON.stringify(base));
    expect(loadTopicState(paths).state.doc.todos).toEqual({});
    const todos = {
      a: { state: "claimed", at: "2026-11-17T00:00:00Z" },
      b: { state: "rejected", at: "2026-11-17T00:00:00Z", reason: "沒起來" },
      c: { state: "unknown", at: "2026-11-17T00:00:00Z" },
      d: { state: "claimed" },
      e: "nope",
      ["__proto__"]: { state: "claimed", at: "2026-11-17T00:00:00Z" },
    };
    fs.writeFileSync(paths.topics, JSON.stringify({ ...base, todos }));
    expect(loadTopicState(paths).state.doc.todos).toEqual({ a: todos.a, b: todos.b });
    fs.writeFileSync(paths.topics, JSON.stringify({ ...base, todos: [1] }));
    expect(loadTopicState(paths).state.doc.todos).toEqual({});
  });

  it("loads a file written before the history existed, and drops history entries it cannot read", () => {
    fs.mkdirSync(path.dirname(paths.topics), { recursive: true });
    const base = { v: 1, next_seq: 1, topics: {}, queues: {}, merged: { old: "a" } };
    fs.writeFileSync(paths.topics, JSON.stringify(base));
    expect(loadTopicState(paths).state.doc.history).toEqual([]);
    const good = { at: "T", kind: "merged", topic: "a", name: "A", from: "old", from_name: "Old" };
    const history = [
      good,
      { at: "T", kind: "weird", topic: "a", name: "A" },
      { kind: "merged" },
      7,
    ];
    fs.writeFileSync(paths.topics, JSON.stringify({ ...base, history }));
    expect(loadTopicState(paths).state.doc.history).toEqual([good]);
    const told = { ...good, reason: "重複了", by: "page" };
    const odd = [
      { ...good, reason: 7, by: "someone" },
      { ...good, reason: "" },
      { ...good, reason: "two\nlines" },
      { ...good, reason: "x".repeat(201) },
    ];
    fs.writeFileSync(paths.topics, JSON.stringify({ ...base, history: [told, ...odd] }));
    expect(loadTopicState(paths).state.doc.history).toEqual([told, good, good, good, good]);
    fs.writeFileSync(paths.topics, JSON.stringify({ ...base, history: "nope" }));
    expect(loadTopicState(paths).state.doc.history).toEqual([]);
  });

  it("repairs what it can and fills defaults", () => {
    const raw = {
      v: 1,
      next_seq: 0,
      topics: {
        a: {
          name: "A",
          goal: "g",
          status: "confirmed",
          proposed_by: "user",
          suggested_queue: "high",
          close_proposal: { at: "T" },
        },
        p: { name: "P", goal: "g", status: "proposed", suggested_queue: "urgent", created_at: 5 },
      },
      queues: { high: ["a", "a", "p", "ghost", 3], normal: "no", later: [] },
      merged: { old: "a", bad: 3 },
    };
    fs.writeFileSync(paths.topics, JSON.stringify(raw));
    const { doc } = loadBoard(target, "plain").board.topics;
    // A proposal listed in a queue by hand is not in it; it is confirmed like any other.
    expect(doc.queues).toEqual({ high: ["a"], normal: ["p"], later: [] });
    expect(doc.merged).toEqual({ old: "a" });
    expect(doc.next_seq).toBe(1);
    expect(doc.topics["a"]).toEqual({ name: "A", goal: "g", status: "confirmed", created_at: "" });
    expect(doc.topics["p"]).toEqual({ name: "P", goal: "g", status: "confirmed", created_at: "" });
    expect(fs.readFileSync(paths.topics, "utf8")).not.toContain("proposed");
    expect(fs.existsSync(paths.archive)).toBe(false);
    fs.writeFileSync(
      paths.topics,
      JSON.stringify({ ...raw, next_seq: 9, queues: undefined, merged: undefined }),
    );
    expect(loadTopicState(paths).state.doc).toMatchObject({
      next_seq: 9,
      queues: { high: [], normal: ["p"], later: [] },
      merged: {},
    });
    fs.writeFileSync(paths.topics, JSON.stringify({ ...raw, next_seq: 2.5 }));
    expect(loadTopicState(paths).state.doc.next_seq).toBe(1);
  });

  it("confirms leftover proposals at the end of the queue each was proposed for, once", () => {
    const raw = {
      v: 1,
      next_seq: 4,
      queues: { high: ["h"], normal: ["n1", "n2"], later: ["l"] },
      topics: {
        h: { name: "H", goal: "g", status: "confirmed", created_at: "2026-11-01T00:00:00Z" },
        n1: { name: "N1", goal: "g", status: "confirmed", created_at: "2026-11-01T00:00:00Z" },
        n2: { name: "N2", goal: "g", status: "confirmed", created_at: "2026-11-01T00:00:00Z" },
        l: { name: "L", goal: "g", status: "confirmed", created_at: "2026-11-01T00:00:00Z" },
        late: { name: "Late", goal: "g", status: "proposed", created_at: "2026-11-18T03:00:00Z" },
        early: { name: "Early", goal: "g", status: "proposed", created_at: "2026-11-18T01:00:00Z" },
        hot: {
          name: "Hot",
          goal: "g",
          status: "proposed",
          created_at: "2026-11-18T02:00:00Z",
          proposed_by: "an agent",
          suggested_queue: "high",
        },
      },
      merged: { old: "early" },
      history: [{ at: "T", kind: "renamed", topic: "early", name: "Early", from_name: "E" }],
      todos: { x: { state: "claimed", at: "T" } },
    };
    const gone = {
      v: 1,
      topics: {
        dropped: { name: "D", goal: "g", status: "proposed", archived_at: "T", created_at: "T0" },
      },
    };
    fs.writeFileSync(paths.topics, JSON.stringify(raw));
    fs.writeFileSync(paths.archive, JSON.stringify(gone));
    const loaded = loadBoard(target, "plain");
    const first = { state: loaded.board.topics as TopicState, confirmed: loaded.confirmed };
    expect(first.state.doc.queues).toEqual({
      high: ["h", "hot"],
      normal: ["n1", "n2", "early", "late"],
      later: ["l"],
    });
    expect(first.confirmed).toEqual([
      { id: "early", name: "Early", queue: "normal" },
      { id: "hot", name: "Hot", queue: "high" },
      { id: "late", name: "Late", queue: "normal" },
    ]);
    expect(first.state.doc.topics["hot"]).toEqual({
      name: "Hot",
      goal: "g",
      status: "confirmed",
      created_at: "2026-11-18T02:00:00Z",
    });
    expect(first.state.doc.merged).toEqual({ old: "early" });
    expect(first.state.doc.history).toHaveLength(1);
    expect(first.state.doc.todos).toEqual(raw.todos);
    expect(first.state.doc.next_seq).toBe(4);
    expect(first.state.archive.topics["dropped"]).toEqual({
      name: "D",
      goal: "g",
      status: "confirmed",
      created_at: "T0",
      archived_at: "T",
    });

    // Written back at once, by the board, with a record for each, the archived one too:
    // the files no longer hold a proposal, so the next load confirms nothing.
    const { outbox, ...onDisk } = JSON.parse(fs.readFileSync(paths.topics, "utf8")) as {
      outbox: StoredRecord[];
    };
    expect(JSON.stringify(onDisk)).not.toContain("proposed");
    expect(fs.readFileSync(paths.archive, "utf8")).not.toContain("proposed");
    expect(onDisk).toEqual(first.state.doc);
    expect(saved.map((record) => [record.kind, record.topic, record.by, record.text])).toEqual([
      ["topic.confirmed", "early", "board", "議題「Early」已確認，排在「一般」最後"],
      ["topic.confirmed", "hot", "board", "議題「Hot」已確認，排在「高」最後"],
      ["topic.confirmed", "late", "board", "議題「Late」已確認，排在「一般」最後"],
      ["topic.confirmed", "dropped", "board", "議題「D」已確認，留在已封存"],
      [
        "todo.marks_carried",
        null,
        "board",
        "看板開始自己存「要你動手」：從 topics.json 帶過來 1 個舊狀態（x）",
      ],
    ]);
    expect(outbox).toEqual(saved.slice(0, 4));
    // A rewrite replaces the file, so an unchanged inode means it was left alone.
    const written = [fs.statSync(paths.topics).ino, fs.statSync(paths.archive).ino];
    const second = loadBoard(target, "plain");
    expect(second.board.topics).toEqual(first.state);
    expect(second.confirmed).toEqual([]);
    expect([fs.statSync(paths.topics).ino, fs.statSync(paths.archive).ino]).toEqual(written);
    expect(saved).toHaveLength(5);
  });

  it("orders leftover proposals made at the same moment by id", () => {
    const proposal = { goal: "g", status: "proposed", created_at: "2026-11-18T01:00:00Z" };
    const raw = {
      v: 1,
      queues: {},
      topics: {
        b: { ...proposal, name: "B" },
        c: { ...proposal, name: "C" },
        a: { ...proposal, name: "A" },
      },
    };
    fs.writeFileSync(paths.topics, JSON.stringify(raw));
    expect(loadTopicState(paths).state.doc.queues.normal).toEqual(["a", "b", "c"]);
  });

  it("records an archived proposal's confirmation through topics.json", () => {
    const live = {
      v: 1,
      queues: { normal: ["a"] },
      topics: { a: { name: "A", goal: "g", status: "confirmed" } },
    };
    fs.writeFileSync(paths.topics, JSON.stringify(live));
    const gone = {
      v: 1,
      topics: { d: { name: "D", goal: "g", status: "proposed", archived_at: "T" } },
    };
    fs.writeFileSync(paths.archive, JSON.stringify(gone));
    const loaded = loadBoard(target, "plain");
    expect(loaded.confirmed).toEqual([]);
    const { outbox, ...doc } = JSON.parse(fs.readFileSync(paths.topics, "utf8")) as {
      outbox: StoredRecord[];
    };
    expect(doc).toEqual(loaded.board.topics.doc);
    expect(outbox.map((record) => record.text)).toEqual(["議題「D」已確認，留在已封存"]);
    expect(fs.readFileSync(paths.archive, "utf8")).not.toContain("proposed");
    expect(loaded.board.topics.archive.topics["d"]?.status).toBe("confirmed");
  });

  it("refuses a file it cannot understand, naming it", () => {
    const bad: unknown[] = [
      "not json",
      "[]",
      '{"v":2,"topics":{}}',
      '{"v":1}',
      '{"v":1,"topics":{"a":5}}',
      '{"v":1,"topics":{"a":{"name":"A","status":"confirmed"}}}',
      '{"v":1,"topics":{"a":{"name":"A","goal":"g","status":"odd"}}}',
    ];
    for (const text of bad) {
      fs.writeFileSync(paths.topics, text as string);
      expect(() => loadTopicState(paths)).toThrow(`${paths.topics} 讀不懂`);
    }
    fs.rmSync(paths.topics);
    for (const text of ["nope", '{"v":1}', '{"v":2,"topics":{}}', '{"v":1,"topics":[]}']) {
      fs.writeFileSync(paths.archive, text);
      expect(() => loadTopicState(paths)).toThrow(`${paths.archive} 讀不懂`);
    }
  });
});

describe("journal", () => {
  const line = (task: string, ts = 5) =>
    JSON.stringify({ v: 1, ts, event: "task.status", task, state: "working" });

  it("stores ledger lines once per home and reloads them", () => {
    const journal = new Journal(paths.events);
    expect(journal.appendLedger("main", [line("a"), line("b"), line("a")])).toBe(2);
    expect(journal.appendLedger("main", [line("a")])).toBe(0);
    expect(journal.appendLedger("sm", [line("a")])).toBe(1);
    expect(journal.events).toHaveLength(3);
    expect(journal.events[0]).toEqual({
      src: "ledger",
      home: "main",
      ts: 5,
      event: "task.status",
      task: "a",
      fields: JSON.parse(line("a")),
    });
    expect(fs.readFileSync(paths.events, "utf8").split("\n")[0]).toBe(
      JSON.stringify({ src: "ledger", home: "main", raw: line("a") }),
    );

    const reloaded = new Journal(paths.events);
    expect(reloaded.events).toEqual(journal.events);
    expect(reloaded.appendLedger("main", [line("b"), line("c")])).toBe(1);
  });

  it("remembers unreadable ledger lines without showing them", () => {
    const journal = new Journal(paths.events);
    const odd = [
      "not json",
      "[1]",
      JSON.stringify({ ts: 1, task: "t" }),
      JSON.stringify({ ts: 1, event: "e" }),
      JSON.stringify({ ts: "1", event: "e", task: "t" }),
    ];
    expect(journal.appendLedger("main", odd)).toBe(5);
    expect(journal.events).toEqual([]);
    expect(new Journal(paths.events).appendLedger("main", odd)).toBe(0);
    fs.appendFileSync(
      paths.events,
      `${JSON.stringify({ src: "ledger", home: "h" })}\n${JSON.stringify({ src: "ledger", raw: "r" })}\n`,
    );
    const reloaded = new Journal(paths.events);
    expect(reloaded.appendLedger("h", ["null"])).toBe(1);
    expect(reloaded.appendLedger("null", ["r"])).toBe(1);
  });

  it("stores board events and skips junk lines on reload", () => {
    const journal = new Journal(paths.events);
    const record = {
      src: "board" as const,
      rid: "r-1",
      ts: 9,
      kind: "topic.confirmed",
      topic: "a",
      home: null,
      task: null,
      by: "board",
      label: "plain",
      text: "confirmed",
    };
    journal.appendRecord(record);
    fs.appendFileSync(
      paths.events,
      `junk\n[]\n${JSON.stringify({ src: "other" })}\n${JSON.stringify({ src: "board", kind: "k" })}\n${JSON.stringify({ src: "board", ts: 1 })}\n${JSON.stringify({ src: "ledger", home: "h" })}\n${JSON.stringify({ src: "ledger", raw: "r" })}\n${JSON.stringify({ src: "board", ts: 3, kind: "k" })}\n`,
    );
    const reloaded = new Journal(paths.events);
    expect(reloaded.events).toEqual([
      record,
      { src: "board", ts: 3, kind: "k", topic: null, home: null, task: null, text: "" },
    ]);
    expect(reloaded.hasRecord("r-1")).toBe(true);
    expect(reloaded.hasRecord("r-2")).toBe(false);
    expect(mode(paths.events)).toBe(0o644);
  });

  it("reads back a hands-on record's item, actor, label, outcome and reason", () => {
    const journal = new Journal(paths.events);
    const event = {
      src: "board" as const,
      rid: "r-1",
      ts: 9,
      kind: "todo.taken_down",
      topic: null,
      home: null,
      task: null,
      item: "vpn-login",
      by: "aggregator",
      label: "plain",
      outcome: "taken_down",
      reason: "不用了",
      text: "要你動手「登入 VPN」已撤下：不再需要，不用了（plain 用指令）",
    };
    journal.appendRecord(event);
    expect(new Journal(paths.events).events).toEqual([event]);
  });

  it("stores a summary once and reloads valid ones", () => {
    const summaries = new Summaries(paths.summaries);
    const summary = { ts: 1, home: "main", task: "t", kind: "ready" as const, text: "PR is up" };
    expect(summaries.add(summary)).toBe(true);
    expect(summaries.add({ ...summary, ts: 99 })).toBe(false);
    for (const change of [
      { home: "sm" },
      { task: "u" },
      { kind: "landed" as const },
      { text: "other" },
    ]) {
      expect(summaries.add({ ...summary, ...change })).toBe(true);
    }
    fs.appendFileSync(
      paths.summaries,
      `junk\n[]\n${JSON.stringify({ ...summary, kind: "odd" })}\n${JSON.stringify({ ...summary, ts: "1" })}\n${JSON.stringify({ ...summary, home: 1 })}\n${JSON.stringify({ ...summary, task: 1 })}\n${JSON.stringify({ ...summary, text: 1 })}\n`,
    );
    const reloaded = new Summaries(paths.summaries);
    expect(reloaded.all).toEqual(summaries.all);
    expect(reloaded.all).toHaveLength(5);
  });

  it("retracts the latest summary of a kind and lets the same text be stored again", () => {
    const summaries = new Summaries(paths.summaries);
    const landed = { ts: 5, home: "main", task: "t", kind: "landed" as const, text: "landed" };
    summaries.add({ ...landed, ts: 1, kind: "ready", text: "first PR" });
    summaries.add({ ...landed, ts: 2, kind: "ready", text: "second PR" });
    summaries.add(landed);
    summaries.add({ ...landed, task: "other" });
    const reason = { ts: 9, home: "main", task: "t", text: "the merge had failed" };
    expect(summaries.retract({ ...reason, kind: "landed" })).toEqual(landed);
    expect(summaries.retract({ ...reason, kind: "landed" })).toBeNull();
    expect(summaries.retract({ ...reason, kind: "failed" })).toBeNull();
    expect(summaries.retract({ ...reason, home: "sm", kind: "ready" })).toBeNull();
    const shown = (from: Summaries): string[] =>
      from.all.map((entry) => `${entry.task}:${entry.kind}:${entry.text}`);
    expect(shown(summaries)).toEqual([
      "t:ready:first PR",
      "t:ready:second PR",
      "other:landed:landed",
    ]);
    expect(summaries.retract({ ...reason, kind: "ready" })?.text).toBe("second PR");
    expect(shown(new Summaries(paths.summaries))).toEqual([
      "t:ready:first PR",
      "other:landed:landed",
    ]);
    expect(summaries.add({ ...landed, ts: 20 })).toBe(true);
    expect(shown(new Summaries(paths.summaries))).toEqual([
      "t:ready:first PR",
      "other:landed:landed",
      "t:landed:landed",
    ]);
  });

  it("keeps a ledger cursor per home across restarts", () => {
    const offsets = new Offsets(paths);
    expect(offsets.get("main")).toEqual({ offset: 0, sha: "-" });
    offsets.set("main", { offset: 12, sha: "abc" });
    offsets.set("sm", { offset: 3, sha: "def" });
    const cursorFile = path.join(paths.boardDataDir, "offsets.json");
    const written = fs.statSync(cursorFile).mtimeMs;
    const busyUntil = Date.now() + 20;
    while (Date.now() < busyUntil);
    offsets.set("sm", { offset: 3, sha: "def" });
    expect(fs.statSync(cursorFile).mtimeMs).toBe(written);
    offsets.set("sm", { offset: 3, sha: "moved" });
    offsets.set("sm", { offset: 4, sha: "moved" });
    expect(fs.statSync(cursorFile).mtimeMs).toBeGreaterThan(written);
    offsets.set("sm", { offset: 3, sha: "def" });
    const reloaded = new Offsets(paths);
    expect(reloaded.get("main")).toEqual({ offset: 12, sha: "abc" });
    expect(reloaded.get("sm")).toEqual({ offset: 3, sha: "def" });
    const file = path.join(paths.boardDataDir, "offsets.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        main: { offset: "1", sha: "x" },
        sm: { offset: 1 },
        ok: { offset: 4, sha: "s" },
        bad: 3,
      }),
    );
    const partial = new Offsets(paths);
    expect([partial.get("main"), partial.get("sm"), partial.get("ok"), partial.get("bad")]).toEqual(
      [
        { offset: 0, sha: "-" },
        { offset: 0, sha: "-" },
        { offset: 4, sha: "s" },
        { offset: 0, sha: "-" },
      ],
    );
    fs.writeFileSync(file, "not json");
    expect(new Offsets(paths).get("ok")).toEqual({ offset: 0, sha: "-" });
    fs.writeFileSync(file, "[]");
    expect(new Offsets(paths).get("ok")).toEqual({ offset: 0, sha: "-" });
  });
});

// Guard 3.2: the crash matrix of the commit path (design 2.3), one test per
// row. A crash is a failing append or write passed in; a restart is a fresh
// Journal and loadBoard on the same files. No process is started or signalled.
describe("a change and its record survive a crash between them", () => {
  const ACTOR = { by: "aggregator" as const, label: "plain" };
  let failing: boolean;
  let journal: Journal;

  beforeEach(() => {
    failing = false;
    journal = new Journal(paths.events);
    target = { ...target, sink: sinkOf(() => journal) };
  });

  function sinkOf(current: () => Journal): CommitTarget["sink"] {
    return {
      has: (rid) => current().hasRecord(rid),
      append: (record) => {
        if (failing) throw new Error("disk full");
        current().appendRecord(record);
      },
    };
  }

  function restart(): StoredBoard {
    journal = new Journal(paths.events);
    return loadBoard(target, "plain").board;
  }

  function boardLines(): StoredRecord[] {
    return new Journal(paths.events).events.filter(
      (event): event is StoredRecord => event.src === "board",
    );
  }

  function commitTopic(board: StoredBoard, result: TopicResult) {
    if (!result.ok || !result.changed) throw new Error("expected a change");
    return commitChange(
      target,
      board,
      { file: "topics", next: result.state, records: result.records },
      ACTOR,
    );
  }

  function liveBoard(): StoredBoard {
    const state = done(create(emptyState(), { name: "A", goal: "g", id: "a" }, "T"));
    const commit = commitTopic(
      boardOf(emptyState()),
      create(emptyState(), { name: "A", goal: "g", id: "a" }, "T"),
    );
    if (!commit.ok) throw new Error(commit.line);
    expect(commit.board.topics).toEqual(state);
    return commit.board;
  }

  it("nothing renamed: no change and no new record", () => {
    const board = liveBoard();
    fs.rmSync(paths.topics);
    fs.mkdirSync(paths.topics);
    expect(() => commitTopic(board, archive(board.topics, "a", "T2"))).toThrow();
    fs.rmSync(paths.topics, { recursive: true });
    expect(fs.existsSync(paths.archive)).toBe(true);
    const after = restart();
    expect(after.topics.doc.topics).toEqual({});
    expect(boardLines().map((line) => line.kind)).toEqual(["topic.created"]);
  });

  it("an archive with only the archive file renamed: the topic stays live, no record", () => {
    const board = liveBoard();
    const archived = done(archive(board.topics as TopicState, "a", "T2"));
    fs.writeFileSync(paths.archive, `${JSON.stringify(archived.archive, null, 2)}\n`);
    const after = restart();
    expect(Object.keys(after.topics.doc.topics)).toEqual(["a"]);
    expect(after.topics.archive.topics).toEqual({});
    expect(boardLines().map((line) => line.kind)).toEqual(["topic.created"]);
  });

  it("an archive with topics.json renamed and the append lost: replayed once at the start", () => {
    const board = liveBoard();
    failing = true;
    const commit = commitTopic(board, archive(board.topics, "a", "T2"));
    expect(commit).toMatchObject({ ok: true, appendError: "disk full" });
    failing = false;
    expect(boardLines().map((line) => line.kind)).toEqual(["topic.created"]);
    const after = restart();
    expect(Object.keys(after.topics.archive.topics)).toEqual(["a"]);
    expect(boardLines().map((line) => line.kind)).toEqual(["topic.created", "topic.archived"]);
    restart();
    expect(boardLines()).toHaveLength(2);
  });

  it("a reopen with topics.json renamed and the archive not: live wins, the record is replayed", () => {
    let board = liveBoard();
    const commit = commitTopic(board, archive(board.topics, "a", "T2"));
    if (!commit.ok) throw new Error(commit.line);
    board = commit.board;
    fs.rmSync(paths.archive);
    fs.mkdirSync(paths.archive);
    fs.writeFileSync(path.join(paths.archive, "in-the-way"), "");
    expect(() => commitTopic(board, reopen(board.topics, "a", undefined, "T3"))).toThrow();
    fs.rmSync(paths.archive, { recursive: true });
    fs.writeFileSync(paths.archive, `${JSON.stringify(board.topics.archive, null, 2)}\n`);
    const after = restart();
    expect(Object.keys(after.topics.doc.topics)).toEqual(["a"]);
    expect(after.topics.archive.topics).toEqual({});
    expect(boardLines().map((line) => line.kind)).toEqual([
      "topic.created",
      "topic.archived",
      "topic.reopened",
    ]);
  });

  function itemChange(board: StoredBoard, topics = board.topics) {
    const input = {
      id: "vpn",
      title: "登入 VPN",
      topic: "a",
      action: "登入",
      guidance: "",
      commands: [],
      ref: "",
      captainCloses: false,
    };
    const added = addItem(board.todos, topics, input, "T", { name: "fm", label: "plain" });
    if (!added.ok || !added.changed) throw new Error("expected a change");
    const claimed = claimItem(added.store, "vpn", "T", "plain");
    if (!claimed.ok || !claimed.changed) throw new Error("expected a change");
    return { added, claimed };
  }

  it("an item change with only the projection renamed: rebuilt from todos.json, no record", () => {
    const board = liveBoard();
    const { added, claimed } = itemChange(board);
    const commit = commitChange(
      target,
      board,
      { file: "todos", next: added.store, records: added.records },
      ACTOR,
    );
    if (!commit.ok) throw new Error(commit.line);
    const projected = withProjection(commit.board.topics, claimed.store);
    fs.writeFileSync(
      paths.topics,
      `${JSON.stringify({ ...projected.doc, outbox: [] }, null, 2)}\n`,
    );
    const after = restart();
    expect(after.todos.items["vpn"]?.state).toBe("open");
    expect(after.topics.doc.todos).toEqual({});
    expect(boardLines().map((line) => line.kind)).toEqual(["topic.created", "todo.opened"]);
  });

  it("an item change with todos.json renamed and the append lost: replayed, projection rebuilt", () => {
    const board = liveBoard();
    const { added, claimed } = itemChange(board);
    let commit = commitChange(
      target,
      board,
      { file: "todos", next: added.store, records: added.records },
      ACTOR,
    );
    if (!commit.ok) throw new Error(commit.line);
    failing = true;
    const captain = { by: "captain" as const, label: "plain" };
    commit = commitChange(
      target,
      commit.board,
      { file: "todos", next: claimed.store, records: claimed.records },
      captain,
    );
    expect(commit).toMatchObject({ ok: true, appendError: "disk full" });
    failing = false;
    // A crash before topics.json's projection would have caught up.
    const raw = JSON.parse(fs.readFileSync(paths.topics, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(paths.topics, `${JSON.stringify({ ...raw, todos: {} }, null, 2)}\n`);
    const after = restart();
    expect(after.topics.doc.todos).toEqual({ vpn: { state: "claimed", at: "T" } });
    expect(boardLines().map((line) => [line.kind, line.by])).toEqual([
      ["topic.created", "aggregator"],
      ["todo.opened", "aggregator"],
      ["todo.claimed", "captain"],
    ]);
  });

  it("a journal line cut off mid-write: truncated, then the record is replayed once", () => {
    const board = liveBoard();
    failing = true;
    commitTopic(board, archive(board.topics, "a", "T2"));
    failing = false;
    fs.appendFileSync(paths.events, '{"src":"board","rid":"r-test-2","ts":100,"ki');
    restart();
    expect(boardLines().map((line) => line.kind)).toEqual(["topic.created", "topic.archived"]);
    expect(fs.readFileSync(paths.events, "utf8").endsWith("\n")).toBe(true);
  });

  it("a failed append with no crash: the next change saves it first, or is refused", () => {
    let board = liveBoard();
    failing = true;
    const commit = commitTopic(board, archive(board.topics, "a", "T2"));
    if (!commit.ok) throw new Error(commit.line);
    board = commit.board;
    const before = fs.readFileSync(paths.topics, "utf8");
    const refused = commitTopic(board, reopen(board.topics, "a", undefined, "T3"));
    expect(refused).toEqual({ ok: false, line: "看板寫不進紀錄（disk full），這次的修改沒有做" });
    expect(fs.readFileSync(paths.topics, "utf8")).toBe(before);
    failing = false;
    // A hands-on change next, under a topic still live: topics.json's waiting record still
    // reaches the journal first.
    const { added } = itemChange(
      board,
      done(create(emptyState(), { name: "A", goal: "g", id: "a" }, "T")),
    );
    const next = commitChange(
      target,
      board,
      { file: "todos", next: added.store, records: added.records },
      ACTOR,
    );
    expect(next).toMatchObject({ ok: true, appendError: null });
    expect(boardLines().map((line) => line.kind)).toEqual([
      "topic.created",
      "topic.archived",
      "todo.opened",
    ]);
  });

  it("an append that was done: a restart dedupes by record id and adds nothing", () => {
    const board = liveBoard();
    commitTopic(board, archive(board.topics, "a", "T2"));
    const lines = fs.readFileSync(paths.events, "utf8");
    restart();
    restart();
    expect(fs.readFileSync(paths.events, "utf8")).toBe(lines);
  });

  it("replays only whole records from an outbox, with every field they carry", () => {
    const record = {
      src: "board",
      rid: "r-x",
      ts: 7,
      kind: "todo.done",
      topic: "a",
      home: null,
      task: null,
      item: "i",
      by: "aggregator",
      label: "plain",
      outcome: "done",
      reason: "r",
      text: "t",
    };
    const junk = [
      5,
      { ...record, rid: "r-ledger", src: "ledger" },
      { ...record, rid: undefined },
      { ...record, rid: "r-kind", kind: undefined },
      { ...record, rid: "r-by", by: undefined },
      { ...record, rid: "r-ts", ts: "7" },
    ];
    fs.writeFileSync(
      paths.topics,
      JSON.stringify({ ...emptyState().doc, outbox: [...junk, record] }),
    );
    restart();
    expect(boardLines()).toEqual([record]);
  });

  it("starts with the start's own records waiting when they cannot be appended", () => {
    const raw = { v: 1, queues: {}, topics: { p: { name: "P", goal: "g", status: "proposed" } } };
    fs.writeFileSync(paths.topics, JSON.stringify(raw));
    failing = true;
    journal = new Journal(paths.events);
    const loaded = loadBoard(target, "plain");
    expect(loaded.appendErrors).toEqual(["disk full"]);
    expect(boardLines()).toEqual([]);
    failing = false;
    restart();
    expect(boardLines().map((line) => [line.kind, line.by])).toEqual([
      ["topic.confirmed", "board"],
    ]);
  });

  it("refuses to start when a waiting record cannot be saved", () => {
    const board = liveBoard();
    failing = true;
    commitTopic(board, archive(board.topics, "a", "T2"));
    expect(() => restart()).toThrow("看板寫不進紀錄（disk full）");
  });
});
