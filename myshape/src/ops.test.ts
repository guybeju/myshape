// Guard 3.1: every operation in the table, run once through the real commit
// into a scratch directory, saves a change with a record; run again with the
// same arguments, it changes nothing. An operation without a fixture here
// does not compile.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Journal } from "./journal.js";
import { boardPaths } from "./layout.js";
import type { BoardPaths } from "./layout.js";
import { OPERATIONS, applyOperation, assertUnchanged } from "./ops.js";
import type { OperationName } from "./ops.js";
import { RECORD_KINDS } from "./records.js";
import type { StoredRecord } from "./records.js";
import { readBoard } from "./store.js";
import type { CommitTarget, StoredBoard } from "./store.js";
import { emptyTodos } from "./todos.js";
import type { TodoItem, TodoStore } from "./todos.js";
import { emptyState } from "./topics.js";
import { emptyHashtags } from "./hashtags.js";
import type { HashtagRecord, HashtagStore } from "./hashtags.js";
import type { TopicState } from "./topics.js";

const WHO = { label: "plain", agent: "plain-agent", now: "2026-11-21T00:00:00Z", records: [] };

interface Fixture {
  args: Record<string, unknown>;
  fromPage: boolean;
  /** Records saved before this test's own, which the hashtag rails read. */
  records?: HashtagRecord[];
}

/** The aggregator put #AI_INFRA on topic a. */
const AGGREGATOR_ADD: HashtagRecord = {
  rid: "r-old-1",
  ts: 1_795_199_000,
  kind: "hashtag.added",
  by: "aggregator",
  topic: "a",
  before: "",
  after: "AI_INFRA",
};

const FIXTURES = {
  create: { args: { name: "New", goal: "g" }, fromPage: false },
  merge: { args: { from: "b", into: "a" }, fromPage: true },
  "close-propose": { args: { id: "a", reason: "都做完了" }, fromPage: false },
  move: { args: { id: "c", queue: "normal" }, fromPage: true },
  split: { args: { from: "a", name: "Part", goal: "g" }, fromPage: false },
  rename: { args: { id: "a", value: "A two" }, fromPage: true },
  goal: { args: { id: "a", value: "new goal" }, fromPage: false },
  archive: { args: { id: "a" }, fromPage: true },
  keep: { args: { id: "b" }, fromPage: true },
  reopen: { args: { id: "z" }, fromPage: false },
  "todo-add": {
    args: { id: "fresh", title: "登入", topic: "a", action: "登入 VPN", commands: [] },
    fromPage: false,
  },
  "todo-done": { args: { task: "claimed" }, fromPage: false },
  "todo-failed": { args: { task: "claimed", reason: "沒起來" }, fromPage: false },
  "todo-obsolete": { args: { task: "open", reason: "不用了" }, fromPage: false },
  "todo-claim": { args: { task: "open" }, fromPage: true },
  "todo-drop": { args: { task: "open" }, fromPage: true },
  "todo-takedown": { args: { task: "obsolete" }, fromPage: true },
  "program-confirm": {
    args: {
      path: "/opt/agg/bin/feed",
      sha256: "b".repeat(64),
      binding_sha256: "c".repeat(64),
      roles: ["feed", "deliver"],
    },
    fromPage: true,
  },
  "hashtag-add": { args: { id: "b", name: "ai_infra" }, fromPage: false },
  "hashtag-remove": { args: { id: "a", name: "AI_INFRA" }, fromPage: false },
  "hashtag-rename": { args: { name: "OLD", to: "OLDER" }, fromPage: true },
  "hashtag-merge": { args: { name: "OLD", into: "AI_INFRA" }, fromPage: true },
  "hashtag-delete": { args: { name: "OLD" }, fromPage: true },
  "hashtag-lock": { args: { name: "AI_INFRA", locked: true }, fromPage: true },
  "hashtag-color": { args: { name: "AI_INFRA", color: "c5" }, fromPage: true },
  "hashtag-settings": { args: { per_topic_max: 4 }, fromPage: true },
  "hashtag-revert": { args: { rid: "r-old-1" }, fromPage: true, records: [AGGREGATOR_ADD] },
  "hashtag-seen": { args: {}, fromPage: true, records: [AGGREGATOR_ADD] },
  "view-save": { args: { name: "工作", none: ["AI_INFRA"] }, fromPage: true },
  "view-delete": { args: { id: "old" }, fromPage: true },
} satisfies Record<OperationName, Fixture>;

