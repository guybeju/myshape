import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boardPaths } from "./layout.js";
import { commitChange, loadBoard, readBoard } from "./store.js";
import type { CommitTarget } from "./store.js";
import type { StoredRecord } from "./records.js";
import * as todos from "./todos.js";
import type { TodoInput, TodoResult, TodoStore } from "./todos.js";
import { emptyState } from "./topics.js";
import type { TopicState } from "./topics.js";

const NOW = "2026-11-20T00:00:00Z";
const LATER = "2026-11-20T01:00:00Z";
const AGENT = { name: "plain", label: "plain" };

function board(): TopicState {
  const state = emptyState();
  const topic = (name: string) => ({
    name,
    goal: "g",
    status: "confirmed" as const,
    created_at: "",
  });
  state.doc.topics = { solo: topic("建置"), wrap: topic("收尾") };
  state.doc.queues = { high: ["solo"], normal: ["wrap"], later: [] };
  state.doc.merged = { old: "solo" };
  state.archive.topics = { gone: { ...topic("Gone"), archived_at: "" } };
  return state;
}

function input(extra: Partial<TodoInput> = {}): TodoInput {
  return {
    id: "vpn-login",
    title: "登入 VPN",
    topic: "solo",
    action: "用公司帳號登入 VPN",
    guidance: "",
    commands: [],
    ref: "",
    captainCloses: false,
    ...extra,
  };
}

/** A successful result, with its records and notices (none when nothing changed). */
function ok(result: TodoResult) {
  if (!result.ok) throw new Error(`expected success, got: ${result.line}`);
  return {
    ...result,
    store: result.store as TodoStore,
    events: result.changed ? result.records : [],
    notices: result.changed ? result.notices : [],
  };
}

function refusal(result: TodoResult): string {
  if (result.ok) throw new Error(`expected a refusal, got: ${result.line}`);
  return result.line;
}

function add(extra: Partial<TodoInput> = {}, store: TodoStore = todos.emptyTodos()): TodoResult {
  return todos.addItem(store, board(), input(extra), NOW, AGENT);
}

function added(extra: Partial<TodoInput> = {}, store: TodoStore = todos.emptyTodos()): TodoStore {
  return ok(add(extra, store)).store;
}

/** A record of the item vpn-login under topic solo; who made it is added when it is saved. */
function rec(kind: string, text: string, extra: Record<string, unknown> = {}) {
  const { by: _by, ...rest } = extra;
  void _by;
  return { kind, topic: "solo", item: "vpn-login", ...rest, text };
}

describe("adding an item", () => {
  it("stores an action, guidance and each command exactly, open, and records that it opened", () => {
    const commands = ["sudo tee /etc/x <<'EOF'\n\tkey = 1\nEOF", "說明：只是指令"];
    const result = ok(add({ guidance: "先關 VPN。", commands, ref: "r1" }));
    expect(result.line).toBe("ok vpn-login 已放上看板的「要你動手」（議題 solo）");
    expect(result.store.items["vpn-login"]).toEqual({
      title: "登入 VPN",
      topic: "solo",
      action: "用公司帳號登入 VPN",
      guidance: "先關 VPN。",
      commands,
      state: "open",
      reason: null,
      at: NOW,
      by: "plain",
      ref: "r1",
      captain_closes: false,
      created_at: NOW,
    });
    expect(result.events).toEqual([
      rec("todo.opened", "要你動手「登入 VPN」已開：用公司帳號登入 VPN（plain 用指令）"),
    ]);
    expect(result.notices).toEqual([]);
  });

  it("follows a merged topic, and refuses an archived or unknown topic or none", () => {
    expect(added({ topic: "old" }).items["vpn-login"]?.topic).toBe("solo");
    expect(refusal(add({ topic: "nope" }))).toBe("nope 不是看板上還開著的議題，沒有放上任何東西。");
    expect(add({ topic: "gone" }).ok).toBe(false);
    expect(add({ topic: null })).toMatchObject({ ok: false, code: "usage" });
  });

  it("changes nothing when repeated, and records a rewrite that starts the item over", () => {
    const claimed = ok(todos.claimItem(added(), "vpn-login", NOW, "plain")).store;
    const again = ok(todos.addItem(claimed, board(), input(), LATER, AGENT));
    expect(again.changed).toBe(false);
    expect(again.events).toEqual([]);
    const rewritten = ok(
      todos.addItem(claimed, board(), input({ action: "改用新的帳號" }), LATER, AGENT),
    );
    expect(rewritten.store.items["vpn-login"]).toMatchObject({
      state: "open",
      reason: null,
      created_at: NOW,
      at: LATER,
    });
    expect(rewritten.events).toEqual([
      rec("todo.rewritten", "要你動手「登入 VPN」內容已改寫，回到還沒做（plain 用指令）"),
    ]);
  });

  it("refuses malformed parts as usage", () => {
    const bad: Partial<TodoInput>[] = [
      { id: "bad id" },
      { id: "__proto__" },
      { title: "" },
      { action: "a\nb" },
      { commands: [" "] },
      { ref: "x".repeat(129) },
    ];
    for (const extra of bad) expect(add(extra)).toMatchObject({ ok: false, code: "usage" });
    const member = ok(add({ id: "constructor" }));
    expect(Object.keys(member.store.items)).toEqual(["constructor"]);
    expect(ok(todos.doneItem(member.store, "constructor", "plain")).store.items).toEqual({});
    expect(refusal(todos.doneItem(todos.emptyTodos(), "toString", "plain"))).toContain(
      "不是開著的",
    );
  });
});

