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
import { emptySchedules, setPaused } from "./schedules.js";
import type { ScheduleStore, Series } from "./schedules.js";
import { emptyTodos } from "./todos.js";
import type { TodoItem, TodoStore } from "./todos.js";
import { emptyState } from "./topics.js";
import { emptyHashtags } from "./hashtags.js";
import type { HashtagRecord, HashtagStore } from "./hashtags.js";
import type { TopicState } from "./topics.js";

const NOW = "2026-11-21T00:00:00Z";
const WHO = {
  label: "plain",
  agent: "plain-agent",
  now: NOW,
  records: [],
  zone: "Asia/Taipei",
  stalls: () => [],
};
/** The record of the aggregator pausing schedule f, which schedule-revert takes back. */
const PAUSED_F: HashtagRecord[] = [];

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
  "lifecycle-settings": { args: { T2: { remind: 60, raise: 120 } }, fromPage: true },
  "lifecycle-answer": { args: { card: "stall", key: "a", days: 7 }, fromPage: true },
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
  "schedule-add": { args: { topic: "e", daily: true, at: "06:00" }, fromPage: false },
  "schedule-edit": { args: { topic: "d", at: "11:00" }, fromPage: false },
  "schedule-pause": { args: { topic: "d" }, fromPage: false },
  "schedule-resume": { args: { topic: "g" }, fromPage: false },
  "schedule-skip": { args: { topic: "d" }, fromPage: false },
  "schedule-rt": { args: { topic: "d", rt: "hard-rt" }, fromPage: false },
  "schedule-delete": { args: { topic: "g" }, fromPage: false },
  "schedule-take": { args: { key: "d:20261121T0010Z", note: "有空位再開" }, fromPage: false },
  "schedule-close": { args: { key: "d:20261121T0010Z", outcome: "done" }, fromPage: false },
  "schedule-settings": { args: { lead_min: 20 }, fromPage: true },
  "schedule-lock": { args: { topic: "d", lock: "schedule", locked: true }, fromPage: true },
  "schedule-pause-all": { args: { paused: true }, fromPage: true },
  "schedule-revert": { args: { rid: "r-paused-f" }, fromPage: true, records: PAUSED_F },
  "schedule-seen": { args: {}, fromPage: true },
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
    views: {
      old: { name: "舊的", any: ["OLD"], none: [], text: "", untagged: false, order: "priority" },
    },
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
    d: topic("D"),
    e: topic("E"),
    f: topic("F"),
    g: topic("G"),
  };
  state.doc.queues = { high: ["a"], normal: ["b"], later: ["c", "d", "e", "f", "g"] };
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

/** Topic a has a 沒人接 card in front of the captain. */
function lifecycleFixture(): Record<string, unknown> {
  return { v: 1, stalls: { a: { since: "2026-11-20T00:00:00Z", members: ["queued\tmain\tq1"] } } };
}

function series(topic: string, extra: Partial<Series> = {}): Series {
  return {
    topic,
    title: topic.toUpperCase(),
    rule: "weekly mon 10:00",
    tz: "Asia/Taipei",
    duration_min: null,
    lead_min: null,
    rt: "none",
    rt_locked: false,
    state: "on",
    locked: false,
    by: "aggregator",
    seen: true,
    created_at: "2026-11-01T00:00:00Z",
    ...extra,
  };
}

/**
 * d is the aggregator's open schedule with an occurrence coming up, f was on
 * until the aggregator paused it (the record that schedule-revert undoes), and
 * g is the aggregator's paused schedule the captain has not seen.
 */