function hashtagsFixture(): HashtagStore {
  const entry = (key: string, by: "captain" | "aggregator") => ({
    key,
    created_at: "2026-11-01T00:00:00Z",
    created_by: by,
    color: "c1" as const,
    locked: false,
  });
  return {
    ...emptyHashtags(),
    hashtags: { AI_INFRA: entry("ai_infra", "aggregator"), OLD: entry("old", "captain") },
    topics: { a: ["AI_INFRA"], c: ["OLD"] },
    views: { old: { name: "舊的", any: ["OLD"], none: [], text: "", untagged: false } },
  };
}

function topicsFixture(): TopicState {
  const state = emptyState();
  const topic = (name: string) => ({
    name,
    goal: "g",
    status: "confirmed" as const,
    created_at: "T",
  });
  state.doc.topics = {
    a: topic("A"),
    b: { ...topic("B"), close_proposal: { at: "T", reason: "做完了" } },
    c: topic("C"),
  };
  state.doc.queues = { high: ["a"], normal: ["b"], later: ["c"] };
  state.archive.topics = { z: { ...topic("Z"), archived_at: "T" } };
  return state;
}

function item(state: TodoItem["state"], extra: Partial<TodoItem> = {}): TodoItem {
  return {
    title: `項目 ${state}`,
    topic: "a",
    action: "做",
    guidance: "",
    commands: [],
    state,
    reason: null,
    at: "T",
    by: "plain-agent",
    ref: "",
    captain_closes: false,
    created_at: "T",
    ...extra,
  };
}

function todosFixture(): TodoStore {
  return {
    ...emptyTodos(),
    items: {
      open: item("open"),
      claimed: item("claimed"),
      obsolete: item("obsolete", { captain_closes: true, reason: "不用了" }),
    },
  };
}

let dir: string;
let paths: BoardPaths;
let journal: Journal;
let target: CommitTarget;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ops-"));
  paths = boardPaths({
    state: path.join(dir, "state"),
    data: path.join(dir, "data"),
    config: path.join(dir, "config"),
  });
  fs.mkdirSync(paths.boardDataDir, { recursive: true });
  const write = (file: string, value: unknown): void =>
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  const topics = topicsFixture();
  write(paths.topics, topics.doc);
  write(paths.archive, topics.archive);
  write(paths.todos, todosFixture());
  write(paths.hashtags, hashtagsFixture());
  journal = new Journal(paths.events);
  let n = 0;
  target = {
    paths,
    sink: {
      has: (rid) => journal.hasRecord(rid),
      append: (record) => journal.appendRecord(record),
    },
    nextRid: () => `r-ops-${(n += 1)}`,
    nowSeconds: () => 1_795_200_000,
  };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function files(): Record<string, string | null> {
  const read = (file: string): string | null =>
    fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  return {
    topics: read(paths.topics),
    archive: read(paths.archive),
    todos: read(paths.todos),
    confirmations: read(paths.confirmations),
    hashtags: read(paths.hashtags),
    events: read(paths.events),
  };
}

function journalLines(): StoredRecord[] {
  const text = files()["events"] ?? "";
  return text === ""
    ? []
    : text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as StoredRecord);
}

function run(board: StoredBoard, op: OperationName) {
  const fixture: Fixture = FIXTURES[op];
  const records = [...(fixture.records ?? []), ...journalLines()];
  return applyOperation(
    target,
    board,
    { op, args: fixture.args, fromPage: fixture.fromPage },
    {
      ...WHO,
      records,
    },
  );
}