describe("the life of an item", () => {
  it("claims once, with today's words and the captain's record, and refuses a claim on an item no longer needed", () => {
    const claim = ok(todos.claimItem(added(), "vpn-login", NOW, "plain"));
    expect(claim.notices).toEqual([
      {
        event: "todo.claimed",
        id: "vpn-login",
        title: "登入 VPN",
        ref: "",
        topic: "solo",
        text: "使用者在看板上：「登入 VPN」做完了（vpn-login）。驗證後跑 bin/myshape.sh todo done vpn-login；沒成功就跑 bin/myshape.sh todo failed vpn-login --reason <一行>",
      },
    ]);
    expect(claim.events).toEqual([
      rec("todo.claimed", "要你動手「登入 VPN」：你按了做完了（你在頁面上）", { by: "captain" }),
    ]);
    const again = ok(todos.claimItem(claim.store, "vpn-login", LATER, "plain"));
    expect(again.changed).toBe(false);
    expect(again.notices).toEqual([]);
    const held = added({ captainCloses: true });
    const obsolete = ok(todos.obsoleteItem(held, "vpn-login", "不用了", NOW, "plain")).store;
    expect(refusal(todos.claimItem(obsolete, "vpn-login", NOW, "plain"))).toBe(
      "vpn-login 已經被 plain 標成不再需要，請直接撤下。",
    );
    expect(refusal(todos.claimItem(added(), "nope", NOW, "plain"))).toContain(
      "不是看板上還開著的「要你動手」項目",
    );
  });

  it("puts a failed check back in front of the captain with its reason, and records it", () => {
    const claimed = ok(todos.claimItem(added(), "vpn-login", NOW, "plain")).store;
    const failed = ok(todos.rejectItem(claimed, "vpn-login", "服務沒起來", LATER, "plain"));
    expect(failed.line).toBe("ok vpn-login 已標成驗證沒過，回到要使用者動手");
    expect(failed.store.items["vpn-login"]).toMatchObject({
      state: "rejected",
      reason: "服務沒起來",
      at: LATER,
    });
    expect(failed.events).toEqual([
      rec("todo.rejected", "要你動手「登入 VPN」：plain 驗證沒過：服務沒起來（plain 用指令）", {
        reason: "服務沒起來",
      }),
    ]);
    expect(
      ok(todos.rejectItem(failed.store, "vpn-login", "服務沒起來", LATER, "plain")).changed,
    ).toBe(false);
    for (const reason of ["", "a\nb", "x".repeat(201)])
      expect(refusal(todos.rejectItem(claimed, "vpn-login", reason, LATER, "plain"))).toBe(
        "原因要是一行，最多 200 個字。",
      );
  });

  it("closes on done, with a record on its topic and a notice by the aggregator", () => {
    const done = ok(todos.doneItem(added(), "vpn-login", "plain"));
    expect(done.line).toBe("ok vpn-login 已關（做完了，plain 已驗證）");
    expect(done.store.items).toEqual({});
    expect(done.events).toEqual([
      rec("todo.done", "要你動手「登入 VPN」已關：做完了，plain 已驗證（plain 用指令）", {
        outcome: "done",
      }),
    ]);
    expect(done.notices).toMatchObject([
      { event: "todo.closed", by: "aggregator", words: "做完了", id: "vpn-login" },
    ]);
    expect(refusal(todos.doneItem(done.store, "vpn-login", "plain"))).toBe(
      "vpn-login 不是開著的「要你動手」項目，沒有關任何東西（已經關過的話不用再跑）。",
    );
  });

  it("takes an item no longer needed down at once, unless only the captain may close it", () => {
    const down = ok(todos.obsoleteItem(added(), "vpn-login", "改用別的做法", NOW, "plain"));
    expect(down.store.items).toEqual({});
    expect(down.events).toEqual([
      rec("todo.taken_down", "要你動手「登入 VPN」已撤下：不再需要，改用別的做法（plain 用指令）", {
        outcome: "taken_down",
        reason: "改用別的做法",
      }),
    ]);
    expect(down.notices).toMatchObject([{ event: "todo.closed", by: "aggregator", words: "撤下" }]);
    const held = ok(
      todos.obsoleteItem(added({ captainCloses: true }), "vpn-login", "改用別的做法", NOW, "plain"),
    );
    expect(held.line).toBe("ok vpn-login 已標成不再需要，等使用者撤下");
    expect(held.store.items["vpn-login"]).toMatchObject({
      state: "obsolete",
      reason: "改用別的做法",
    });
    expect(held.events).toEqual([
      rec(
        "todo.obsolete",
        "要你動手「登入 VPN」：plain 標成不再需要：改用別的做法（plain 用指令）",
        {
          reason: "改用別的做法",
        },
      ),
    ]);
    expect(held.notices).toEqual([]);
  });

  it("closes on the captain's 不做了 and 好，撤下, with the captain's words", () => {
    const dropped = ok(todos.closeByCaptain(added(), "vpn-login", "不做了", "plain"));
    expect(dropped.events).toEqual([
      rec("todo.dropped", "要你動手「登入 VPN」已關：你選了不做了（你在頁面上）", {
        by: "captain",
        outcome: "dropped",
      }),
    ]);
    expect(dropped.notices).toMatchObject([
      {
        event: "todo.closed",
        by: "captain",
        words: "不做了",
        text: "使用者在看板上：「登入 VPN」不做了（vpn-login）",
      },
    ]);
    expect(refusal(todos.closeByCaptain(added(), "vpn-login", "撤下", "plain"))).toBe(
      "vpn-login 沒有被標成不再需要，不能撤下。",
    );
    const held = ok(
      todos.obsoleteItem(
        added({ captainCloses: true, ref: "hold" }),
        "vpn-login",
        "不用了",
        NOW,
        "plain",
      ),
    ).store;
    expect(refusal(todos.closeByCaptain(held, "vpn-login", "不做了", "plain"))).toBe(
      "vpn-login 現在不能按不做了。",
    );
    const takenDown = ok(todos.closeByCaptain(held, "vpn-login", "撤下", "plain"));
    expect(takenDown.events).toEqual([
      rec("todo.taken_down", "要你動手「登入 VPN」已撤下（你在頁面上）", {
        by: "captain",
        outcome: "taken_down",
      }),
    ]);
    expect(takenDown.notices).toMatchObject([{ by: "captain", words: "撤下", ref: "hold" }]);
    const claimed = ok(todos.claimItem(added(), "vpn-login", NOW, "p")).store;
    expect(todos.closeByCaptain(claimed, "vpn-login", "不做了", "plain").ok).toBe(false);
  });
});

