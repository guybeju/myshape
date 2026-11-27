import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AGENT_NAME } from "./agent-name.js";
import type { ActionRecord, HoldEntry, LedgerEvent } from "./state-files.js";
import {
  appendLedger,
  appendTag,
  PROGRAM,
  readLanded,
  REPO_ROOT,
  runProgram,
  type ScratchHome,
  scratchHome,
  snapshot,
  writeHolds,
  writeQueued,
  writeTasks,
} from "./test-home.js";

const CONTRACT = join(REPO_ROOT, "myshape", "test", "contract");

function contractJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(CONTRACT, name), "utf8")) as Record<string, unknown>;
}

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function makeHome(withAgg = true): ScratchHome {
  const made = scratchHome(withAgg);
  homes.push(made.home);
  return made;
}

interface Report {
  schema: number;
  code_commit: string;
  tasks: Record<string, unknown>[];
  queued: Record<string, unknown>[];
  holds: Record<string, unknown>[];
  topics: Record<string, string>;
  ledger: {
    status: string;
    to_offset: number;
    to_prefix_sha256: string;
    more: boolean;
    lines: string[];
  };
  aggregator: { name: string; label: string };
  [field: string]: unknown;
}

function feed(h: ScratchHome, offset = "0", sha = "-"): Report {
  const run = runProgram(h.home, ["feed", "main", offset, sha]);
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout) as Report;
}