describe("every operation in the table", () => {
  it("has a fixture, and nothing else does", () => {
    expect(Object.keys(FIXTURES).toSorted()).toEqual(Object.keys(OPERATIONS).toSorted());
  });

  for (const op of Object.keys(FIXTURES) as OperationName[]) {
    it(`${op} saves its change with a record, and changes nothing the second time`, () => {
      const before = files();
      const first = run(readBoard(paths).board, op);
      expect(first.response).toMatchObject({ ok: true });
      const commitFile = OPERATIONS[op].commitFile;
      expect(first.committed).toBe(commitFile);
      const after = files();
      expect(after[commitFile]).not.toBe(before[commitFile]);
      const lines = journalLines();
      expect(lines.length).toBeGreaterThan(0);
      // A create, merge or split also saves its hashtags' follow-up, with its own outbox.
      const outboxOf = (file: string | null | undefined): StoredRecord[] =>
        file === null || file === undefined
          ? []
          : ((JSON.parse(file) as { outbox?: StoredRecord[] }).outbox ?? []);
      const outbox = [
        ...outboxOf(after[commitFile]),
        ...(commitFile === "topics" ? outboxOf(after["hashtags"]) : []),
      ];
      for (const line of lines) {
        expect(line.rid).toMatch(/^r-ops-\d+$/);
        expect(line.by).toBe(FIXTURES[op].fromPage ? "captain" : "aggregator");
        expect(line.label).toBe("plain");
        expect(line.ts).toBe(1_795_200_000);
        expect(RECORD_KINDS).toContain(line.kind);
        // A confirmation and a change to a hashtag itself are about the whole board, so they alone have no topic or item.
        expect(
          line.topic !== null ||
            line.item !== undefined ||
            commitFile === "confirmations" ||
            commitFile === "hashtags",
        ).toBe(true);
        expect(outbox.map((record) => record.rid)).toContain(line.rid);
      }
      const again = run(readBoard(paths).board, op);
      expect(again.committed).toBeNull();
      expect(files()).toEqual(after);
    });
  }

  it("refuses the captain's presses over the socket and the agent's commands from the page", () => {
    const board = readBoard(paths).board;
    const socket = applyOperation(
      target,
      board,
      { op: "keep", args: { id: "b" }, fromPage: false },
      WHO,
    );
    expect(socket.response).toEqual({
      ok: false,
      code: "refused",
      line: "keep 是使用者在頁面上按的，不能從指令送。",
    });
    const page = applyOperation(
      target,
      board,
      { op: "create", args: { name: "N", goal: "g" }, fromPage: true },
      WHO,
    );
    expect(page.response).toEqual({ ok: false, code: "refused", line: "create 只能從指令送。" });
    const confirm = applyOperation(
      target,
      board,
      { op: "program-confirm", args: FIXTURES["program-confirm"].args, fromPage: false },
      WHO,
    );
    expect(confirm.response).toEqual({
      ok: false,
      code: "refused",
      line: "program-confirm 是使用者在頁面上按的，不能從指令送。",
    });
    const unknown = applyOperation(target, board, { op: "nope", args: {}, fromPage: false }, WHO);
    expect(unknown.response).toEqual({ ok: false, code: "usage", line: "不認得的 op：nope" });
    expect(journalLines()).toEqual([]);
  });

  it("marks a topic record with who made it, and a hands-on record under the topic it shows in", () => {
    const board = readBoard(paths).board;
    const page = run(board, "rename");
    expect(page.records[0]?.text).toBe("議題「A」改名為「A two」（你在頁面上）");
    expect(page.decisions).toEqual([]);
    const kept = run(page.board, "keep");
    expect(kept.records[0]?.text).toBe("議題「B」先不關（你在頁面上）");
    expect(kept.decisions).toEqual([
      { event: "topic.kept", topic: "b", line: "議題「B」先不關（id：b）" },
    ]);
    const merged = run(kept.board, "merge");
    expect(merged.decisions).toEqual([
      { event: "topic.merged", topic: "a", line: "議題「B」已併入「A two」（id：a）" },
    ]);
    const command = run(merged.board, "goal");
    expect(command.records[0]?.text).toBe("議題「A two」的目標改為「new goal」（plain 用指令）");
    expect(command.decisions).toEqual([]);
    const claimed = run(command.board, "todo-claim");
    expect(claimed.records[0]).toMatchObject({ kind: "todo.claimed", item: "open", topic: "a" });
    expect(claimed.notices).toHaveLength(1);
  });

  it("says why a malformed request is refused, and changes nothing", () => {
    const board = readBoard(paths).board;
    const cases: [OperationName, Record<string, unknown>][] = [
      ["create", { name: "N" }],
      ["merge", { from: "a" }],
      ["todo-add", { id: "x" }],
      ["todo-failed", { task: "claimed" }],
    ];
    for (const [op, args] of cases) {
      const result = applyOperation(target, board, { op, args, fromPage: false }, WHO);
      expect(result.response).toMatchObject({ ok: false, code: "usage" });
      expect(result.committed).toBeNull();
    }
    expect(journalLines()).toEqual([]);
  });
});

