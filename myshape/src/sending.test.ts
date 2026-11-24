// The write engine, the four captain actions, and the browser API routes,
// driven together against a scripted deliverer.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as actions from "./actions.js";
import type { ActionContext, ActionResult } from "./actions.js";
import { createApi } from "./api.js";
import type { ProgramToConfirm } from "./api.js";
import type { Role } from "./binding.js";
import type { AllowedCommand, CommandResult } from "./commands.js";
import { ConfirmStore } from "./confirm.js";
import type { ApiHandler } from "./http.js";
import type { BoardResponse } from "./protocol.js";
import type { HomeReport, ReportHold } from "./report.js";
import { emptyState } from "./topics.js";
import type { TopicState } from "./topics.js";
import type { HomeSnapshot } from "./view.js";
import {
  ON_DELIVERED,
  ON_HANDLED_ELSEWHERE,
  WriteEngine,
  deliveryRecord,
  isDedupable,
  parseOutcome,
} from "./writes.js";
import type { Action, WriteRecord, WriteTimings } from "./writes.js";

const exit = (code: number | null, stdout = "", stderr = ""): CommandResult => ({
  code,
  stdout,
  stderr,
});
const outcome = (name: string, error?: string): CommandResult =>
  exit(
    0,
    `${JSON.stringify(error === undefined ? { outcome: name } : { outcome: name, error })}\n`,
  );
const DELIVERED = outcome("delivered");

interface Harness {
  engine: WriteEngine;
  context: ActionContext;
  /** Every action record the deliverer received, parsed. */
  calls: Record<string, unknown>[];
  /** Results for the next deliverer runs, in order; anything unscripted is delivered. */
  next: (...results: CommandResult[]) => void;
  tags: Map<string, string | null>;
  /** Every write that ended delivered or handled elsewhere, in the order it did. */
  finished: WriteRecord[];
  changes: () => number;
  audit: () => Record<string, unknown>[];
  /** The ids of every release the engine recorded, in order. */
  released: string[][];
  /** Sets why the deliverer may not run from now on, or null when it may. */
  block: (reason: string | null) => void;
  /** Makes saving the record of a release fail from now on. */
  failReleaseRecord: () => void;
  restart: (timings?: Partial<WriteTimings>, blocked?: string | null) => Harness;
}

let dir: string;
let open: WriteEngine[];

function topics(): TopicState {
  const state = emptyState();
  const topic = (name: string) => ({
    name,
    goal: "g",
    status: "confirmed" as const,
    created_at: "",
  });
  state.doc.topics = {
    billing: topic("Billing"),
    login: topic("Login"),
  };
  state.doc.queues = { high: [], normal: ["billing", "login"], later: [] };
  state.doc.merged = { old: "billing" };
  state.archive.topics = { gone: { ...topic("Gone"), archived_at: "T" } };
  return state;
}

function report(extra: Partial<HomeReport>): HomeReport {
  return {
    code_commit: "c",
    ledger_enabled: true,
    tasks: [],
    queued: [],
    holds: [],
    status_decisions: [],
    topics: {},
    ledger: { status: "absent", to_offset: 0, to_prefix_sha256: "-", more: false, lines: [] },
    ledger_hint: null,
    aggregator: null,
    secondmates: [],
    closed_holds: [],
    closed_cursor: null,
    ...extra,
  };
}

const hold = (id: string, origin = "", extra: Partial<ReportHold> = {}): ReportHold => ({
  id,
  title: "T",
  question: `q of ${id}`,
  hold_bucket: "live" as const,
  hold_until: null,
  unresolved_blocker_ids: [],
  hold_age_days: 1,
  origin,
  on_answer: "release",
  hold_set: null,
  ...extra,
});

function homes(): HomeSnapshot[] {
  const snapshot = (id: string, extra: Partial<HomeReport>): HomeSnapshot => ({
    id,
    report: report(extra),
    lastOkAt: 1,
    error: null,
    version: "same",
  });
  return [
    snapshot("main", {
      holds: [
        hold("call-1", "ship-a"),
        hold("call-origin", "ship-a"),
        hold("call-loose"),
        hold("call-old", "", { on_answer: null }),
        hold("todo-old", "", { question: "動手：登入", on_answer: null }),
        hold("todo-kept", "", { question: "動手：登入" }),
      ],
      topics: { "ship-a": "billing T", "call-1": "login T", tagged: "login T1\nbilling T2" },
    }),
    snapshot("w2", {
      holds: [
        hold("call-w2", "", { on_answer: "close" }),
        hold("todo-w2", "", { question: "動手：登入", on_answer: null }),
      ],
      topics: { "w2-work": "billing T" },
    }),
    { id: "down", report: null, lastOkAt: null, error: "unreachable", version: "unknown" },
  ];
}