function schedulesFixture(topics: TopicState): ScheduleStore {
  const store = emptySchedules();
  store.series = {
    d: series("d"),
    f: series("f"),
    g: series("g", { state: "paused", seen: false }),
  };
  store.occurrences = {
    "d:20261121T0010Z": {
      series: "d",
      at: "2026-11-21T00:10:00Z",
      state: "upcoming",
      opened_at: "2026-11-20T23:55:00Z",
      closes_by: "2026-11-21T01:10:00Z",
    },
  };
  const env = {
    topics,
    nowMs: Date.parse(NOW),
    actor: { by: "aggregator" as const, label: "plain" },
    records: [],
    machineZone: "Asia/Taipei",
  };
  const paused = setPaused(store, env, "f", true);
  if (!paused.ok || !paused.changed) throw new Error("the fixture's pause did not change f");
  const [record] = paused.records;
  PAUSED_F.splice(0, PAUSED_F.length, {
    rid: "r-paused-f",
    ts: 1_795_190_000,
    kind: record.kind,
    by: "aggregator",
    ...(record.before === undefined ? {} : { before: record.before }),
    ...(record.after === undefined ? {} : { after: record.after }),
  });
  return paused.store;
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
  write(paths.schedules, schedulesFixture(topics));
  write(paths.lifecycle, lifecycleFixture());
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
    schedules: read(paths.schedules),
    lifecycle: read(paths.lifecycle),
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

const WHOLE_BOARD = new Set([
  "schedule.settings_changed",
  "schedule.all_paused",
  "schedule.seen",
  "lifecycle.settings_changed",
]);

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
        // A confirmation, a change to a hashtag itself and the schedule settings and
        // marks are about the whole board, so they alone have no topic or item.
        expect(
          line.topic !== null ||
            line.item !== undefined ||
            commitFile === "confirmations" ||
            commitFile === "hashtags" ||
            WHOLE_BOARD.has(line.kind),
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

describe("the queue rules of scheduled topics", () => {
  function apply(board: StoredBoard, op: string, args: Record<string, unknown>, fromPage = false) {
    return applyOperation(target, board, { op, args, fromPage }, WHO);
  }

  it("move refuses only taking a scheduled topic out of 待辦", () => {
    const board = readBoard(paths).board;
    expect(apply(board, "move", { id: "d", queue: "high" }, true).response).toEqual({
      ok: false,
      code: "refused",
      line: "這個議題有排程，位置由時間決定；要移出「待辦」，先刪掉排程。",
    });
    const within = apply(board, "move", { id: "d", queue: "later", first: true }, true);
    expect(within.board.topics.doc.queues.later[0]).toBe("d");
    const deleted = apply(board, "schedule-delete", { topic: "g" });
    expect(apply(deleted.board, "move", { id: "g", queue: "high" }).response).toMatchObject({
      ok: true,
    });
  });

  it("merge refuses two scheduled topics, and a single schedule follows into 待辦", () => {
    const board = readBoard(paths).board;
    expect(apply(board, "merge", { from: "d", into: "f" }).response).toMatchObject({
      ok: false,
      line: "兩個議題都有排程，一個議題最多一筆排程：先刪掉其中一筆排程。",
    });
    const merged = apply(board, "merge", { from: "d", into: "a" });
    expect(merged.response.line).toBe("ok d 已併入 a，排程跟著過來，議題放進「待辦」");
    expect(merged.board.topics.doc.queues.high).toEqual([]);
    expect(merged.board.topics.doc.queues.later.at(-1)).toBe("a");
    expect(merged.dispatchable).toEqual([]);
    expect(merged.records.map((record) => record.kind)).toEqual([
      "topic.merged",
      "topic.moved",
      "schedule.merged",
    ]);
    expect(merged.committed).toBe("topics");
    expect(merged.board.schedules.series["d"]?.topic).toBe("d");
    expect(apply(merged.board, "schedule-pause", { topic: "a" }).response).toMatchObject({
      ok: true,
      line: "ok a 排程已暫停",
    });
  });

  it("archiving pauses the schedule and ends its open occurrence in schedules.json, with records", () => {
    const archived = apply(readBoard(paths).board, "archive", { id: "d" });
    expect(archived.committed).toBe("topics");
    expect(archived.records.map((record) => record.kind)).toEqual([
      "schedule.paused",
      "occurrence.closed",
      "topic.archived",
    ]);
    const saved = readBoard(paths).board;
    expect(saved.schedules.series["d"]?.state).toBe("paused");
    expect(saved.schedules.occurrences).toEqual({});
    expect(saved.outbox.schedules.map((record) => record.kind)).toEqual([
      "schedule.paused",
      "occurrence.closed",
    ]);
    expect(saved.outbox.topics.map((record) => record.kind)).toEqual(["topic.archived"]);
    expect(
      journalLines()
        .map((line) => line.kind)
        .toSorted(),
    ).toEqual(["occurrence.closed", "schedule.paused", "topic.archived"].toSorted());
  });

  it("reopening a scheduled topic always lands in 待辦 and makes nothing dispatchable", () => {
    const archived = apply(readBoard(paths).board, "archive", { id: "d" });
    const reopened = apply(archived.board, "reopen", { id: "d", queue: "high" });
    expect(reopened.response.line).toBe(
      "ok d 已重開，放進「待辦」（有排程，排程議題放在「待辦」）",
    );
    expect(reopened.board.topics.doc.queues.later).toContain("d");
    expect(reopened.board.topics.doc.queues.high).not.toContain("d");
    expect(reopened.dispatchable).toEqual([]);
    expect(reopened.board.schedules.series["d"]?.state).toBe("paused");
  });

  it("refuses the captain's schedule presses over the socket, and take from the page", () => {
    const board = readBoard(paths).board;
    for (const op of [
      "schedule-settings",
      "schedule-lock",
      "schedule-pause-all",
      "schedule-revert",
      "schedule-seen",
    ] as const) {
      const result = apply(board, op, FIXTURES[op].args, false);
      expect(result.response).toEqual({
        ok: false,
        code: "refused",
        line: `${op} 是使用者在頁面上按的，不能從指令送。`,
      });
    }
    expect(apply(board, "schedule-take", FIXTURES["schedule-take"].args, true).response).toEqual({
      ok: false,
      code: "refused",
      line: "schedule-take 只能從指令送。",
    });
    expect(journalLines()).toEqual([]);
  });
});

describe("closing an occurrence on the page", () => {
  const KEY = "d:20261121T0010Z";
  function withNotices(board: StoredBoard): StoredBoard {
    const schedules = structuredClone(board.schedules) as ScheduleStore;
    (schedules.occurrences[KEY] as { notices?: Record<string, string> }).notices = {
      pre: "w-s-d-20261121T0010Z-pre",
    };
    return { ...board, schedules };
  }
  function close(board: StoredBoard, fromPage: boolean) {
    return applyOperation(
      target,
      board,
      { op: "schedule-close", args: { key: KEY, outcome: "skipped" }, fromPage },
      WHO,
    );
  }

  it("tells the aggregator with a fixed sentence once its notices went out", () => {
    const applied = close(withNotices(readBoard(paths).board), true);
    expect(applied.response).toMatchObject({ ok: true });
    expect(applied.scheduleNotices).toEqual([
      {
        topic: "d",
        action: {
          kind: "notice",
          event: "schedule.closed",
          text: "排程「D」11-21（六）08:10 那一場，使用者在看板上跳過了，不用準備了（議題 d，這一場 d:20261121T0010Z）",
          topic: { id: "d", name: "D" },
          occurrence: {
            key: KEY,
            at: "2026-11-21T00:10:00Z",
            local: "2026-11-21T08:10+08:00",
            phase: "closed",
            rt: "none",
          },
        },
      },
    ]);
  });

  it("sends nothing for the aggregator's own close, or before any notice went out", () => {
    expect(close(withNotices(readBoard(paths).board), false).scheduleNotices).toEqual([]);
    expect(close(readBoard(paths).board, true).scheduleNotices).toEqual([]);
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

  it("move takes after only from the page; the socket's move is as it was", () => {
    usage("move", { id: "a", queue: "normal", after: "b", before: "c" }, true);
    usage("move", { id: "a", queue: "normal", after: "b", first: true }, true);
    usage("move", { id: "a", queue: "normal", after: "b", last: true }, true);
    usage("move", { id: "a", queue: "normal", after: 3 }, true);
    reply("move", { id: "c", queue: "normal", last: true });
    const page = reply("move", { id: "a", queue: "normal", after: "b" }, true);
    expect(page.board.topics.doc.queues.normal).toEqual(["b", "a", "c"]);
    reply("move", { id: "a", queue: "high" });
    const socket = reply("move", { id: "a", queue: "normal", after: "b" });
    expect(socket.board.topics.doc.queues.normal).toEqual(["b", "c", "a"]);
    const socketLast = reply("move", { id: "a", queue: "normal", after: 3, last: true });
    expect(socketLast.board.topics.doc.queues.normal).toEqual(["b", "c", "a"]);
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

  it("schedule operations read their days, time, minutes, zone, rt and note", () => {
    const later = { topic: "e" };
    usage("schedule-add", { daily: true, at: "06:00" });
    usage("schedule-add", { ...later, daily: true, weekly: "mon", at: "06:00" });
    usage("schedule-add", { ...later, weekly: "someday", at: "06:00" });
    usage("schedule-add", { ...later, weekly: 3, at: "06:00" });
    usage("schedule-add", { ...later, daily: true, at: "6" });
    usage("schedule-add", { ...later, daily: true, at: 600 });
    usage("schedule-add", { ...later, daily: true, at: "06:00", duration: "1.5" });
    usage("schedule-add", { ...later, daily: true, at: "06:00", lead: "-1" });
    usage("schedule-add", { ...later, daily: true, at: "06:00", tz: 8 });
    usage("schedule-add", { ...later, daily: true, at: "06:00", rt: "urgent" });
    usage("schedule-edit", { at: "06:00" });
    usage("schedule-rt", { topic: "d", rt: "urgent" });
    usage("schedule-pause", {});
    usage("schedule-take", {});
    usage("schedule-take", { key: "d:20261121T0010Z", note: 5 });
    usage("schedule-close", { key: "d:20261121T0010Z", outcome: "finished" });
    usage("schedule-lock", { topic: "d", lock: "everything", locked: true }, true);
    usage("schedule-lock", { topic: "d", lock: "rt", locked: "yes" }, true);
    usage("schedule-pause-all", { paused: "yes" }, true);
    usage("schedule-revert", {}, true);
    const added = reply("schedule-add", {
      topic: "e",
      weekly: "mon,thu",
      at: "09:30",
      duration: "30",
      lead: 0,
      tz: "Europe/London",
      rt: "soft-rt",
    });
    expect(added.board.schedules.series["e"]).toMatchObject({
      rule: "weekly mon,thu 09:30",
      duration_min: 30,
      lead_min: 0,
      tz: "Europe/London",
      rt: "soft-rt",
      by: "aggregator",
    });
    const rt = reply("schedule-rt", { topic: "d", rt: "none" });
    expect(rt.response).toEqual({ ok: true, line: "ok d rt 本來就是 none" });
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
    usage("view-save", { name: "x", order: "sideways" });
    usage("view-save", { name: "x", order: 1 });
    usage("view-save", { name: "x", order: "" });
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
      order: "priority",
    });
  });

  it("view-save keeps the order the page lists cards in, and refuses one it does not know", () => {
    const saved = reply("view-save", { id: "mine", name: "我的", order: "oldest" });
    expect(saved.board.hashtags.views["mine"]?.order).toBe("oldest");
  });

  it("a split of a topic without hashtags saves only the topic", () => {
    const split = reply("split", { from: "b", name: "Bit", goal: "g" }, false);
    expect(split.response.line).toBe("ok bit 已從 b 拆出，放進「一般」");
    expect(split.records.map((record) => record.kind)).toEqual(["topic.split"]);
  });
});

describe("the lifecycle operations", () => {
  function apply(board: StoredBoard, op: string, args: Record<string, unknown>, fromPage = true) {
    return applyOperation(target, board, { op, args, fromPage }, WHO);
  }
  const lifecycleFile = (): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(paths.lifecycle, "utf8")) as Record<string, unknown>;

  it("先不關 keeps a topic until a date, 14 days by default, or moves it to 待辦; never with no choice", () => {
    const board = readBoard(paths).board;
    const kept = apply(board, "keep", { id: "b" });
    expect(kept.board.lifecycle.kept["b"]).toBe("2026-12-05T00:00:00.000Z");
    expect((lifecycleFile()["kept"] as Record<string, string>)["b"]).toBe(
      "2026-12-05T00:00:00.000Z",
    );
    const days = apply(board, "keep", { id: "b", days: 30 });
    expect(days.board.lifecycle.kept["b"]).toBe("2026-12-21T00:00:00.000Z");
    const later = apply(board, "keep", { id: "b", later: true });
    expect(later.records.map((record) => record.kind)).toEqual(["topic.kept", "topic.moved"]);
    expect(later.response.line).toBe("ok b 先不關，移到「待辦」");
    expect(later.board.topics.doc.queues.later.at(-1)).toBe("b");
    for (const bad of [0, 91, "7"])
      expect(apply(board, "keep", { id: "b", days: bad }).response).toMatchObject({
        code: "usage",
      });
  });

  it("先不關 on a 沒人處理的議題 card keeps the topic until then and takes the card away", () => {
    const board = readBoard(paths).board;
    const idle = {
      ...board,
      lifecycle: { ...board.lifecycle, idle: { a: "2026-11-20T00:00:00Z" } },
    };
    const result = apply(idle, "lifecycle-answer", { card: "idle", key: "a", days: 3 });
    expect(result.response).toEqual({ ok: true, line: "ok a 先不關，到 11-24" });
    expect(result.board.lifecycle.kept["a"]).toBe("2026-11-24T00:00:00.000Z");
    expect(result.board.lifecycle.idle).toEqual({});
    expect(result.records).toMatchObject([
      { kind: "lifecycle.answered", topic: "a", outcome: "kept", by: "captain" },
    ]);
    expect(apply(board, "lifecycle-answer", { card: "idle", key: "a" }).response).toMatchObject({
      code: "refused",
    });
    expect(apply(board, "lifecycle-answer", { card: "close", key: "a" }).response).toMatchObject({
      code: "usage",
    });
    expect(apply(board, "lifecycle-answer", { card: "idle" }).response).toMatchObject({
      code: "usage",
    });
  });

  it("請 <aggregator> 處理 saves the ask with its record and hands over one message, once", () => {
    const board = readBoard(paths).board;
    const since = "2026-11-20T00:00:00Z";
    const stalled = {
      ...board,
      lifecycle: { ...board.lifecycle, stalls: { a: { since, members: ["queued\tmain\tq"] } } },
    };
    const member = {
      key: "queued\tmain\tq",
      kind: "queued" as const,
      home: "main",
      id: "q",
      label: "main/q",
      states: ["Q5" as const],
      since,
    };
    const view = {
      key: "a",
      topic: "a",
      state: "N2" as const,
      since,
      deferred_until: null,
      asked_at: null,
      members: [member],
    };
    const who = { ...WHO, stalls: () => [view] };
    const request = { op: "lifecycle-answer", args: { card: "stall", key: "a", ask: true } };
    const result = applyOperation(target, stalled, { ...request, fromPage: true }, who);
    expect(result.response).toEqual({ ok: true, line: "ok a 已請 plain 處理" });
    expect(result.board.lifecycle.stalls["a"]?.asked).toEqual({
      at: "2026-11-21T00:00:00.000Z",
      members: ["queued\tmain\tq"],
    });
    expect(result.records).toMatchObject([
      { kind: "lifecycle.answered", topic: "a", outcome: "asked", by: "captain" },
    ]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ topic: "a" });
    expect(result.messages[0]?.text).toContain("main/q（停著、沒有日期也沒有等的項目）");
    const again = applyOperation(target, result.board, { ...request, fromPage: true }, who);
    expect(again.response).toMatchObject({ ok: false, code: "refused" });
    expect(again.messages).toEqual([]);
    expect(apply(stalled, "lifecycle-answer", request.args).response).toMatchObject({
      code: "refused",
      line: "看板現在列不出這張卡的成員，稍後再按一次。",
    });
    // 延到 sends no message.
    const put = apply(stalled, "lifecycle-answer", { card: "stall", key: "a", days: 3 });
    expect(put.response).toMatchObject({ ok: true });
    expect(put.messages).toEqual([]);
  });

  it("請 <aggregator> 處理 names an archived topic by its name, and one the board does not know by its id", () => {
    const board = readBoard(paths).board;
    const since = "2026-11-20T00:00:00Z";
    const member = {
      key: "queued\tmain\tq",
      kind: "queued" as const,
      home: "main",
      id: "q",
      label: "main/q",
      states: ["Q4" as const],
      since,
    };
    const card = (key: string) => ({
      key,
      topic: key,
      state: "N2" as const,
      since,
      deferred_until: null,
      asked_at: null,
      members: [member],
    });
    const stalls = {
      z: { since, members: ["queued\tmain\tq"] },
      nope: { since, members: ["queued\tmain\tq"] },
    };
    const stalled = { ...board, lifecycle: { ...board.lifecycle, stalls } };
    const who = { ...WHO, stalls: () => [card("z"), card("nope")] };
    const ask = (key: string) =>
      applyOperation(
        target,
        stalled,
        { op: "lifecycle-answer", args: { card: "stall", key, ask: true }, fromPage: true },
        who,
      ).messages[0]?.text;
    expect(ask("z")).toMatch(/^使用者請你處理議題「Z」（id z）/);
    expect(ask("nope")).toMatch(/^使用者請你處理議題「nope」（id nope）/);
  });

  it("refuses a hands-on operation from a state it may not start from, and changes nothing", () => {
    const board = readBoard(paths).board;
    const rejected = apply(board, "todo-failed", { task: "claimed", reason: "沒起來" }, false);
    const again = apply(
      rejected.board,
      "todo-failed",
      { task: "claimed", reason: "還是不行" },
      false,
    );
    expect(again.response).toEqual({
      ok: false,
      code: "refused",
      line: "claimed 現在是「驗證沒過」，不能 todo-failed；現在能做的：todo-claim、todo-done、todo-obsolete、todo-drop。",
    });
    expect(again.committed).toBeNull();
    // The same verdict again is a redo: nothing changes, and it is not refused.
    const redo = apply(rejected.board, "todo-failed", { task: "claimed", reason: "沒起來" }, false);
    expect(redo.response).toMatchObject({ ok: true });
    expect(redo.committed).toBeNull();
    expect(apply(board, "todo-takedown", { task: "open" }).response).toMatchObject({
      code: "refused",
    });
  });

  it("keeps the deadline settings and the lifecycle answers on the page only", () => {
    const board = readBoard(paths).board;
    for (const op of ["lifecycle-settings", "lifecycle-answer"])
      expect(apply(board, op, {}, false).response).toEqual({
        ok: false,
        code: "refused",
        line: `${op} 是使用者在頁面上按的，不能從指令送。`,
      });
    expect(
      apply(board, "lifecycle-settings", { T2: { remind: 9, raise: 1 } }).response,
    ).toMatchObject({
      code: "usage",
    });
  });
});