describe("a result that says it changed nothing", () => {
  it("must hand back the state it was given", () => {
    expect(() => assertUnchanged("op", { a: 1 }, { a: 1 })).not.toThrow();
    expect(() => assertUnchanged("op", { a: 1 }, { a: 2 })).toThrow("op 說沒有改任何東西");
  });
});

describe("each operation's arguments", () => {
  function reply(op: string, args: Record<string, unknown>, fromPage = false) {
    return applyOperation(target, readBoard(paths).board, { op, args, fromPage }, WHO);
  }
  const usage = (op: string, args: Record<string, unknown>, fromPage = false) =>
    expect(reply(op, args, fromPage).response).toMatchObject({ ok: false, code: "usage" });

  it("create takes a name, a goal, and an optional string id and queue", () => {
    usage("create", { goal: "g" });
    usage("create", { name: "N", goal: "g", queue: "soon" });
    usage("create", { name: "N", goal: "g", id: 5 });
    expect(reply("create", { name: "N", goal: "g", id: "own", queue: "later" }).response.line).toBe(
      "ok own 已建立，排在「待辦」最後",
    );
  });

  it("move takes a queue and at most one of first, last and before", () => {
    usage("move", { id: "c" }, true);
    usage("move", { queue: "normal" }, true);
    usage("move", { id: "c", queue: "normal", first: true, before: "b" }, true);
    usage("move", { id: "c", queue: "normal", last: true, before: "b" }, true);
    usage("move", { id: "c", queue: "normal", before: 3 }, true);
    const first = reply("move", { id: "c", queue: "normal", first: true }, true);
    expect(first.board.topics.doc.queues.normal).toEqual(["c", "b"]);
    const last = reply("move", { id: "a", queue: "normal", last: true }, true);
    expect(last.board.topics.doc.queues.normal).toEqual(["c", "b", "a"]);
    const before = reply("move", { id: "a", queue: "normal", before: "b" }, true);
    expect(before.board.topics.doc.queues.normal).toEqual(["c", "a", "b"]);
  });

  it("merge, split and reopen check their optional reason, id and queue", () => {
    usage("merge", { from: "b", into: "a", reason: 3 }, true);
    usage("split", { from: "a", name: "P" });
    usage("split", { name: "P", goal: "g" });
    usage("split", { from: "a", goal: "g" });
    usage("split", { from: "a", name: "P", goal: "g", id: 3 });
    usage("split", { from: "a", name: "P", goal: "g", reason: 3 });
    usage("reopen", { id: "z", queue: "soon" });
    usage("close-propose", { id: "a" });
    usage("rename", { id: "a" }, true);
    usage("archive", {}, true);
    usage("keep", {}, true);
    const split = reply("split", { from: "a", name: "P", goal: "g", id: "piece", reason: "太寬" });
    expect(split.records[0]).toMatchObject({ kind: "topic.split", topic: "piece" });
    expect(split.board.topics.doc.history.at(-1)).toMatchObject({ topic: "piece", reason: "太寬" });
  });

  it("split --dry answers what it would do and changes nothing", () => {
    const dry = reply("split", { from: "a", name: "P", goal: "g", dry: true });
    expect(dry.response).toEqual({ ok: true, line: "ok p 已從 a 拆出，放進「高」" });
    expect(dry.committed).toBeNull();
    expect(dry.board.topics.doc.topics["p"]).toBeUndefined();
    expect(journalLines()).toEqual([]);
  });

  it("todo-add reads every part of the item it is given", () => {
    usage("todo-add", { id: "x", title: "T", action: "a", commands: "c" });
    usage("todo-add", { title: "T", action: "a", commands: [], topic: "a" });
    usage("todo-add", { id: "x", action: "a", commands: [], topic: "a" });
    usage("todo-add", { id: "x", title: "T", commands: [], topic: "a" });
    usage("todo-add", { id: "x", title: "T", action: "a", commands: [1] });
    usage("todo-add", { id: "x", title: "T", action: "a", commands: [], topic: 3 });
    usage("todo-add", { id: "x", title: "T", action: "a", commands: [], topic: null });
    const added = reply("todo-add", {
      id: "x",
      title: "T",
      topic: "a",
      action: "a",
      guidance: "g",
      commands: ["c"],
      ref: "r",
      captain_closes: true,
    });
    expect(added.board.todos.items["x"]).toMatchObject({
      topic: "a",
      guidance: "g",
      commands: ["c"],
      ref: "r",
      captain_closes: true,
      by: "plain-agent",
    });
    expect(added.records[0]).toMatchObject({ kind: "todo.opened", topic: "a", item: "x" });
  });

  it("the verdicts and the presses name their item and reason", () => {
    usage("todo-done", {});
    usage("todo-failed", { reason: "r" });
    usage("todo-obsolete", { task: "open" });
    usage("todo-claim", {}, true);
    usage("todo-drop", {}, true);
    const refused = reply("todo-done", { task: "nope" });
    expect(refused.response).toMatchObject({ ok: false, code: "refused" });
    reply("todo-claim", { task: "open" }, true);
    expect(reply("todo-claim", { task: "open" }, true)).toMatchObject({
      response: { ok: true, line: "ok open 本來就已記下做完了，等驗證" },
      committed: null,
    });
  });
});