function harness(
  timings: Partial<WriteTimings> = {},
  initiallyBlocked: string | null = null,
  auditFile = path.join(dir, "audit.jsonl"),
): Harness {
  let blocked = initiallyBlocked;
  let releaseSaves = true;
  const released: string[][] = [];
  const queue: CommandResult[] = [];
  const calls: Record<string, unknown>[] = [];
  const tags = new Map<string, string | null>();
  const finished: WriteRecord[] = [];
  let changes = 0;
  const engine = new WriteEngine(
    auditFile,
    {
      run: async (command: AllowedCommand) => {
        if (command.kind !== "deliver") throw new Error("the engine only delivers");
        calls.push(JSON.parse(command.record) as Record<string, unknown>);
        return queue.shift() ?? DELIVERED;
      },
      blocked: () => blocked,
      onRelease: (ids) => {
        if (releaseSaves) released.push(ids);
        return releaseSaves;
      },
      readTags: async (home, task) =>
        tags.has(`${home}/${task}`) ? (tags.get(`${home}/${task}`) as string | null) : "",
      onChange: () => {
        changes += 1;
      },
      onFinished: (record) => finished.push(record),
    },
    { retryDelaysMs: [5, 5], resumeWindowMs: 60_000, commandTimeoutMs: 1000, ...timings },
  );
  open.push(engine);
  return {
    engine,
    context: { topics: topics(), homes: homes(), writes: engine },
    calls,
    next: (...results) => queue.push(...results),
    tags,
    finished,
    changes: () => changes,
    audit: () =>
      fs
        .readFileSync(auditFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    released,
    block: (reason) => {
      blocked = reason;
    },
    failReleaseRecord: () => {
      releaseSaves = false;
    },
    restart: (next = {}, nextBlocked = blocked) => {
      engine.stop();
      const restarted = harness({ ...timings, ...next }, nextBlocked, auditFile);
      restarted.engine.resumeUnfinished();
      return restarted;
    },
  };
}

function sent(result: ActionResult): WriteRecord {
  if (!result.ok) throw new Error(`refused: ${result.line}`);
  return result.write;
}

function refused(result: ActionResult): string {
  if (result.ok) throw new Error("the action was accepted");
  return result.line;
}

async function settled(record: WriteRecord, state: WriteRecord["state"]): Promise<void> {
  await vi.waitFor(() => expect(record.state).toBe(state), { timeout: 2000, interval: 2 });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-sending-"));
  open = [];
});
afterEach(() => {
  for (const engine of open) engine.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the outcome line", () => {
  it("is the last line of stdout naming one of the four outcomes", () => {
    expect(parseOutcome(exit(0, 'log\n{"outcome":"delivered"}\n\n'))).toEqual({
      kind: "delivered",
    });
    expect(parseOutcome(outcome("handled_elsewhere"))).toEqual({ kind: "handled_elsewhere" });
    expect(parseOutcome(outcome("retry", "busy"))).toEqual({ kind: "retry", error: "busy" });
    expect(parseOutcome(exit(1, '{"outcome":"failed","error":"no"}'))).toEqual({
      kind: "failed",
      error: "no",
    });
  });

  it("is a failure with stderr when it is missing, unknown, or the run was killed", () => {
    expect(parseOutcome(exit(0, "", ""))).toEqual({ kind: "failed", error: "exit 0" });
    expect(parseOutcome(exit(3, "", "boom"))).toEqual({ kind: "failed", error: "boom" });
    expect(parseOutcome(exit(0, '{"outcome":"maybe"}'))).toMatchObject({ kind: "failed" });
    expect(parseOutcome(exit(null, "", "killed"))).toEqual({ kind: "failed", error: "killed" });
    expect(parseOutcome(exit(0, '{"outcome":"retry"}', "slow"))).toEqual({
      kind: "retry",
      error: "slow",
    });
    expect(parseOutcome(exit(2, "", "x".repeat(700)))).toMatchObject({ error: "x".repeat(600) });
  });
});

describe("message", () => {
  it("hands over one record naming the topic, and records it", async () => {
    const h = harness();
    const write = sent(actions.message(h.context, "old", "  請先做帳務  ", "browser"));
    expect(write).toMatchObject({
      channel: "browser",
      home: "main",
      task: null,
      topic: "billing",
      text: "請先做帳務",
      state: "sending",
      attempt: 0,
    });
    expect(write.id).toMatch(/^w-[0-9a-z]+-[0-9a-f]{6}$/);
    await settled(write, "delivered");
    expect(h.calls).toEqual([
      {
        v: 1,
        id: write.id,
        attempt: 0,
        kind: "message",
        topic: { id: "billing", name: "Billing" },
        text: "請先做帳務",
      },
    ]);
    expect(h.audit().map((line) => line["state"])).toEqual(["sending", "delivered"]);
    expect(h.audit()[0]).toMatchObject({
      write_id: write.id,
      attempt: 0,
      sending: { text: "請先做帳務", action: { kind: "message" } },
    });
    expect(fs.statSync(path.join(dir, "audit.jsonl")).mode & 0o777).toBe(0o600);
    expect(h.finished).toEqual([write]);
    expect(h.changes()).toBe(1);
  });

  it("accepts an archived topic and refuses an unknown one or empty or oversized text", () => {
    const h = harness();
    expect(sent(actions.message(h.context, "gone", "x", "socket")).topic).toBe("gone");
    expect(refused(actions.message(h.context, "nope", "x", "socket"))).toBe("沒有 nope 這個議題。");
    expect(refused(actions.message(h.context, "billing", "  ", "socket"))).toContain(
      "訊息要有內容",
    );
    expect(refused(actions.message(h.context, "billing", "x".repeat(4001), "socket"))).toContain(
      "4000",
    );
    expect(actions.message(h.context, "billing", "x".repeat(4000), "socket").ok).toBe(true);
  });

  it("retries the same id when the deliverer says so, then gives up as undelivered", async () => {
    const h = harness();
    h.next(outcome("retry", "saved, not woken"), outcome("retry"), DELIVERED);
    const woken = sent(actions.message(h.context, "billing", "a", "browser"));
    await settled(woken, "delivered");
    expect(h.calls.map((call) => call["id"])).toEqual([woken.id, woken.id, woken.id]);
    expect(h.calls.map((call) => call["attempt"])).toEqual([0, 1, 2]);
    expect(h.audit().map((line) => `${String(line["state"])}:${String(line["attempt"])}`)).toEqual([
      "sending:0",
      "retrying:1",
      "retrying:2",
      "delivered:2",
    ]);
    expect(h.audit()[1]).toMatchObject({ error: "saved, not woken", next_at: expect.any(String) });

    h.next(outcome("retry"), outcome("retry"), outcome("retry", "still asleep"));
    const stuck = sent(actions.message(h.context, "billing", "b", "browser"));
    await settled(stuck, "undelivered");
    expect(stuck.error).toBe("still asleep");
    expect(h.calls).toHaveLength(6);
    expect(h.finished).toEqual([woken]);
  });

  it("settles at once as failed or handled elsewhere when the deliverer says so", async () => {
    const h = harness();
    h.next(outcome("failed", "no inbox"), exit(1, "", "crashed"), outcome("handled_elsewhere"));
    const first = sent(actions.message(h.context, "billing", "a", "browser"));
    const second = sent(actions.message(h.context, "billing", "b", "browser"));
    const third = sent(actions.message(h.context, "billing", "c", "browser"));
    await settled(third, "handled_elsewhere");
    expect(first).toMatchObject({ state: "failed", error: "no inbox", attempt: 0 });
    expect(second).toMatchObject({ state: "failed", error: "crashed" });
    expect(h.calls).toHaveLength(3);
    expect(h.finished).toEqual([third]);
  });
});