describe("what topics.json keeps publishing", () => {
  it("is the mark of every item that is not open, plus every waiting mark", () => {
    let store: TodoStore = {
      ...todos.emptyTodos(),
      marks: { waiting: { state: "claimed", at: "T" } },
    };
    store = added({ id: "open" }, store);
    store = added({ id: "rejected" }, store);
    store = ok(todos.rejectItem(store, "rejected", "沒起來", LATER, "plain")).store;
    expect(todos.projectMarks(store)).toEqual({
      waiting: { state: "claimed", at: "T" },
      rejected: { state: "rejected", at: LATER, reason: "沒起來" },
    });
  });
});

describe("the file", () => {
  let dir = "";
  afterEach(() => {
    if (dir !== "") fs.rmSync(dir, { recursive: true, force: true });
  });

  function target(): { target: CommitTarget; saved: StoredRecord[] } {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-todos-"));
    const paths = boardPaths({
      state: path.join(dir, "state"),
      data: path.join(dir, "data"),
      config: path.join(dir, "config"),
    });
    const saved: StoredRecord[] = [];
    let n = 0;
    const sink = {
      has: (rid: string) => saved.some((record) => record.rid === rid),
      append: (record: StoredRecord) => void saved.push(record),
    };
    return { target: { paths, sink, nextRid: () => `r-${(n += 1)}`, nowSeconds: () => 1 }, saved };
  }

  it("is created at the first start with topics.json's marks, with a record, and read back", () => {
    const { target: at, saved } = target();
    const { paths } = at;
    expect(loadBoard(at, "plain").board.todos).toEqual(todos.emptyTodos());
    expect(fs.existsSync(paths.todos)).toBe(false);
    expect(saved).toEqual([]);
    const doc = {
      ...emptyState().doc,
      todos: { old: { state: "rejected", at: "T", reason: "沒起來" } },
    };
    fs.mkdirSync(paths.dataDir, { recursive: true });
    fs.writeFileSync(paths.topics, JSON.stringify(doc));
    const first = loadBoard(at, "plain").board;
    expect(first.todos).toEqual({ v: 1, items: {}, marks: doc.todos });
    expect(fs.statSync(paths.todos).mode & 0o777).toBe(0o644);
    expect(saved).toMatchObject([
      { kind: "todo.marks_carried", by: "board", label: "plain", topic: null },
    ]);
    expect(saved[0]?.text).toBe(
      "看板開始自己存「要你動手」：從 topics.json 帶過來 1 個舊狀態（old）",
    );
    const result = todos.addItem(first.todos, board(), input({ ref: "hold" }), NOW, AGENT);
    if (!result.ok || !result.changed) throw new Error("expected a change");
    const store = result.store;
    const change = { file: "todos" as const, next: store, records: result.records };
    expect(commitChange(at, first, change, { by: "aggregator", label: "plain" }).ok).toBe(true);
    expect(readBoard(paths).board.todos).toEqual(store);
    expect(loadBoard(at, "plain").board.todos).toEqual(store);
    expect(saved).toHaveLength(2);
  });

  it("reads items an older board adopted, and closes them like any other", () => {
    const { paths } = target().target;
    fs.mkdirSync(paths.boardDataDir, { recursive: true });
    const old = {
      title: "登入 VPN",
      topic: null,
      action: "用公司帳號登入 VPN",
      guidance: "",
      commands: [],
      state: "open",
      reason: null,
      at: NOW,
      by: "plain",
      ref: "hold",
      captain_closes: true,
      adopted: true,
      created_at: "2026-11-17T10:00:00Z",
    };
    const saved = {
      v: 1,
      items: { "vpn-login": old, "was-claimed": { ...old, state: "claimed" } },
      marks: { waiting: { state: "claimed", at: "T" } },
      closed: { "gone-item": NOW },
    };
    fs.writeFileSync(paths.todos, JSON.stringify(saved));
    const store = readBoard(paths).board.todos;
    const { adopted: _adopted, ...kept } = old;
    void _adopted;
    expect(store).toEqual({
      v: 1,
      items: { "vpn-login": kept, "was-claimed": { ...kept, state: "claimed" } },
      marks: { waiting: { state: "claimed", at: "T" } },
    });
    const dropped = ok(todos.closeByCaptain(store, "vpn-login", "不做了", "plain"));
    expect(dropped.events).toEqual([
      rec("todo.dropped", "要你動手「登入 VPN」已關：你選了不做了（你在頁面上）", {
        topic: null,
        outcome: "dropped",
      }),
    ]);
    expect(dropped.notices).toMatchObject([
      { event: "todo.closed", id: "vpn-login", ref: "hold", topic: null, by: "captain" },
    ]);
    expect(dropped.store).toEqual({
      v: 1,
      items: { "was-claimed": { ...kept, state: "claimed" } },
      marks: { waiting: { state: "claimed", at: "T" } },
    });
    expect(ok(todos.doneItem(dropped.store, "was-claimed", "plain")).events).toEqual([
      rec("todo.done", "要你動手「登入 VPN」已關：做完了，plain 已驗證（plain 用指令）", {
        item: "was-claimed",
        topic: null,
        outcome: "done",
      }),
    ]);
  });

  it("skips an item it cannot read and refuses a file that is not v1", () => {
    const { paths } = target().target;
    fs.mkdirSync(paths.boardDataDir, { recursive: true });
    const good = added().items["vpn-login"];
    fs.writeFileSync(
      paths.todos,
      JSON.stringify({ v: 1, items: { ok: good, bad: { title: 1 }, "bad id": good }, marks: {} }),
    );
    expect(Object.keys(readBoard(paths).board.todos.items)).toEqual(["ok"]);
    fs.writeFileSync(paths.todos, JSON.stringify({ v: 2 }));
    expect(() => readBoard(paths)).toThrow("讀不懂");
  });
});