describe("hashtags through the table", () => {
  function reply(op: string, args: Record<string, unknown>, fromPage = false) {
    return applyOperation(
      target,
      readBoard(paths).board,
      { op, args, fromPage },
      {
        ...WHO,
        records: journalLines(),
      },
    );
  }

  it("create puts its hashtags on the new topic and saves both files", () => {
    const made = reply("create", { name: "GPU", goal: "g", hashtags: ["ai_infra", "NEW_ONE"] });
    expect(made.response).toEqual({
      ok: true,
      line: "ok gpu 已建立，排在「一般」最後；已貼上 #AI_INFRA、#NEW_ONE（新開的 hashtag：#NEW_ONE）",
    });
    const board = readBoard(paths).board;
    expect(board.topics.doc.topics["gpu"]).toBeDefined();
    expect(board.hashtags.topics["gpu"]).toEqual(["AI_INFRA", "NEW_ONE"]);
    expect(journalLines().map((line) => [line.kind, line.text])).toEqual([
      ["topic.created", "議題「GPU」已建立，排在「一般」最後（plain 用指令）"],
      [
        "hashtag.added",
        "議題「GPU」貼上 #AI_INFRA、#NEW_ONE（新開的 hashtag：#NEW_ONE）（plain 用指令）",
      ],
    ]);
    const again = reply("create", { name: "GPU", goal: "g", hashtags: ["AI_INFRA", "NEW_ONE"] });
    expect(again.committed).toBeNull();
    const more = reply("create", { name: "GPU", goal: "g", hashtags: ["LATER"] });
    expect(more.committed).toBe("hashtags");
  });

  it("create that a hashtag rail refuses makes no topic", () => {
    reply("hashtag-lock", { name: "AI_INFRA", locked: true }, true);
    const refused = reply("create", { name: "GPU", goal: "g", hashtags: ["AI_INFRA"] });
    expect(refused.response).toMatchObject({ ok: false, code: "refused" });
    expect(readBoard(paths).board.topics.doc.topics["gpu"]).toBeUndefined();
    expect(
      reply("create", { name: "GPU", goal: "g", hashtags: "AI_INFRA" }).response,
    ).toMatchObject({
      code: "usage",
    });
  });

  it("merge brings the merged topic's hashtags along, and split copies them", () => {
    const merged = reply("merge", { from: "c", into: "a" }, true);
    expect(merged.response).toMatchObject({ ok: true, line: "ok c 已併入 a；hashtag 取聯集" });
    expect(readBoard(paths).board.hashtags.topics).toEqual({ a: ["AI_INFRA", "OLD"] });
    const split = reply("split", { from: "a", name: "Part", goal: "g" });
    expect(split.response.line).toBe("ok part 已從 a 拆出，放進「高」；帶上 #AI_INFRA、#OLD");
    expect(readBoard(paths).board.hashtags.topics["part"]).toEqual(["AI_INFRA", "OLD"]);
  });

  it("refuses the captain's hashtag operations over the socket and changes nothing", () => {
    const pageOnly = [
      "hashtag-rename",
      "hashtag-merge",
      "hashtag-delete",
      "hashtag-lock",
      "hashtag-color",
      "hashtag-settings",
      "hashtag-revert",
      "hashtag-seen",
      "view-save",
      "view-delete",
    ] as const;
    const before = files();
    for (const op of pageOnly) {
      const result = reply(op, FIXTURES[op].args);
      expect(result.response).toEqual({
        ok: false,
        code: "refused",
        line: `${op} 是使用者在頁面上按的，不能從指令送。`,
      });
    }
    expect(files()).toEqual(before);
  });

  it("an aggregator's change can be taken back on the page, from its record", () => {
    const added = reply("hashtag-add", { id: "b", name: "AI_INFA" });
    const rid = added.records[0]?.rid as string;
    expect(added.records[0]).toMatchObject({
      by: "aggregator",
      label: "plain",
      before: "",
      after: "AI_INFA",
    });
    const back = reply("hashtag-revert", { rid }, true);
    expect(back.records[0]).toMatchObject({ kind: "hashtag.reverted", ref: rid, by: "captain" });
    const board = readBoard(paths).board;
    expect(board.hashtags.topics["b"]).toBeUndefined();
    expect(board.hashtags.hashtags["AI_INFA"]).toBeUndefined();
  });
});