describe("direct", () => {
  it("names the home, the task, and the text, byte for byte", async () => {
    const h = harness();
    const main = sent(actions.direct(h.context, "main", "ship-a", "看一下 CI", "browser"));
    const other = sent(actions.direct(h.context, "w2", "w2-work", 'a; $(id) "q"\n二', "browser"));
    await settled(other, "delivered");
    await settled(main, "delivered");
    expect(h.calls.map(({ kind, home, task, text }) => ({ kind, home, task, text }))).toEqual([
      { kind: "direct", home: "main", task: "ship-a", text: "看一下 CI" },
      { kind: "direct", home: "w2", task: "w2-work", text: 'a; $(id) "q"\n二' },
    ]);
    expect(other.topic).toBe("billing");
  });

  it("refuses unknown homes, bad task ids, and command-like or oversized text", () => {
    const h = harness();
    expect(refused(actions.direct(h.context, "nobody", "t", "x", "browser"))).toBe(
      "不認得 home nobody。",
    );
    expect(refused(actions.direct(h.context, "main", "-t", "x", "browser"))).toBe(
      "task id 格式不對：-t",
    );
    for (const text of ["/compact", "$x", "!ls", " -x"]) {
      expect(refused(actions.direct(h.context, "w2", "t", text, "browser"))).toContain(
        "會被當成指令",
      );
    }
    expect(refused(actions.direct(h.context, "main", "t", "", "browser"))).toBe("訊息不能是空的。");
    expect(refused(actions.direct(h.context, "main", "t", "x".repeat(4001), "browser"))).toBe(
      "訊息最多 4000 個字。",
    );
    expect(h.calls).toEqual([]);
  });
});

describe("answer", () => {
  const input = (extra: Partial<actions.AnswerInput> = {}): actions.AnswerInput => ({
    home: "main",
    task: "call-1",
    answer: "合併",
    label: "A",
    ...extra,
  });

  it("hands over the answer with the mode the hold recorded and the question's digest", async () => {
    const h = harness();
    const write = sent(actions.answer(h.context, input(), "browser"));
    await settled(write, "delivered");
    expect(h.calls).toEqual([
      {
        v: 1,
        id: write.id,
        attempt: 0,
        kind: "answer",
        home: "main",
        task: "call-1",
        answer: "合併",
        label: "A",
        mode: "release",
        question_sha256: crypto.createHash("sha256").update("q of call-1").digest("hex"),
        topic: { id: "login", name: "Login" },
      },
    ]);
    expect(h.finished).toEqual([write]);
  });

  it("names the topic by the task, its origin, or none, and the home the hold lives in", async () => {
    const h = harness();
    const viaOrigin = sent(actions.answer(h.context, input({ task: "call-origin" }), "browser"));
    const loose = sent(actions.answer(h.context, input({ task: "call-loose" }), "browser"));
    const other = sent(actions.answer(h.context, input({ home: "w2", task: "call-w2" }), "socket"));
    await settled(other, "delivered");
    expect(viaOrigin.topic).toBe("billing");
    expect(
      Object.fromEntries(
        h.calls.map((call) => [String(call["task"]), [call["home"], call["topic"]]]),
      ),
    ).toEqual({
      "call-origin": ["main", { id: "billing", name: "Billing" }],
      "call-loose": ["main", null],
      "call-w2": ["w2", null],
    });
    expect(loose.topic).toBeNull();
  });

  it("closes or releases as the hold recorded; unrecorded, every hold releases", async () => {
    const h = harness();
    const modeOf = async (home: string, task: string): Promise<unknown> => {
      const write = sent(actions.answer(h.context, input({ home, task }), "browser"));
      await settled(write, "delivered");
      return h.calls[h.calls.length - 1]?.["mode"];
    };
    expect(await modeOf("main", "call-1")).toBe("release");
    expect(await modeOf("w2", "call-w2")).toBe("done");
    expect(await modeOf("main", "call-old")).toBe("release");
    expect(await modeOf("main", "todo-old")).toBe("release");
    expect(await modeOf("main", "todo-kept")).toBe("release");
    expect(await modeOf("w2", "todo-w2")).toBe("release");
  });

  it("refuses a missing hold, an unknown home, and answers that are not one clean line", () => {
    const h = harness();
    expect(refused(actions.answer(h.context, input({ task: "nope" }), "browser"))).toContain(
      "沒有等你回答",
    );
    expect(refused(actions.answer(h.context, input({ home: "down" }), "browser"))).toContain(
      "沒有等你回答",
    );
    expect(refused(actions.answer(h.context, input({ home: "nobody" }), "browser"))).toBe(
      "不認得 home nobody。",
    );
    expect(refused(actions.answer(h.context, input({ task: "bad id" }), "browser"))).toContain(
      "task id",
    );
    for (const answer of ["", "a\tb", "a\nb", "x".repeat(1001)]) {
      expect(refused(actions.answer(h.context, input({ answer }), "browser"))).toContain("答案");
    }
    expect(refused(actions.answer(h.context, input({ label: "a\tb" }), "browser"))).toContain(
      "選項",
    );
    expect(h.calls).toEqual([]);
  });
});