function deliver(h: ScratchHome, record: ActionRecord | Record<string, unknown>): unknown {
  const run = runProgram(h.home, ["deliver"], `${JSON.stringify(record)}\n`);
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  const lines = run.stdout.trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function inboxNames(h: ScratchHome): string[] {
  return readdirSync(join(h.agg, "inbox")).toSorted();
}

const QUESTION = "要用新的快取嗎？\n選項：A | B";

function openHold(question = QUESTION): HoldEntry {
  return {
    state: "open",
    title: "快取",
    question,
    on_answer: "release",
    hold_set: "2026-11-25T00:00:00Z",
  };
}

function answerRecord(id: string, overrides: Partial<Record<string, unknown>> = {}): ActionRecord {
  return {
    v: 1,
    id,
    attempt: 0,
    kind: "answer",
    home: "main",
    task: "t1",
    answer: "A",
    label: "A",
    mode: "release",
    question_sha256: sha256(QUESTION),
    topic: { id: "build", name: "建置" },
    ...overrides,
  } as ActionRecord;
}

const DELIVERED = { outcome: "delivered" };
const ELSEWHERE = { outcome: "handled_elsewhere" };

describe("feed", () => {
  it("reports the contract's fields for every list, from the state files", () => {
    const h = makeHome();
    writeTasks(h.agg, {
      v: 1,
      tasks: {
        t1: { kind: "ship", state: "working", detail: "跑測試中", session_id: "s", worktree: "/w" },
      },
    });
    writeQueued(h.agg, { v: 1, queued: [{ id: "q1", kind: "ship", title: "下一步" }] });
    writeHolds(h.agg, { v: 1, holds: { t1: openHold() } });
    appendTag(h.agg, "t1", "build", "2026-11-25T00:00:00Z");
    const report = feed(h);
    const example = contractJson("report-main.json");
    const keysOf = (value: unknown): string[] => Object.keys(value as object).toSorted();
    const first = (list: unknown): unknown => (list as unknown[])[0];
    expect(keysOf(report.tasks[0])).toEqual(keysOf(first(example["tasks"])));
    expect(keysOf(report.queued[0])).toEqual(keysOf(first(example["queued"])));
    expect(keysOf(report.holds[0])).toEqual(keysOf(first(example["holds"])));
    expect(keysOf(report.ledger)).toEqual(keysOf(example["ledger"]));
    for (const key of Object.keys(report)) expect(Object.keys(example)).toContain(key);
    expect(report.tasks).toEqual([
      {
        id: "t1",
        kind: "ship",
        state: "working",
        source: "tasks.json",
        detail: "跑測試中",
        unstarted: false,
      },
    ]);
    expect(report.queued).toEqual([
      {
        id: "q1",
        kind: "ship",
        title: "下一步",
        hold: null,
        captain: false,
        blockers: [],
        topic_hint: null,
        hold_until: null,
        turn: false,
      },
    ]);
    expect(report.topics).toEqual({ t1: "build 2026-11-25T00:00:00Z" });
    expect(report.schema).toBe(1);
    expect(report["status_decisions"]).toEqual([]);
    expect(report["secondmates"]).toEqual([]);
    expect(report.aggregator.name).toBe(AGENT_NAME);
  });

  it("passes on a queued item's date and turn as the supervisor wrote them", () => {
    const h = makeHome();
    writeQueued(h.agg, {
      v: 1,
      queued: [
        { id: "q1", kind: "ship", title: "等空位", hold: "等空位（2/2）", turn: true },
        { id: "q2", kind: "ship", title: "延到", hold: "等額度", hold_until: "2026-12-05" },
      ],
    });
    const report = feed(h);
    expect(report.queued.map(({ id, hold_until, turn }) => [id, hold_until, turn])).toEqual([
      ["q1", null, true],
      ["q2", "2026-12-05", false],
    ]);
  });

  it("is an empty report for a home whose state files are not written yet", () => {
    const report = feed(makeHome());
    expect([report.tasks, report.queued, report.holds]).toEqual([[], [], []]);
    expect(report.topics).toEqual({});
    expect(report.ledger).toEqual({
      status: "absent",
      to_offset: 0,
      to_prefix_sha256: "-",
      more: false,
      lines: [],
    });
  });

  it("exits 4 with a one-line banner when the home has no agg/ directory", () => {
    const h = makeHome(false);
    const run = runProgram(h.home, ["feed", "main", "0", "-"]);
    expect(run.status).toBe(4);
    expect(run.stdout).toBe("");
    expect(run.stderr.split("\n")[0]).toContain(h.agg);
  });

  it("shows an open hold until an answer to that very question lands", () => {
    const h = makeHome();
    writeHolds(h.agg, {
      v: 1,
      holds: { t1: openHold(), t2: { ...openHold(), state: "closed" } },
    });
    const [hold] = feed(h).holds;
    expect(hold).toMatchObject({
      id: "t1",
      question: QUESTION,
      hold_bucket: "live",
      hold_until: null,
      unresolved_blocker_ids: [],
      origin: "",
      on_answer: "release",
      hold_set: "2026-11-25T00:00:00Z",
    });
    expect(hold?.["hold_age_days"]).toBeGreaterThanOrEqual(1);
    expect(feed(h).holds).toHaveLength(1);
    expect(deliver(h, answerRecord("w-a1"))).toEqual(DELIVERED);
    expect(feed(h).holds).toEqual([]);
  });

  it("reports every tag file, the last line being the topic", () => {
    const h = makeHome();
    appendTag(h.agg, "gone", "old", "2026-11-20T00:00:00Z");
    appendTag(h.agg, "gone", "new", "2026-11-21T00:00:00Z");
    writeFileSync(join(h.agg, "tags", ".tmp-x-1"), "skip 2026-11-21T00:00:00Z\n");
    expect(feed(h).topics).toEqual({
      gone: "old 2026-11-20T00:00:00Z\nnew 2026-11-21T00:00:00Z",
    });
  });

  it("fails, keeping the board's last report, when a state file is not valid", () => {
    const h = makeHome();
    writeFileSync(join(h.agg, "tasks.json"), "{not json");
    let run = runProgram(h.home, ["feed", "main", "0", "-"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("tasks.json");
    writeTasks(h.agg, { v: 1, tasks: { t1: { kind: "secondmate", state: "working" } } });
    run = runProgram(h.home, ["feed", "main", "0", "-"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("secondmate");
  });

  it("names its version by its own bytes, so a changed program reports another code_commit", () => {
    const h = makeHome();
    const dir = mkdtempSync(join(tmpdir(), "agg-board-copy-"));
    homes.push(dir);
    const copy = join(dir, "agg-board.mjs");
    writeFileSync(copy, `${readFileSync(PROGRAM, "utf8")}\n`);
    const own = feed(h).code_commit;
    const changed = JSON.parse(
      runProgram(h.home, ["feed", "main", "0", "-"], "", copy).stdout,
    ) as Report;
    expect(own).toMatch(/^agg-board-[0-9a-f]{16}$/);
    expect(changed.code_commit).not.toBe(own);
    expect(feed(h).code_commit).toBe(own);
  });

  it("accepts the closed-hold cursor the board may add, and reports no closed holds", () => {
    const run = runProgram(makeHome().home, ["feed", "main", "0", "-", "0", "-"]);
    expect(run.status).toBe(0);
    const report = JSON.parse(run.stdout) as Report;
    expect(report["closed_holds"]).toBeUndefined();
    expect(report["closed_cursor"]).toBeUndefined();
  });
});

describe("feed's ledger", () => {
  const events: LedgerEvent[] = [
    { v: 1, ts: 1795000000, event: "task.dispatched", task: "t1", kind: "ship" },
    { v: 1, ts: 1795000100, event: "task.status", task: "t1", state: "working", text: "一半" },
  ];

  it("hands over whole lines from the cursor, and the next call from where it stopped", () => {
    const h = makeHome();
    appendLedger(h.agg, events);
    const bytes = readFileSync(join(h.agg, "ledger.jsonl"));
    const first = feed(h).ledger;
    expect(first).toEqual({
      status: "delta",
      to_offset: bytes.length,
      to_prefix_sha256: createHash("sha256").update(bytes).digest("hex"),
      more: false,
      lines: events.map((e) => JSON.stringify(e)),
    });
    appendLedger(h.agg, [{ v: 1, ts: 1795000200, event: "task.cleaned_up", task: "t1" }]);
    const next = feed(h, String(first.to_offset), first.to_prefix_sha256).ledger;
    expect(next.lines).toEqual([
      JSON.stringify({ v: 1, ts: 1795000200, event: "task.cleaned_up", task: "t1" }),
    ]);
    expect(next.to_offset).toBe(readFileSync(join(h.agg, "ledger.jsonl")).length);
  });

  it("leaves a line still being written for the next call", () => {
    const h = makeHome();
    appendLedger(h.agg, events.slice(0, 1));
    writeFileSync(join(h.agg, "ledger.jsonl"), '{"v":1,"ts":17', { flag: "a" });
    const ledger = feed(h).ledger;
    expect(ledger.lines).toHaveLength(1);
    expect(ledger.to_offset).toBe(JSON.stringify(events[0]).length + 1);
  });

  it("is broken when the cursor's offset or prefix hash does not match the file", () => {
    const h = makeHome();
    appendLedger(h.agg, events);
    const broken = {
      status: "continuity-broken",
      to_offset: 0,
      to_prefix_sha256: "-",
      more: false,
      lines: [],
    };
    expect(feed(h, "999999", "-").ledger).toEqual(broken);
    expect(feed(h, "10", "0".repeat(64)).ledger).toEqual(broken);
    expect(feed(h, "10", "-").ledger).toEqual(broken);
  });

  it("hands over at most 256 KiB per call and says there is more", () => {
    const h = makeHome();
    const many: LedgerEvent[] = [];
    for (let i = 0; i < 4000; i++) {
      many.push({
        v: 1,
        ts: 1795000000 + i,
        event: "task.status",
        task: "t1",
        state: "working",
        text: "x".repeat(80),
      });
    }
    appendLedger(h.agg, many);
    const size = readFileSync(join(h.agg, "ledger.jsonl")).length;
    let ledger = feed(h).ledger;
    expect(ledger.more).toBe(true);
    expect(ledger.to_offset).toBeLessThanOrEqual(256 * 1024);
    let lines = ledger.lines.length;
    while (ledger.more) {
      ledger = feed(h, String(ledger.to_offset), ledger.to_prefix_sha256).ledger;
      lines += ledger.lines.length;
    }
    expect(lines).toBe(4000);
    expect(ledger.to_offset).toBe(size);
  });
});

describe("topics", () => {
  it("prints the tags of the tasks asked for that have a tag file", () => {
    const h = makeHome();
    appendTag(h.agg, "t1", "build", "2026-11-25T00:00:00Z");
    appendTag(h.agg, "t2", "other", "2026-11-25T00:00:00Z");
    const run = runProgram(h.home, ["topics", "main", "t1", "none"]);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ topics: { t1: "build 2026-11-25T00:00:00Z" } });
  });
});

describe("argument shapes", () => {
  const bad: string[][] = [
    [],
    ["read"],
    ["feed"],
    ["feed", "main", "0"],
    ["feed", "main", "0", "-", "0"],
    ["feed", "main", "0", "-", "0", "-", "x"],
    ["feed", ".main", "0", "-"],
    ["feed", "-main", "0", "-"],
    ["feed", "ma/in", "0", "-"],
    ["feed", "other", "0", "-"],
    ["feed", "main", "-1", "-"],
    ["feed", "main", "01", "-"],
    ["feed", "main", "1.5", "-"],
    ["feed", "main", "99999999999999999999", "-"],
    ["feed", "main", "0", "abc"],
    ["feed", "main", "0", "a".repeat(63)],
    ["feed", "main", "0", "-", "x", "-"],
    ["feed", "main", "0", "-", "0", "zz"],
    ["topics", "main"],
    ["topics", "main", "../x"],
    ["topics", "main", ".x"],
    ["topics", "other", "t1"],
    ["deliver", "extra"],
  ];
  it.each(bad)("exits 2 and writes nothing for %j", (...args: string[]) => {
    const h = makeHome();
    const before = snapshot(h.home);
    const run = runProgram(h.home, args, '{"v":1}\n');
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).not.toBe("");
    expect(snapshot(h.home)).toEqual(before);
  });
});

describe("deliver", () => {
  it("lands a message once in inbox/, named by its id, however often it comes", () => {
    const h = makeHome();
    const record = contractJson("action-message.json");
    expect(deliver(h, record)).toEqual(DELIVERED);
    expect(deliver(h, { ...record, attempt: 1 })).toEqual(DELIVERED);
    expect(inboxNames(h)).toEqual(["handled", `${String(record["id"])}.json`]);
    const landed = readLanded(join(h.agg, "inbox", `${String(record["id"])}.json`));
    expect(landed.v).toBe(1);
    expect(landed.record).toEqual(record);
    expect(landed.received_ms).toBeGreaterThan(1_700_000_000_000);
  });

  it("delivers a notice of any event, known or not", () => {
    const h = makeHome();
    for (const record of [
      contractJson("action-notice.json"),
      contractJson("action-notice-todo-closed.json"),
      {
        v: 1,
        id: "w-s-weekly-20261130T0200Z-pre",
        attempt: 0,
        kind: "notice",
        event: "schedule.upcoming",
        text: "快到了",
        occurrence: { key: "k" },
      },
      {
        v: 1,
        id: "w-new-1",
        attempt: 0,
        kind: "notice",
        event: "some.future_event",
        text: "新的事",
      },
    ]) {
      expect(deliver(h, record)).toEqual(DELIVERED);
      expect(deliver(h, { ...record, attempt: 1 })).toEqual(DELIVERED);
      expect(readLanded(join(h.agg, "inbox", `${String(record["id"])}.json`)).record).toEqual(
        record,
      );
    }
    expect(inboxNames(h)).toHaveLength(5);
  });

  it("treats an id the supervisor already moved to inbox/handled/ as landed", () => {
    const h = makeHome();
    const record = contractJson("action-message.json");
    deliver(h, record);
    const name = `${String(record["id"])}.json`;
    renameSync(join(h.agg, "inbox", name), join(h.agg, "inbox", "handled", name));
    expect(deliver(h, record)).toEqual(DELIVERED);
    expect(inboxNames(h)).toEqual(["handled"]);
  });

  it("asks the board to retry, writing nothing, while agg/ or its directories are missing", () => {
    const h = makeHome();
    rmSync(join(h.agg, "inbox"), { recursive: true });
    const before = snapshot(h.home);
    const outcome = deliver(h, contractJson("action-message.json")) as Record<string, string>;
    expect(outcome["outcome"]).toBe("retry");
    expect(outcome["error"]).toContain("inbox");
    expect(snapshot(h.home)).toEqual(before);
    const bare = makeHome(false);
    expect(
      (deliver(bare, contractJson("action-message.json")) as Record<string, string>)["outcome"],
    ).toBe("retry");
    expect(existsSync(bare.agg)).toBe(false);
  });

  describe("direct", () => {
    const record = contractJson("action-direct.json");
    const task = String(record["task"]);

    it("lands for a worker that is still running", () => {
      const h = makeHome();
      for (const state of ["working", "paused", "blocked"] as const) {
        writeTasks(h.agg, { v: 1, tasks: { [task]: { kind: "ship", state } } });
        const id = `${String(record["id"])}-${state}`;
        expect(deliver(h, { ...record, id })).toEqual(DELIVERED);
        expect(inboxNames(h)).toContain(`${id}.json`);
      }
    });

    it("lands once for the same id, and keeps it delivered after the worker ends", () => {
      const h = makeHome();
      writeTasks(h.agg, { v: 1, tasks: { [task]: { kind: "ship", state: "working" } } });
      expect(deliver(h, record)).toEqual(DELIVERED);
      writeTasks(h.agg, { v: 1, tasks: { [task]: { kind: "ship", state: "done" } } });
      expect(deliver(h, { ...record, attempt: 1 })).toEqual(DELIVERED);
      expect(inboxNames(h)).toEqual(["handled", `${String(record["id"])}.json`]);
    });

    it("fails for a worker that has ended, or that it does not know, and lands nothing", () => {
      const h = makeHome();
      for (const state of ["done", "failed"] as const) {
        writeTasks(h.agg, { v: 1, tasks: { [task]: { kind: "ship", state } } });
        expect(deliver(h, record)).toEqual({
          outcome: "failed",
          error: "這個 worker 已經結束，訊息沒有送出。",
        });
      }
      writeTasks(h.agg, { v: 1, tasks: {} });
      expect(deliver(h, record)).toMatchObject({ outcome: "failed" });
      expect(deliver(h, { ...record, home: "far" })).toMatchObject({ outcome: "failed" });
      expect(inboxNames(h)).toEqual(["handled"]);
    });

    it("refuses text that a terminal would take as a command", () => {
      const h = makeHome();
      writeTasks(h.agg, { v: 1, tasks: { [task]: { kind: "ship", state: "working" } } });
      for (const text of ["/exit", "$HOME", "!ls", "-rf", "  /clear"]) {
        expect(deliver(h, { ...record, text })).toMatchObject({ outcome: "failed" });
      }
      expect(inboxNames(h)).toEqual(["handled"]);
    });
  });

  describe("answer", () => {
    it("writes the answer for the open hold whose question it matches, and lands it in the inbox", () => {
      const h = makeHome();
      writeHolds(h.agg, { v: 1, holds: { t1: openHold() } });
      const record = answerRecord("w-a1");
      expect(deliver(h, record)).toEqual(DELIVERED);
      expect(deliver(h, { ...record, attempt: 2 })).toEqual(DELIVERED);
      expect(readLanded(join(h.agg, "answers", "t1.json")).record).toEqual(record);
      expect(inboxNames(h)).toEqual(["handled", "w-a1.json"]);
      expect(readdirSync(join(h.agg, "answers")).toSorted()).toEqual(["handled", "t1.json"]);
    });

    it("matches the contract's answer record when its question is the hold's", () => {
      const h = makeHome();
      const record = contractJson("action-answer.json");
      writeHolds(h.agg, { v: 1, holds: { [String(record["task"])]: openHold() } });
      expect(deliver(h, record)).toEqual(ELSEWHERE);
      expect(deliver(h, { ...record, question_sha256: sha256(QUESTION) })).toEqual(DELIVERED);
    });

    it("is handled elsewhere when the hold is closed, gone, asks another question or has another answer", () => {
      const h = makeHome();
      writeHolds(h.agg, { v: 1, holds: { t1: { ...openHold(), state: "closed" } } });
      expect(deliver(h, answerRecord("w-a1"))).toEqual(ELSEWHERE);
      writeHolds(h.agg, { v: 1, holds: {} });
      expect(deliver(h, answerRecord("w-a2"))).toEqual(ELSEWHERE);
      writeHolds(h.agg, { v: 1, holds: { t1: openHold("別的問題？") } });
      expect(deliver(h, answerRecord("w-a3"))).toEqual(ELSEWHERE);
      writeHolds(h.agg, { v: 1, holds: { t1: openHold() } });
      expect(deliver(h, answerRecord("w-a4"))).toEqual(DELIVERED);
      expect(deliver(h, answerRecord("w-a5", { answer: "B", label: "B" }))).toEqual(ELSEWHERE);
      expect(deliver(h, answerRecord("w-a6"))).toEqual(DELIVERED);
      expect(readLanded(join(h.agg, "answers", "t1.json")).record.id).toBe("w-a4");
      expect(deliver(h, answerRecord("w-a7", { home: "far" }))).toMatchObject({
        outcome: "failed",
      });
    });

    it("waits for the supervisor to retire an older answer before it takes one for a new question", () => {
      const h = makeHome();
      writeHolds(h.agg, { v: 1, holds: { t1: openHold() } });
      expect(deliver(h, answerRecord("w-a1"))).toEqual(DELIVERED);
      const second = "還要再做一次嗎？\n選項：好 | 不要";
      writeHolds(h.agg, { v: 1, holds: { t1: openHold(second) } });
      expect(feed(h).holds.map((hold) => hold["question"])).toEqual([second]);
      const record = answerRecord("w-b1", {
        answer: "好",
        label: "好",
        question_sha256: sha256(second),
      });
      expect(deliver(h, record)).toMatchObject({ outcome: "retry" });
      renameSync(
        join(h.agg, "answers", "t1.json"),
        join(h.agg, "answers", "handled", "t1.w-a1.json"),
      );
      expect(deliver(h, record)).toEqual(DELIVERED);
      expect(readLanded(join(h.agg, "answers", "t1.json")).record).toEqual(record);
      expect(feed(h).holds).toEqual([]);
    });
  });

  describe("tag", () => {
    const record = contractJson("action-tag.json");
    const task = String(record["task"]);
    const tagFile = (h: ScratchHome): string => readFileSync(join(h.agg, "tags", task), "utf8");

    it("appends one line, which the next feed reports, and lands it in the inbox", () => {
      const h = makeHome();
      expect(deliver(h, record)).toEqual(DELIVERED);
      expect(deliver(h, record)).toEqual(DELIVERED);
      expect(tagFile(h)).toMatch(/^billing \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/);
      expect(feed(h).topics[task]).toBe(tagFile(h).trimEnd());
      expect(inboxNames(h)).toEqual(["handled", `${String(record["id"])}.json`]);
    });

    it("appends after the line the board saw, and adds nothing when the task is already there", () => {
      const h = makeHome();
      appendTag(h.agg, task, "old", "2026-11-20T00:00:00Z");
      expect(deliver(h, { ...record, last_tag_line: "old 2026-11-20T00:00:00Z" })).toEqual(
        DELIVERED,
      );
      const lines = tagFile(h).trimEnd().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[1]?.startsWith("billing ")).toBe(true);
      expect(deliver(h, { ...record, id: "w-again", last_tag_line: "" })).toEqual(DELIVERED);
      expect(tagFile(h).trimEnd().split("\n")).toHaveLength(2);
    });

    it("is handled elsewhere when the task was filed somewhere else since the board looked", () => {
      const h = makeHome();
      appendTag(h.agg, task, "other", "2026-11-20T00:00:00Z");
      expect(deliver(h, record)).toEqual(ELSEWHERE);
      expect(tagFile(h)).toBe("other 2026-11-20T00:00:00Z\n");
      expect(inboxNames(h)).toEqual(["handled"]);
    });

    it("finishes a delivery that stopped between the tag line and the inbox file", () => {
      const h = makeHome();
      deliver(h, record);
      rmSync(join(h.agg, "inbox", `${String(record["id"])}.json`));
      expect(deliver(h, { ...record, attempt: 1 })).toEqual(DELIVERED);
      expect(tagFile(h).trimEnd().split("\n")).toHaveLength(1);
      expect(inboxNames(h)).toEqual(["handled", `${String(record["id"])}.json`]);
    });

    it("fails for a home it does not have", () => {
      expect(deliver(makeHome(), { ...record, home: "far" })).toMatchObject({ outcome: "failed" });
    });
  });

  const message = contractJson("action-message.json");
  const badRecords: [string, string][] = [
    ["not JSON", "{not json\n"],
    ["empty", ""],
    ["two lines", `${JSON.stringify(message)}\n${JSON.stringify(message)}\n`],
    ["a JSON array", "[1]\n"],
    ["v 2", `${JSON.stringify({ ...message, v: 2 })}\n`],
    ["an id with a slash", `${JSON.stringify({ ...message, id: "w-a/b" })}\n`],
    ["an id starting with a dot", `${JSON.stringify({ ...message, id: ".tmp-x" })}\n`],
    ["a negative attempt", `${JSON.stringify({ ...message, attempt: -1 })}\n`],
    ["an unknown kind", `${JSON.stringify({ ...message, kind: "launch" })}\n`],
    ["a message without text", `${JSON.stringify({ ...message, text: undefined })}\n`],
    ["a message without a topic", `${JSON.stringify({ ...message, topic: null })}\n`],
    [
      "a task climbing out",
      `${JSON.stringify({ ...contractJson("action-direct.json"), task: "../x" })}\n`,
    ],
    [
      "a home with a slash",
      `${JSON.stringify({ ...contractJson("action-direct.json"), home: "a/b" })}\n`,
    ],
    [
      "a tag topic with a slash",
      `${JSON.stringify({ ...contractJson("action-tag.json"), topic: "a/b" })}\n`,
    ],
    [
      "an answer with a short sha",
      `${JSON.stringify({ ...contractJson("action-answer.json"), question_sha256: "ab" })}\n`,
    ],
    [
      "an answer with another mode",
      `${JSON.stringify({ ...contractJson("action-answer.json"), mode: "maybe" })}\n`,
    ],
    [
      "a notice without an event",
      `${JSON.stringify({ ...contractJson("action-notice.json"), event: "" })}\n`,
    ],
  ];
  it.each(badRecords)("exits 2 and writes nothing for %s", (_what, input) => {
    const h = makeHome();
    writeTasks(h.agg, { v: 1, tasks: { "ship-a": { kind: "ship", state: "working" } } });
    const before = snapshot(h.home);
    const run = runProgram(h.home, ["deliver"], input);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).not.toBe("");
    expect(snapshot(h.home)).toEqual(before);
  });
});

describe("the environment", () => {
  it("fails without MYSHAPE_HOME, the one name it reads", () => {
    for (const home of ["", "relative/home"]) {
      const run = runProgram(home, ["feed", "main", "0", "-"]);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("MYSHAPE_HOME");
    }
  });
});