describe("each hashtag operation's arguments", () => {
  function reply(op: string, args: Record<string, unknown>, fromPage = true) {
    return applyOperation(target, readBoard(paths).board, { op, args, fromPage }, WHO);
  }
  const usage = (op: string, args: Record<string, unknown>, fromPage = true) =>
    expect(reply(op, args, fromPage).response).toMatchObject({ ok: false, code: "usage" });

  it("say what each one needs, and change nothing", () => {
    usage("hashtag-add", { id: "a" }, false);
    usage("hashtag-remove", { name: "X" }, false);
    usage("hashtag-rename", { name: "OLD" });
    usage("hashtag-merge", { into: "OLD" });
    usage("hashtag-delete", {});
    usage("hashtag-lock", { name: "OLD", locked: "yes" });
    usage("hashtag-color", { name: "OLD" });
    usage("hashtag-settings", { per_topic_max: "8" });
    usage("hashtag-revert", {});
    usage("view-save", { any: [] });
    usage("view-save", { name: "x", any: "OLD" });
    usage("view-save", { name: "x", none: [1] });
    usage("view-save", { name: "x", text: 3 });
    usage("view-save", { name: "x", id: 3 });
    usage("view-delete", {});
    expect(journalLines()).toEqual([]);
  });

  it("view-save keeps the id it is given", () => {
    const saved = reply("view-save", { id: "mine", name: "我的", any: ["old"], untagged: true });
    expect(saved.board.hashtags.views["mine"]).toEqual({
      name: "我的",
      any: ["OLD"],
      none: [],
      text: "",
      untagged: true,
    });
  });

  it("a split of a topic without hashtags saves only the topic", () => {
    const split = reply("split", { from: "b", name: "Bit", goal: "g" }, false);
    expect(split.response.line).toBe("ok bit 已從 b 拆出，放進「一般」");
    expect(split.records.map((record) => record.kind)).toEqual(["topic.split"]);
  });
});