describe("tagAgent", () => {
  it("files a task in the home it lives in, with the tag line it saw", async () => {
    const h = harness();
    const main = sent(actions.tagAgent(h.context, "main", "tagged", "old", "browser"));
    const other = sent(actions.tagAgent(h.context, "w2", "w2-work", "login", "browser"));
    const fresh = sent(actions.tagAgent(h.context, "main", "fresh", "login", "browser"));
    await settled(fresh, "delivered");
    expect(main).toMatchObject({ topic: "billing", text: "歸到「Billing」" });
    expect(other.home).toBe("w2");
    expect(
      h.calls.map(({ kind, home, task, topic, last_tag_line }) => ({
        kind,
        home,
        task,
        topic,
        last_tag_line,
      })),
    ).toEqual([
      { kind: "tag", home: "main", task: "tagged", topic: "billing", last_tag_line: "billing T2" },
      { kind: "tag", home: "w2", task: "w2-work", topic: "login", last_tag_line: "billing T" },
      { kind: "tag", home: "main", task: "fresh", topic: "login", last_tag_line: "" },
    ]);
  });

  it("refuses archived or unknown topics, unknown homes, and bad task ids", () => {
    const h = harness();
    expect(refused(actions.tagAgent(h.context, "main", "t", "gone", "browser"))).toContain(
      "不是看板上還開著的議題",
    );
    expect(refused(actions.tagAgent(h.context, "main", "t", "nope", "browser"))).toContain(
      "不是看板上還開著的議題",
    );
    expect(refused(actions.tagAgent(h.context, "nobody", "t", "login", "browser"))).toBe(
      "不認得 home nobody。",
    );
    expect(refused(actions.tagAgent(h.context, "main", "-t", "login", "browser"))).toContain(
      "task id",
    );
  });

  it("reads the home afresh before every retry and settles from what it finds", async () => {
    const h = harness({ retryDelaysMs: [5, 5, 5] });
    h.next(outcome("retry", "busy"));
    h.tags.set("main/landed", "login T1\nbilling T3");
    const landed = sent(actions.tagAgent(h.context, "main", "landed", "billing", "browser"));
    await settled(landed, "delivered");
    expect(h.calls).toHaveLength(1);

    h.next(outcome("retry", "busy"));
    h.tags.set("main/moved", "other T9");
    const moved = sent(actions.tagAgent(h.context, "main", "moved", "billing", "browser"));
    await settled(moved, "handled_elsewhere");
    expect(h.calls).toHaveLength(2);

    h.next(outcome("retry", "busy"));
    h.tags.set("main/unread", null);
    const unread = sent(actions.tagAgent(h.context, "main", "unread", "billing", "browser"));
    await settled(unread, "undelivered");
    expect(unread.error).toBe("對帳時讀不到那個 home。");

    h.next(outcome("retry", "busy"));
    const again = sent(actions.tagAgent(h.context, "main", "again", "billing", "browser"));
    await settled(again, "delivered");
    expect(h.calls.slice(-2).map((call) => call["task"])).toEqual(["again", "again"]);
  });
});

// Guard 3.3: a page write that changes another home leaves its record when it
// ends; communication leaves none.
describe("the record a finished write leaves", () => {
  const answer = { home: "main", task: "call-1", answer: "合併", label: "A" };
  const writes: Record<Action["kind"], (h: Harness) => WriteRecord> = {
    answer: (h) => sent(actions.answer(h.context, answer, "browser")),
    tag: (h) => sent(actions.tagAgent(h.context, "main", "fresh", "login", "browser")),
    message: (h) => sent(actions.message(h.context, "billing", "hi", "browser")),
    direct: (h) => sent(actions.direct(h.context, "main", "worker-1", "hi", "browser")),
    notice: (h) =>
      h.engine.submit({
        channel: "auto",
        home: "main",
        task: null,
        topic: null,
        text: "n",
        action: { kind: "notice", event: "topic.kept", text: "n" },
      }),
  };

  for (const kind of Object.keys(writes) as Action["kind"][]) {
    it(`${kind}: delivered leaves ${ON_DELIVERED[kind] ?? "none"}, handled elsewhere ${ON_HANDLED_ELSEWHERE[kind] ?? "none"}`, async () => {
      for (const [ending, kinds] of [
        ["delivered", ON_DELIVERED],
        ["handled_elsewhere", ON_HANDLED_ELSEWHERE],
      ] as const) {
        const h = harness();
        h.next(outcome(ending));
        const write = writes[kind](h);
        await settled(write, ending);
        expect(h.finished).toEqual([write]);
        expect(deliveryRecord(write)?.kind ?? null).toBe(kinds[kind]);
      }
    });
  }

  it("says what the answer did, or that its decision had already ended", async () => {
    const h = harness();
    h.next(DELIVERED, outcome("handled_elsewhere"));
    const delivered = sent(actions.answer(h.context, answer, "browser"));
    await settled(delivered, "delivered");
    expect(deliveryRecord(delivered)).toEqual({
      kind: "hold.answered",
      topic: delivered.topic,
      home: "main",
      task: "call-1",
      outcome: "A",
      text: "在看板回答 main/call-1：合併",
    });
    const elsewhere = sent(actions.answer(h.context, answer, "browser"));
    await settled(elsewhere, "handled_elsewhere");
    expect(deliveryRecord(elsewhere)).toMatchObject({
      kind: "hold.closed",
      outcome: "elsewhere",
      text: "待決事項 main/call-1 已在別處結束，看板上的回答「合併」沒有送出",
    });
    for (const state of ["failed", "undelivered", "sending"] as const)
      expect(deliveryRecord({ ...delivered, state })).toBeNull();
  });
});

describe("resend and ignore", () => {
  it("resends a failed write under the same id and ignores on request", async () => {
    const h = harness();
    h.next(outcome("failed", "no"));
    const write = sent(actions.message(h.context, "billing", "a", "browser"));
    await settled(write, "failed");
    expect(h.engine.resend("nope", false)).toBe("沒有這筆寫入。");
    expect(h.engine.resend(write.id, false)).toBeNull();
    await settled(write, "delivered");
    expect(h.calls.map((call) => call["id"])).toEqual([write.id, write.id]);
    expect(h.engine.resend(write.id, false)).toBe("這筆寫入不需要重送。");
    expect(h.engine.ignore(write.id)).toBe("這筆寫入不需要忽略。");

    h.next(outcome("failed", "no"));
    const other = sent(actions.message(h.context, "billing", "b", "browser"));
    await settled(other, "failed");
    expect(h.engine.ignore(other.id)).toBeNull();
    expect(other.state).toBe("ignored");
  });

  it("needs confirmation to resend an unknown write", async () => {
    const h = harness();
    const write = sent(actions.direct(h.context, "main", "t", "x", "browser"));
    await settled(write, "delivered");
    write.state = "unknown";
    expect(h.engine.resend(write.id, false)).toContain("需要先確認");
    expect(h.engine.resend(write.id, true)).toBeNull();
    await settled(write, "delivered");
  });
});

describe("restart", () => {
  it("knows that every kind but direct is safe to repeat", () => {
    const kinds: Action[] = [
      { kind: "message", topic: { id: "a", name: "A" }, text: "x" },
      { kind: "notice", event: "topic.kept", text: "x" },
      { kind: "tag", home: "main", task: "t", topic: "a", last_tag_line: "" },
      {
        kind: "answer",
        home: "w2",
        task: "t",
        answer: "a",
        label: "a",
        mode: "done",
        question_sha256: "-",
        topic: null,
      },
    ];
    for (const action of kinds) expect(isDedupable(action)).toBe(true);
    expect(isDedupable({ kind: "direct", home: "w2", task: "t", text: "x" })).toBe(false);
  });

  it("continues a safe write with its id, and flags an unfinished direct message", async () => {
    const h = harness({ retryDelaysMs: [60_000] });
    h.next(outcome("retry"), outcome("retry"));
    const note = sent(actions.message(h.context, "billing", "a", "browser"));
    const direct = sent(actions.direct(h.context, "w2", "w2-work", "b", "browser"));
    await settled(note, "retrying");
    await settled(direct, "retrying");
    const after = h.restart({ retryDelaysMs: [5] });
    await settled(after.engine.records.get(note.id) as WriteRecord, "delivered");
    expect(after.calls.map((call) => call["id"])).toEqual([note.id]);
    expect(after.engine.records.get(direct.id)).toMatchObject({
      state: "unknown",
      error: "看板在送出途中重啟，不知道有沒有送到。",
    });
  });

  it("does not resume a write older than the resume window", async () => {
    const h = harness({ retryDelaysMs: [60_000] });
    h.next(outcome("retry"));
    const note = sent(actions.message(h.context, "billing", "a", "browser"));
    await settled(note, "retrying");
    const after = h.restart({ resumeWindowMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(after.engine.records.get(note.id)?.state).toBe("undelivered");
    expect(after.calls).toEqual([]);
  });

  it("ignores audit lines that are not about a write", () => {
    const file = path.join(dir, "audit.jsonl");
    fs.writeFileSync(file, '{"rejected":"host"}\nnot json\n{"write_id":"w-x"}\n');
    expect(harness().engine.records.size).toBe(0);
  });
});

describe("no deliverer", () => {
  it("leaves every write waiting at attempt 0, with nothing run and nothing failed", async () => {
    const h = harness({}, "沒有 bin/fm-board.sh");
    const message = sent(actions.message(h.context, "billing", "a", "browser"));
    expect(h.changes()).toBe(1);
    const direct = sent(actions.direct(h.context, "main", "ship-a", "b", "browser"));
    expect(h.changes()).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([message.state, direct.state]).toEqual(["waiting", "waiting"]);
    expect([message.attempt, direct.attempt]).toEqual([0, 0]);
    expect(h.calls).toEqual([]);
    expect(h.engine.resend(message.id, false)).toBe("這筆寫入不需要重送。");
  });

  it("keeps waiting across restarts and hands every write over once, in record order, when it can", async () => {
    const h = harness({ resumeWindowMs: 1 }, "沒有 bin/fm-board.sh");
    const ids = [
      sent(actions.message(h.context, "billing", "one", "browser")).id,
      sent(actions.direct(h.context, "w2", "w2-work", "two", "browser")).id,
      sent(actions.message(h.context, "login", "three", "browser")).id,
    ];
    await new Promise((resolve) => setTimeout(resolve, 10));
    const still = h.restart();
    expect(ids.map((id) => still.engine.records.get(id)?.state)).toEqual([
      "waiting",
      "waiting",
      "waiting",
    ]);
    const connected = still.restart({}, null);
    const later = sent(actions.message(connected.context, "billing", "four", "browser"));
    await settled(later, "delivered");
    for (const id of ids)
      await settled(connected.engine.records.get(id) as WriteRecord, "delivered");
    expect(connected.calls.map((call) => call["id"])).toEqual([...ids, later.id]);
    expect(connected.calls.map((call) => call["attempt"])).toEqual([0, 0, 0, 0]);
    const again = connected.restart();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(again.calls).toEqual([]);
  });

  it("turns a safe write that was under way into a waiting one, and an unsafe one into unknown", async () => {
    const h = harness({ retryDelaysMs: [60_000] });
    h.next(outcome("retry"), outcome("retry"));
    const note = sent(actions.message(h.context, "billing", "a", "browser"));
    const direct = sent(actions.direct(h.context, "main", "t", "b", "browser"));
    await settled(direct, "retrying");
    const after = h.restart({}, "沒有 bin/fm-board.sh");
    expect(after.engine.records.get(note.id)?.state).toBe("waiting");
    expect(after.engine.records.get(direct.id)?.state).toBe("unknown");
  });

  it("records each release before it, oldest first, and keeps waiting when the record fails", async () => {
    const h = harness({}, "要先在頁面上確認");
    const one = sent(actions.message(h.context, "billing", "one", "browser"));
    const two = sent(actions.message(h.context, "login", "two", "browser"));
    h.failReleaseRecord();
    h.block(null);
    expect(h.engine.releaseWaiting()).toBe(0);
    expect([one.state, two.state]).toEqual(["waiting", "waiting"]);
    expect(h.calls).toEqual([]);
    const after = h.restart({}, null);
    await settled(after.engine.records.get(two.id) as WriteRecord, "delivered");
    expect(after.released).toEqual([[one.id, two.id]]);
    expect(after.calls.map((call) => call["id"])).toEqual([one.id, two.id]);
  });

  it("hands the waiting writes over at a confirmation, without a restart", async () => {
    const h = harness({}, "要先在頁面上確認");
    const one = sent(actions.message(h.context, "billing", "one", "browser"));
    expect(h.engine.releaseWaiting()).toBe(0);
    h.block(null);
    expect(h.engine.releaseWaiting()).toBe(1);
    await settled(one, "delivered");
    expect(h.released).toEqual([[one.id]]);
    expect(h.engine.releaseWaiting()).toBe(0);
    expect(h.released).toHaveLength(1);
  });

  it("sends the waiting writes before a newer one when the deliverer may run again", async () => {
    const h = harness({}, "程式改過了");
    const old = sent(actions.message(h.context, "billing", "old", "browser"));
    h.block(null);
    const newer = sent(actions.message(h.context, "billing", "new", "browser"));
    await settled(newer, "delivered");
    await settled(old, "delivered");
    expect(h.calls.map((call) => call["id"])).toEqual([old.id, newer.id]);
    expect(h.released).toEqual([[old.id]]);
  });

  it("puts a write back to waiting when its program may not run at the moment of the run", async () => {
    const h = harness({ retryDelaysMs: [1] });
    h.next({ code: null, stdout: "", stderr: "", blocked: "要先在頁面上確認" });
    const note = sent(actions.message(h.context, "billing", "a", "browser"));
    await settled(note, "waiting");
    expect(note.attempt).toBe(0);
    expect(h.calls).toHaveLength(1);
  });

  it("still shows a connected deliverer's failures", async () => {
    const h = harness({ retryDelaysMs: [1, 1] });
    h.next(outcome("failed", "refused"), outcome("retry"), outcome("retry"), outcome("retry"));
    const failed = sent(actions.message(h.context, "billing", "a", "browser"));
    const tired = sent(actions.message(h.context, "billing", "b", "browser"));
    await settled(failed, "failed");
    await settled(tired, "undelivered");
  });
});

describe("audit lines from before action records", () => {
  const line = (plan: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      ts: "T",
      write_id: String(extra["id"] ?? "w-old"),
      state: "sending",
      attempt: 0,
      sending: {
        id: "w-old",
        channel: "browser",
        home: "main",
        task: null,
        topic: "billing",
        text: "請先做帳務",
        plan,
        state: "sending",
        attempt: 0,
        error: null,
        nextAt: null,
        createdAt: Date.now(),
        ...extra,
      },
    });

  it("loads without an error, resumes none, and shows none as unsettled", async () => {
    const file = path.join(dir, "audit.jsonl");
    fs.writeFileSync(
      file,
      `${[
        line({
          type: "note",
          requestId: "tb-0011223344556677",
          body: "［議題：Billing（billing）］\n請先做帳務",
        }),
        line({ type: "send", task: "t" }, { id: "w-send", task: "t" }),
        line(
          { type: "relay", secondmate: "far1", deliveryId: "0123456789abcdef" },
          { id: "w-relay" },
        ),
        line(
          { type: "answer", line: "c\t合併\tA\tdone", noteBody: "［議題：Billing］…" },
          { id: "w-answer" },
        ),
        JSON.stringify({ ts: "T", write_id: "w-answer", state: "delivered", attempt: 0 }),
        line({ type: "tag", task: "t", topic: "billing", lastLineAtSend: "" }, { id: "w-tag" }),
        JSON.stringify({ ts: "T", write_id: "w-tag", state: "failed", attempt: 0, error: "x" }),
      ].join("\n")}\n`,
    );
    const h = harness();
    h.engine.resumeUnfinished();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.engine.records.size).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.released).toEqual([]);
  });
});

describe("serialization", () => {
  it("runs one deliverer per home at a time without holding the queue during a retry wait", async () => {
    const h = harness();
    let running = 0;
    let peak = 0;
    const order: string[] = [];
    const engine = new WriteEngine(
      path.join(dir, "serial.jsonl"),
      {
        run: async (command) => {
          running += 1;
          peak = Math.max(peak, running);
          const record = JSON.parse(command.kind === "deliver" ? command.record : "{}") as {
            text: string;
          };
          order.push(record.text);
          await new Promise((resolve) => setTimeout(resolve, 15));
          running -= 1;
          return record.text === "retry me" &&
            order.filter((entry) => entry === "retry me").length === 1
            ? outcome("retry")
            : DELIVERED;
        },
        blocked: () => null,
        onRelease: () => true,
        readTags: async () => "",
        onChange: () => undefined,
        onFinished: () => undefined,
      },
      { retryDelaysMs: [80], resumeWindowMs: 1000, commandTimeoutMs: 1000 },
    );
    open.push(engine);
    const context = { ...h.context, writes: engine };
    const first = sent(actions.message(context, "billing", "retry me", "browser"));
    const second = sent(actions.message(context, "billing", "second", "browser"));
    const third = sent(actions.message(context, "billing", "third", "browser"));
    await settled(third, "delivered");
    expect(first.state).toBe("retrying");
    expect(second.state).toBe("delivered");
    await settled(first, "delivered");
    expect(peak).toBe(1);
    expect(order).toEqual(["retry me", "second", "third", "retry me"]);
  });
});

function api(
  h: Harness,
  overrides: {
    topicOp?: (op: string, args: Record<string, unknown>) => BoardResponse;
    programToConfirm?: (role: Role) => ProgramToConfirm | string;
  } = {},
) {
  const confirm = new ConfirmStore();
  const seen: string[] = [];
  let version = "1-0";
  const handler: ApiHandler = createApi({
    bootId: "boot",
    version: () => version,
    view: () => ({ boot_id: "boot", version, queues: {} }),
    touch: () => seen.push("touch"),
    refresh: async () => {
      seen.push("refresh");
    },
    topicOp:
      overrides.topicOp ??
      ((op, args) => {
        seen.push(`${op}:${JSON.stringify(args)}`);
        return { ok: true, line: `ok ${op}` };
      }),
    actionContext: () => h.context,
    writes: h.engine,
    confirm,
    programToConfirm: overrides.programToConfirm ?? (() => "這支程式不需要確認。"),
    programConfirmed: () => seen.push("confirmed"),
  });
  const call = (route: string, body: Record<string, unknown> = {}, query = "") =>
    handler(
      route.startsWith("GET ") ? "GET" : "POST",
      route.replace(/^(GET|POST) /, ""),
      new URLSearchParams(query),
      body,
    );
  return { call, seen, bump: () => (version = "2-0") };
}

describe("api", () => {
  it("answers state with a full view only when the version differs", async () => {
    const h = harness();
    const { call, seen, bump } = api(h);
    expect(await call("GET state")).toEqual({
      status: 200,
      body: { ok: true, changed: true, boot_id: "boot", version: "1-0", queues: {} },
    });
    expect(await call("GET state", {}, "v=boot:1-0")).toEqual({
      status: 200,
      body: { ok: true, changed: false },
    });
    expect((await call("GET state", {}, "v=other:1-0")).body["changed"]).toBe(true);
    bump();
    expect((await call("GET state", {}, "v=boot:1-0")).body["changed"]).toBe(true);
    expect(seen).toEqual(["touch", "touch", "touch", "touch"]);
    expect(await call("POST refresh")).toEqual({ status: 200, body: { ok: true } });
    expect(seen.slice(-2)).toEqual(["touch", "refresh"]);
    expect(await call("GET nope")).toEqual({
      status: 404,
      body: { error: "not-found", message: "沒有這個 API。" },
    });
    expect((await call("POST state")).status).toBe(404);
  });

  it("passes topic routes to the topic operation of the same name", async () => {
    const h = harness();
    const { call, seen } = api(h);
    for (const op of ["rename", "goal", "archive", "reopen", "keep"]) {
      expect(await call(`POST topics/${op}`, { id: "a", value: "v" })).toEqual({
        status: 200,
        body: { ok: true, line: `ok ${op}` },
      });
    }
    // Topics are confirmed when they are made, so the page has nothing to confirm.
    expect((await call("POST topics/confirm", { id: "a" })).status).toBe(404);
    await call("POST topics/move", { id: "a", queue: "high" });
    await call("POST topics/move", { id: "a", queue: "high", before: "b" });
    expect(seen.slice(-2)).toEqual([
      'move:{"id":"a","queue":"high","last":true}',
      'move:{"id":"a","queue":"high","before":"b"}',
    ]);
    expect((await call("POST topics/propose", { name: "x" })).status).toBe(404);
    const refusing = api(h, { topicOp: () => ({ ok: false, code: "refused", line: "不行" }) });
    expect(await refusing.call("POST topics/rename", {})).toEqual({
      status: 409,
      body: { error: "refused", message: "不行" },
    });
    const malformed = api(h, { topicOp: () => ({ ok: false, code: "usage", line: "用法錯" }) });
    expect(await malformed.call("POST topics/rename", {})).toEqual({
      status: 400,
      body: { error: "usage", message: "用法錯" },
    });
  });

  it("confirms a program only on the second request, with what the service reads at each step", async () => {
    const h = harness();
    let program: ProgramToConfirm = {
      path: "/opt/agg/bin/plain",
      sha256: "1".repeat(64),
      binding_sha256: "2".repeat(64),
      roles: ["feed", "deliver"],
    };
    const { call, seen } = api(h, { programToConfirm: () => program });
    expect((await call("POST programs/confirm", { role: "other" })).status).toBe(400);
    const first = await call("POST programs/confirm", { role: "deliver", path: "/elsewhere" });
    expect(first.body).toMatchObject({
      ok: true,
      confirm: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(seen).toEqual([]);
    program = { ...program, sha256: "3".repeat(64) };
    const stale = await call("POST programs/confirm", {
      role: "deliver",
      confirm: first.body["confirm"],
    });
    expect(stale.body["error"]).toBe("confirm");
    const again = await call("POST programs/confirm", { role: "deliver" });
    const done = await call("POST programs/confirm", {
      role: "deliver",
      path: "/elsewhere",
      sha256: "f".repeat(64),
      confirm: again.body["confirm"],
    });
    expect(done.status).toBe(200);
    expect(seen).toEqual([`program-confirm:${JSON.stringify(program)}`, "confirmed"]);
    const nothing = api(h, { programToConfirm: () => "沒有 config/myshape-aggregator.json" });
    expect(await nothing.call("POST programs/confirm", { role: "feed" })).toEqual({
      status: 409,
      body: { error: "refused", message: "沒有 config/myshape-aggregator.json" },
    });
  });

  it("merges only on the second request, with a code bound to that merge", async () => {
    const h = harness();
    const { call, seen } = api(h);
    const first = await call("POST topics/merge", { from: "a", into: "b" });
    expect(first.body).toMatchObject({
      ok: true,
      confirm: expect.stringMatching(/^[0-9a-f]{32}$/),
      expires_at: expect.any(Number),
    });
    expect(seen).toEqual([]);
    const code = first.body["confirm"];
    expect(
      (await call("POST topics/merge", { from: "a", into: "c", confirm: code })).body["error"],
    ).toBe("confirm");
    expect((await call("POST topics/merge", { from: "a", into: "b", confirm: code })).status).toBe(
      409,
    );
    const again = (await call("POST topics/merge", { from: "a", into: "b" })).body["confirm"];
    expect(
      (await call("POST topics/merge", { from: "a", into: "b", confirm: 5 })).body["error"],
    ).toBe("confirm");
    expect(await call("POST topics/merge", { from: "a", into: "b", confirm: again })).toEqual({
      status: 200,
      body: { ok: true, line: "ok merge" },
    });
    expect(seen).toEqual(['merge:{"from":"a","into":"b"}']);
  });

  it("answers a hold only on the second request, the way the hold recorded", async () => {
    const h = harness();
    const { call } = api(h);
    const body = { home: "main", task: "call-1", answer: "合併", label: "合併" };
    const other = (await call("POST holds/answer", body)).body["confirm"];
    expect(h.calls).toEqual([]);
    expect(
      (await call("POST holds/answer", { ...body, answer: "先不要", confirm: other })).body[
        "error"
      ],
    ).toBe("confirm");
    const firstHold = h.context.homes[0]?.report?.holds[0];
    if (firstHold === undefined) throw new Error("the fixture has no hold");
    const changed = (await call("POST holds/answer", body)).body["confirm"];
    firstHold.question = "a different question";
    expect((await call("POST holds/answer", { ...body, confirm: changed })).body["error"]).toBe(
      "confirm",
    );
    const flipped = (await call("POST holds/answer", body)).body["confirm"];
    firstHold.on_answer = "close";
    expect((await call("POST holds/answer", { ...body, confirm: flipped })).body["error"]).toBe(
      "confirm",
    );
    firstHold.on_answer = "release";
    const good = (await call("POST holds/answer", body)).body["confirm"];
    const done = await call("POST holds/answer", { ...body, confirm: good, mode: "done" });
    expect(done).toEqual({
      status: 200,
      body: { ok: true, write_id: expect.stringMatching(/^w-/) },
    });
    await vi.waitFor(() =>
      expect(h.calls[0]).toMatchObject({
        kind: "answer",
        home: "main",
        task: "call-1",
        answer: "合併",
        label: "合併",
        mode: "release",
      }),
    );
    expect(h.engine.records.get(String(done.body["write_id"]))?.channel).toBe("browser");
    expect(await call("POST holds/answer", { ...body, task: "nope" })).toEqual({
      status: 409,
      body: { error: "refused", message: "這個待決事項已經不在了（可能已經有人答了）。" },
    });
    expect((await call("POST holds/answer", { ...body, home: "nobody" })).status).toBe(409);
    const tabbed = (await call("POST holds/answer", { ...body, answer: "a\tb" })).body["confirm"];
    expect(
      (await call("POST holds/answer", { ...body, answer: "a\tb", confirm: tabbed })).status,
    ).toBe(409);
  });

  it("sends messages, direct messages, and tags as browser writes", async () => {
    const h = harness();
    const { call } = api(h);
    const message = await call("POST messages", { topic: "billing", text: "hi" });
    const direct = await call("POST direct", { home: "main", task: "ship-a", text: "look" });
    const tag = await call("POST agents/tag", { home: "main", task: "loose", topic: "login" });
    for (const reply of [message, direct, tag]) {
      expect(reply.status).toBe(200);
      expect(h.engine.records.get(String(reply.body["write_id"]))?.channel).toBe("browser");
    }
    await vi.waitFor(() =>
      expect(h.calls.map((entry) => String(entry["kind"])).toSorted()).toEqual([
        "direct",
        "message",
        "tag",
      ]),
    );
    expect(await call("POST messages", { topic: "nope", text: "hi" })).toEqual({
      status: 409,
      body: { error: "refused", message: "沒有 nope 這個議題。" },
    });
    expect((await call("POST direct", { home: "main", task: "t", text: "/x" })).status).toBe(409);
    expect((await call("POST agents/tag", { home: "main", task: "t", topic: 5 })).status).toBe(409);
    expect((await call("POST messages", {})).status).toBe(409);
  });

  it("resends in one step, or two when the outcome is unknown, and ignores", async () => {
    const h = harness();
    const { call } = api(h);
    h.next(outcome("failed", "no"));
    const failed = sent(actions.direct(h.context, "main", "t", "x", "browser"));
    await settled(failed, "failed");
    expect(await call("POST writes/resend", { write_id: failed.id })).toEqual({
      status: 200,
      body: { ok: true },
    });
    await settled(failed, "delivered");
    expect(await call("POST writes/resend", { write_id: failed.id })).toEqual({
      status: 409,
      body: { error: "refused", message: "這筆寫入不需要重送。" },
    });
    expect((await call("POST writes/resend", { write_id: "nope" })).status).toBe(409);
    expect((await call("POST writes/ignore", { write_id: failed.id })).status).toBe(409);

    failed.state = "unknown";
    const first = await call("POST writes/resend", { write_id: failed.id });
    expect(first.body).toMatchObject({ ok: true, confirm: expect.any(String) });
    expect(failed.state).toBe("unknown");
    expect(
      (await call("POST writes/resend", { write_id: failed.id, confirm: "wrong" })).body["error"],
    ).toBe("confirm");
    const code = (await call("POST writes/resend", { write_id: failed.id })).body["confirm"];
    expect(await call("POST writes/resend", { write_id: failed.id, confirm: code })).toEqual({
      status: 200,
      body: { ok: true },
    });
    await settled(failed, "delivered");

    failed.state = "failed";
    expect(await call("POST writes/ignore", { write_id: failed.id })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(failed.state).toBe("ignored");
  });
});
