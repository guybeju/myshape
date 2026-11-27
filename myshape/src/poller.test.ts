import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AllowedCommand, CommandResult } from "./commands.js";
import { Journal, Offsets } from "./journal.js";
import { boardPaths } from "./layout.js";
import { DEFAULT_TIMINGS, MAX_TOPICS_CALLS, Poller } from "./poller.js";
import type { PollTimings } from "./poller.js";

const LINE = (task: string) => JSON.stringify({ v: 1, ts: 5, event: "task.status", task });
const TIMINGS: PollTimings = {
  readMs: 40,
  timeoutMs: 111,
  idleMs: 600,
  staleMs: 1000,
  slowMs: 900_000,
  slowFarMs: 3_600_000,
};

interface Setup {
  poller: Poller;
  journal: Journal;
  offsets: Offsets;
  calls: { command: AllowedCommand; timeout: number }[];
  /** What each home answers next; a function is called with the command. */
  answers: Map<string, (command: AllowedCommand) => CommandResult | Promise<CommandResult>>;
  changes: () => number;
  aggregators: unknown[];
  /** The closed decisions' cursor the host hands out per home, the homes it was told of, and refusals. */
  cursors: Map<string, { offset: number; sha: string }>;
  reported: string[];
  /** The start of each read the host was handed, in epoch seconds. */
  started: number[];
  refused: string[];
}

let dir: string;
let pollers: Poller[];

function report(extra: Record<string, unknown> = {}): CommandResult {
  const body = {
    schema: 1,
    code_commit: "c1",
    ledger_enabled: true,
    tasks: [],
    holds: [],
    status_decisions: [],
    topics: {},
    ledger: { status: "absent", to_offset: 0, to_prefix_sha256: "-", more: false, lines: [] },
    secondmates: [],
    ...extra,
  };
  return { code: 0, stdout: JSON.stringify(body), stderr: "" };
}

const SECONDMATES = [{ id: "sm1" }, { id: "far1", read_every_s: 2, read_timeout_s: 3 }];

/** The feed command a call ran, as "<home> <offset> <sha>". */
function feedOf(call: { command: AllowedCommand }): string {
  const { command } = call;
  return command.kind === "feed" ? `${command.home} ${command.offset} ${command.sha}` : "";
}

function setup(timings: PollTimings = TIMINGS, blocked: string | null = null): Setup {
  const paths = boardPaths({
    state: path.join(dir, "state"),
    data: path.join(dir, "data"),
    config: path.join(dir, "config"),
  });
  fs.mkdirSync(paths.boardDataDir, { recursive: true });
  const journal = new Journal(paths.events);
  const offsets = new Offsets(paths);
  const calls: Setup["calls"] = [];
  const answers: Setup["answers"] = new Map();
  let changes = 0;
  const aggregators: unknown[] = [];
  const cursors: Setup["cursors"] = new Map();
  const reported: string[] = [];
  const started: number[] = [];
  const refused: string[] = [];
  const poller = new Poller(
    async (command, timeout) => {
      calls.push({ command, timeout });
      const home = command.kind === "deliver" ? "main" : command.home;
      const answer = answers.get(home);
      return answer === undefined ? report() : answer(command);
    },
    journal,
    offsets,
    timings,
    {
      onChange: () => {
        changes += 1;
      },
      onAggregator: (aggregator) => aggregators.push(aggregator),
      closedCursor: (home) => cursors.get(home) ?? null,
      onReport: (home, parsed, startedAt) => {
        reported.push(`${home}:${parsed.closed_holds.length}`);
        started.push(startedAt);
      },
      onCursorRefused: (home) => refused.push(home),
    },
    () => blocked,
  );
  pollers.push(poller);
  return {
    poller,
    journal,
    offsets,
    calls,
    answers,
    changes: () => changes,
    aggregators,
    cursors,
    reported,
    started,
    refused,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-poller-"));
  pollers = [];
});
afterEach(() => {
  for (const poller of pollers) poller.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("reading the main home", () => {
  it("starts knowing only the main home, unread", () => {
    const { poller } = setup();
    expect(poller.snapshots()).toEqual([
      {
        id: "main",
        report: null,
        lastOkAt: null,
        error: null,
        version: "unknown",
        staleAfterMs: 1_800_000,
      },
    ]);
    expect(poller.hasMainReport()).toBe(false);
    expect(poller.knows("main")).toBe(true);
    expect(poller.knows("sm1")).toBe(false);
    expect(poller.active).toBe(false);
    expect(DEFAULT_TIMINGS).toEqual({
      readMs: 10_000,
      timeoutMs: 60_000,
      idleMs: 120_000,
      staleMs: 180_000,
      slowMs: 900_000,
      slowFarMs: 3_600_000,
    });
  });

  it("reads nothing when the feed cannot be started", async () => {
    const s = setup(TIMINGS, "沒有 bin/fm-board.sh");
    expect(await s.poller.readNow("main")).toBe(false);
    expect(await s.poller.readFresh("main")).toBe(false);
    await s.poller.refreshAll();
    s.poller.touch();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(s.calls).toEqual([]);
    expect(s.poller.snapshots()[0]).toMatchObject({ error: null, report: null });
  });

  it("stores the report and learns the further homes", async () => {
    const s = setup();
    s.answers.set("main", () => report({ secondmates: SECONDMATES }));
    const before = Date.now();
    expect(await s.poller.readNow("main")).toBe(true);
    const [main] = s.poller.snapshots();
    expect(main).toMatchObject({ id: "main", error: null, version: "same" });
    expect(main?.lastOkAt).toBeGreaterThanOrEqual(before);
    expect(s.poller.hasMainReport()).toBe(true);
    expect(s.poller.snapshots().map((home) => home.id)).toEqual(["main", "sm1", "far1"]);
    expect(s.poller.knows("far1")).toBe(true);
    expect(s.calls[0]).toEqual({
      command: { kind: "feed", home: "main", offset: 0, sha: "-" },
      timeout: 111,
    });
    expect(s.aggregators).toEqual([null]);
    expect(s.changes()).toBe(1);
    expect(await s.poller.readNow("nobody")).toBe(false);
  });

  it("passes a home its closed decisions' cursor and hands each good report over", async () => {
    const s = setup();
    s.cursors.set("main", { offset: 9, sha: "b".repeat(64) });
    const closed = [{ id: "x", digest: "d", occurrence: 1 }];
    s.answers.set("main", () => report({ closed_holds: closed }));
    await s.poller.readNow("main");
    expect(s.calls[0]?.command).toEqual({
      kind: "feed",
      home: "main",
      offset: 0,
      sha: "-",
      closed: { offset: 9, sha: "b".repeat(64) },
    });
    expect(s.reported).toEqual(["main:1"]);
    s.answers.set("main", () => ({ code: 3, stdout: "", stderr: "boom" }));
    await s.poller.readNow("main");
    expect(s.reported).toEqual(["main:1"]);
  });

  it("hands over no read of new code that failed, could not report or is not schema 1", async () => {
    const s = setup();
    await s.poller.readNow("main");
    const failures: CommandResult[] = [
      { code: 1, stdout: "", stderr: "boom" },
      { code: 4, stdout: "", stderr: "cannot report" },
      report({ code_commit: "c2", schema: 2 }),
      { code: 0, stdout: '{"code_commit":"c2"', stderr: "" },
    ];
    for (const failure of failures) {
      s.answers.set("main", () => failure);
      await s.poller.readNow("main");
    }
    expect(s.reported).toEqual(["main:0"]);
    s.answers.set("main", () => report({ code_commit: "c2" }));
    await s.poller.readNow("main");
    expect(s.reported).toEqual(["main:0", "main:0"]);
  });

  it("forgets the cursor of a home that refuses it, and only then", async () => {
    const s = setup();
    s.answers.set("main", () => ({ code: 2, stdout: "", stderr: "usage" }));
    await s.poller.readNow("main");
    expect(s.refused).toEqual([]);
    s.cursors.set("main", { offset: 1, sha: "-" });
    await s.poller.readNow("main");
    expect(s.refused).toEqual(["main"]);
  });

  it("reads again at once while the closed decisions' archive has more", async () => {
    const s = setup();
    let left = 2;
    s.answers.set("main", () => {
      left -= 1;
      const more = left > 0;
      return report({
        closed_cursor: { status: "delta", to_offset: 0, to_prefix_sha256: "-", more },
      });
    });
    await s.poller.readNow("main");
    expect(s.calls).toHaveLength(2);
  });

  it("does not count a change in closed decisions alone as something a viewer sees", async () => {
    const s = setup();
    await s.poller.readNow("main");
    s.answers.set("main", () =>
      report({ closed_holds: [{ id: "x", digest: "d", occurrence: 1 }] }),
    );
    await s.poller.readNow("main");
    expect(s.changes()).toBe(1);
  });

  it("follows the root report's list: new and removed homes", async () => {
    const s = setup();
    s.answers.set("main", () => report({ secondmates: SECONDMATES }));
    await s.poller.readNow("main");
    await s.poller.readNow("sm1");
    s.answers.set("main", () => report({ secondmates: [{ id: "sm1" }, { id: "new" }] }));
    await s.poller.readNow("main");
    expect(s.poller.snapshots().map((home) => home.id)).toEqual(["main", "sm1", "new"]);
    expect(s.poller.knows("far1")).toBe(false);
    expect(s.poller.snapshots().find((home) => home.id === "sm1")?.report).not.toBeNull();
  });

  it("reads each home with the same feed, its own cursor, and its hinted timeout", async () => {
    const s = setup();
    s.answers.set("main", () => report({ secondmates: SECONDMATES }));
    await s.poller.readNow("main");
    s.offsets.set("sm1", { offset: 7, sha: "a".repeat(64) });
    await s.poller.readNow("sm1");
    await s.poller.readNow("far1");
    expect(s.calls.slice(1)).toEqual([
      { command: { kind: "feed", home: "sm1", offset: 7, sha: "a".repeat(64) }, timeout: 111 },
      { command: { kind: "feed", home: "far1", offset: 0, sha: "-" }, timeout: 3000 },
    ]);
  });

  it("hands over the root report's aggregator block, and no other home's", async () => {
    const s = setup();
    const aggregator = { name: "plain", label: "plain", update_hint: null, decisions_at_once: 1 };
    s.answers.set("main", () => report({ secondmates: SECONDMATES, aggregator }));
    s.answers.set("sm1", () => report({ aggregator: { name: "x", label: "x" } }));
    await s.poller.refreshAll();
    expect(s.aggregators).toEqual([aggregator]);
  });
});

describe("versions", () => {
  it("compares each home's commit with the main home's", async () => {
    const s = setup();
    s.answers.set("main", () => report({ secondmates: SECONDMATES }));
    s.answers.set("far1", () => report({ code_commit: "other" }));
    await s.poller.refreshAll();
    const versions = (): string =>
      s.poller
        .snapshots()
        .map((home) => `${home.id}:${home.version}`)
        .join(" ");
    expect(versions()).toBe("main:same sm1:same far1:different");
    s.answers.set("main", () => report({ secondmates: SECONDMATES, code_commit: "other" }));
    await s.poller.readNow("main");
    expect(versions()).toBe("main:same sm1:different far1:same");
    s.answers.set("main", () => report({ secondmates: SECONDMATES, code_commit: "" }));
    await s.poller.readNow("main");
    expect(versions()).toBe("main:same sm1:unknown far1:unknown");
  });

  it("reads the main home first on a full refresh, then every other home", async () => {
    const s = setup();
    s.answers.set("main", () => report({ secondmates: SECONDMATES }));
    await s.poller.refreshAll();
    expect(s.calls.map((call) => feedOf(call).split(" ")[0])).toEqual(["main", "sm1", "far1"]);
  });
});

describe("the ledger", () => {
  const delta = (lines: string[], extra: Record<string, unknown> = {}) =>
    report({
      ledger: {
        status: "delta",
        to_offset: 10,
        to_prefix_sha256: "s1",
        more: false,
        lines,
        ...extra,
      },
    });

  it("stores new lines, then the cursor", async () => {
    const s = setup();
    s.answers.set("main", () => delta([LINE("a"), LINE("b")]));
    await s.poller.readNow("main");
    expect(
      s.journal.events.map((event) =>
        event.src === "ledger" ? `${event.home}/${event.task}` : "",
      ),
    ).toEqual(["main/a", "main/b"]);
    expect(s.offsets.get("main")).toEqual({ offset: 10, sha: "s1" });
    s.answers.set("main", () => delta([]));
    await s.poller.readNow("main");
    expect(s.offsets.get("main")).toEqual({ offset: 10, sha: "s1" });
  });

  it("keeps reading while the home says there is more", async () => {
    const s = setup();
    const pieces = [
      delta([LINE("a")], { more: true, to_offset: 5 }),
      delta([LINE("b")], { more: true, to_offset: 9 }),
      delta([LINE("c")], { to_offset: 12 }),
    ];
    s.answers.set("main", () => pieces.shift() as CommandResult);
    await s.poller.readNow("main");
    expect(s.calls.map((call) => feedOf(call).split(" ")[1])).toEqual(["0", "5", "9"]);
    expect(s.journal.events).toHaveLength(3);
    expect(s.changes()).toBe(1);
  });

  it("stops after 50 reads of a home that always has more", async () => {
    const s = setup();
    s.answers.set("main", () => delta([], { more: true }));
    await s.poller.readNow("main");
    expect(s.calls).toHaveLength(50);
  });

  it("rewinds and re-reads after a rewritten ledger without duplicating events", async () => {
    const s = setup();
    s.answers.set("main", () => delta([LINE("a")]));
    await s.poller.readNow("main");
    const answers = [
      report({
        ledger: {
          status: "continuity-broken",
          to_offset: 0,
          to_prefix_sha256: "-",
          more: false,
          lines: [],
        },
      }),
      delta([LINE("a"), LINE("z")], { to_offset: 20, to_prefix_sha256: "s2" }),
    ];
    s.answers.set("main", () => answers.shift() as CommandResult);
    await s.poller.readNow("main");
    expect(s.calls.map(feedOf)).toEqual(["main 0 -", "main 10 s1", "main 0 -"]);
    expect(s.journal.events).toHaveLength(2);
    expect(s.offsets.get("main")).toEqual({ offset: 20, sha: "s2" });
  });
});

describe("failures", () => {
  it("keeps the last report and records the error of a failed read", async () => {
    const s = setup();
    await s.poller.readNow("main");
    s.answers.set("main", () => ({ code: 1, stdout: "", stderr: `  ${"e".repeat(500)}  ` }));
    expect(await s.poller.readNow("main")).toBe(false);
    const [main] = s.poller.snapshots();
    expect(main?.report).not.toBeNull();
    expect(main?.error).toBe("e".repeat(400));
    expect(main?.version).toBe("same");
    s.answers.set("main", () => ({ code: null, stdout: "", stderr: "" }));
    await s.poller.readNow("main");
    expect(s.poller.snapshots()[0]?.error).toBe("讀取失敗");
    s.answers.delete("main");
    expect(await s.poller.readNow("main")).toBe(true);
    expect(s.poller.snapshots()[0]?.error).toBeNull();
  });

  it("drops the data of a home whose feed exits 4, with its first stderr line as the reason", async () => {
    const s = setup();
    s.answers.set("main", () => report({ secondmates: SECONDMATES }));
    await s.poller.refreshAll();
    s.answers.set("far1", () => ({ code: 4, stdout: "", stderr: "far1 is offline\nmore\n" }));
    s.answers.set("sm1", () => ({ code: 4, stdout: "", stderr: "" }));
    await s.poller.refreshAll();
    const state = Object.fromEntries(
      s.poller.snapshots().map((home) => [home.id, [home.version, home.report, home.error]]),
    );
    expect(state["far1"]).toEqual(["unreported", null, "far1 is offline"]);
    expect(state["sm1"]).toEqual(["unreported", null, "這個 home 現在無法回報"]);
    expect(state["main"]?.[0]).toBe("same");
    s.answers.clear();
    s.answers.set("main", () => report({ secondmates: SECONDMATES }));
    await s.poller.refreshAll();
    expect(s.poller.snapshots().find((home) => home.id === "far1")).toMatchObject({
      version: "same",
      error: null,
    });
    s.answers.set("far1", () => ({ code: 255, stdout: "", stderr: "ssh: connection refused" }));
    await s.poller.readNow("far1");
    expect(s.poller.snapshots().find((home) => home.id === "far1")).toMatchObject({
      version: "same",
      error: "ssh: connection refused",
    });
  });

  it("does not use output of another schema or output that is not a report", async () => {
    const s = setup();
    await s.poller.readNow("main");
    s.answers.set("main", () => report({ schema: 2, secondmates: SECONDMATES }));
    const callsBefore = s.calls.length;
    expect(await s.poller.readNow("main")).toBe(false);
    expect(s.calls).toHaveLength(callsBefore + 1);
    expect(s.poller.snapshots()[0]).toMatchObject({
      report: null,
      version: "incompatible",
      error: "讀到的資料版本和看板不相容",
    });
    s.answers.set("main", () => report());
    await s.poller.readNow("main");
    s.answers.set("main", () => ({ code: 0, stdout: "not json", stderr: "" }));
    const callsBeforeInvalid = s.calls.length;
    expect(await s.poller.readNow("main")).toBe(false);
    expect(s.calls).toHaveLength(callsBeforeInvalid + 1);
    const [main] = s.poller.snapshots();
    expect(main).toMatchObject({ version: "same", error: "讀到的資料不是合法的 JSON" });
    expect(main?.report).not.toBeNull();
  });
});

describe("a main home that stops being usable", () => {
  it("leaves other homes' versions unknown instead of failing", async () => {
    const s = setup();
    s.answers.set("main", () => report({ secondmates: SECONDMATES }));
    await s.poller.refreshAll();
    s.answers.set("main", () => report({ schema: 2 }));
    await s.poller.readNow("main");
    expect(await s.poller.readNow("sm1")).toBe(true);
    expect(s.poller.snapshots().find((home) => home.id === "sm1")?.version).toBe("unknown");
    expect(s.poller.hasMainReport()).toBe(false);
  });
});

describe("change notices", () => {
  it("reports a change only when something a viewer sees changed", async () => {
    const s = setup();
    await s.poller.readNow("main");
    await s.poller.readNow("main");
    await s.poller.readNow("main");
    expect(s.changes()).toBe(1);
    s.answers.set("main", () => report({ tasks: [{ id: "t", kind: "ship", state: "working" }] }));
    await s.poller.readNow("main");
    expect(s.changes()).toBe(2);
    s.answers.set("main", () => ({ code: 1, stdout: "", stderr: "boom" }));
    await s.poller.readNow("main");
    await s.poller.readNow("main");
    expect(s.changes()).toBe(3);
    s.answers.set("main", () =>
      report({
        tasks: [{ id: "t", kind: "ship", state: "working" }],
        ledger: {
          status: "delta",
          to_offset: 3,
          to_prefix_sha256: "s",
          more: false,
          lines: [LINE("t")],
        },
      }),
    );
    await s.poller.readNow("main");
    expect(s.changes()).toBe(4);
    s.answers.set("main", () =>
      report({
        tasks: [{ id: "t", kind: "ship", state: "working" }],
        ledger: {
          status: "delta",
          to_offset: 9,
          to_prefix_sha256: "s9",
          more: false,
          lines: [LINE("t")],
        },
      }),
    );
    await s.poller.readNow("main");
    expect(s.changes()).toBe(4);
  });
});

describe("scheduling", () => {
  it("joins a read in flight, and readFresh starts a new one after it", async () => {
    const s = setup();
    let release: (result: CommandResult) => void = () => undefined;
    s.answers.set("main", () => new Promise<CommandResult>((resolve) => (release = resolve)));
    const first = s.poller.readNow("main");
    const joined = s.poller.readNow("main");
    const fresh = s.poller.readFresh("main");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(s.calls).toHaveLength(1);
    s.answers.set("main", () => report());
    release({ code: 1, stdout: "", stderr: "old read failed" });
    expect(await first).toBe(false);
    expect(await joined).toBe(false);
    expect(await fresh).toBe(true);
    expect(s.calls).toHaveLength(2);
    expect(await s.poller.readFresh("nobody")).toBe(false);
  });

  it("polls every home on its interval while someone is viewing, then stops", async () => {
    const s = setup();
    s.answers.set("main", () => report({ secondmates: SECONDMATES }));
    s.poller.touch();
    expect(s.poller.active).toBe(true);
    await vi.waitFor(
      () => expect(new Set(s.calls.map(feedOf).map((line) => line.split(" ")[0])).size).toBe(3),
      {
        timeout: 2000,
      },
    );
    const early = s.calls.filter((call) => feedOf(call).startsWith("main ")).length;
    expect(early).toBeLessThanOrEqual(3);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(s.poller.active).toBe(false);
    const settled = s.calls.length;
    expect(s.calls.filter((call) => feedOf(call).startsWith("main ")).length).toBeGreaterThan(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(s.calls).toHaveLength(settled);
    s.poller.touch();
    await vi.waitFor(() => expect(s.calls.length).toBeGreaterThan(settled), { timeout: 2000 });
  });

  it("never reads one home twice at once", async () => {
    const s = setup({ ...TIMINGS, readMs: 1, idleMs: 900 });
    let running = 0;
    let peak = 0;
    s.answers.set("main", async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 60));
      running -= 1;
      return report();
    });
    s.poller.touch();
    await new Promise((resolve) => setTimeout(resolve, 800));
    s.poller.stop();
    expect(peak).toBe(1);
    expect(s.calls.length).toBeGreaterThan(1);
  });

  it("waits a whole interval between two reads of a home", async () => {
    const s = setup({ ...TIMINGS, readMs: 5000, idleMs: 900 });
    s.poller.touch();
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(s.calls).toHaveLength(1);
  });

  it("is active until exactly the idle limit after the last viewer", () => {
    const s = setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_000_000);
      s.poller.touch();
      s.poller.stop();
      vi.setSystemTime(1_000_000 + TIMINGS.idleMs - 1);
      expect(s.poller.active).toBe(true);
      vi.setSystemTime(1_000_000 + TIMINGS.idleMs);
      expect(s.poller.active).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling on stop", async () => {
    const s = setup();
    s.poller.touch();
    s.poller.stop();
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(s.calls).toHaveLength(0);
  });
});

describe("reading with nobody looking", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const count = (s: Setup, home: string): number =>
    s.calls.filter((call) => feedOf(call).startsWith(`${home} `)).length;

  it("reads each home 15 minutes after its last read, and a home hinted slower than the default hourly", async () => {
    const s = setup();
    s.answers.set("main", () =>
      report({ secondmates: [{ id: "near" }, { id: "far", read_every_s: 60 }] }),
    );
    s.poller.start();
    await vi.advanceTimersByTimeAsync(899_999);
    expect(s.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(count(s, "main")).toBe(1);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect([count(s, "main"), count(s, "near"), count(s, "far")]).toEqual([5, 4, 1]);
    expect(s.poller.active).toBe(false);
  });

  it("goes back to every home's own interval once someone looks, and to the slow one after", async () => {
    const s = setup();
    s.poller.start();
    s.poller.touch();
    // Someone looks for 600 ms: reads at the 250 ms ticks, the last one at 500 ms.
    await vi.advanceTimersByTimeAsync(TIMINGS.idleMs - 1);
    expect(count(s, "main")).toBe(2);
    // Nobody looks: the next read is 900 s after that one, at the next slow tick (every 15 s from 750 ms).
    await vi.advanceTimersByTimeAsync(900_600 - (TIMINGS.idleMs - 1));
    expect(count(s, "main")).toBe(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(count(s, "main")).toBe(3);
  });

  it("reads hourly only a home hinted slower than the default", async () => {
    const s = setup({ ...TIMINGS, readMs: 2000 });
    s.answers.set("main", () =>
      report({
        secondmates: [
          { id: "faster", read_every_s: 1 },
          { id: "same", read_every_s: 2 },
          { id: "slower", read_every_s: 3 },
        ],
      }),
    );
    await s.poller.readNow("main");
    expect(s.poller.snapshots().map((home) => [home.id, home.staleAfterMs])).toEqual([
      ["main", 1_800_000],
      ["faster", 1_800_000],
      ["same", 1_800_000],
      ["slower", 7_200_000],
    ]);
  });

  it("counts a read the feed could not start as not good", async () => {
    const s = setup();
    s.answers.set("main", () => ({ code: null, stdout: "", stderr: "", blocked: "not confirmed" }));
    expect(await s.poller.readNow("main")).toBe(false);
    expect(s.poller.goodReadsFrom()).toEqual(new Map());
  });

  it("reads nothing once stopped, and reads again once started again", async () => {
    const s = setup({ ...TIMINGS, slowMs: 1 });
    s.poller.start();
    s.poller.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.calls).toHaveLength(0);
    s.poller.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(s.calls.length).toBeGreaterThan(0);
  });

  it("knows when each home's last good read began, and keeps it through a failed one", async () => {
    const s = setup();
    expect(s.poller.goodReadsFrom()).toEqual(new Map());
    const start = Date.now();
    await s.poller.readNow("main");
    expect(s.poller.goodReadsFrom()).toEqual(new Map([["main", start]]));
    expect(s.started).toEqual([Math.floor(start / 1000)]);
    vi.setSystemTime(start + 5000);
    s.answers.set("main", () => ({ code: 1, stdout: "", stderr: "down" }));
    await s.poller.readNow("main");
    expect(s.poller.goodReadsFrom()).toEqual(new Map([["main", start]]));
  });

  it("counts a read as fresh for twice the slow interval with nobody looking, the stale limit otherwise", async () => {
    const s = setup();
    s.answers.set("main", () => report({ secondmates: [{ id: "far", read_every_s: 60 }] }));
    await s.poller.readNow("main");
    const limits = (): number[] => s.poller.snapshots().map((home) => home.staleAfterMs ?? 0);
    expect(limits()).toEqual([1_800_000, 7_200_000]);
    s.poller.touch();
    expect(limits()).toEqual([TIMINGS.staleMs, TIMINGS.staleMs]);
  });
});

describe("read hints", () => {
  it("reads a home at its hinted interval and every home without one at the default", async () => {
    const s = setup({ ...TIMINGS, readMs: 100, idleMs: 5000 });
    s.answers.set("main", () =>
      report({ secondmates: [{ id: "a", read_every_s: 1 }, { id: "b" }] }),
    );
    s.poller.touch();
    await new Promise((resolve) => setTimeout(resolve, 2600));
    s.poller.stop();
    const count = (home: string): number =>
      s.calls.filter((call) => feedOf(call).startsWith(`${home} `)).length;
    expect(count("a")).toBeGreaterThanOrEqual(2);
    expect(count("a")).toBeLessThanOrEqual(3);
    expect(count("b")).toBeGreaterThanOrEqual(6);
  });
});

describe("the topics call", () => {
  /** A feed that answers the topics call with `answer` and every read with a report. */
  function topicsFeed(answer: CommandResult): (command: AllowedCommand) => CommandResult {
    return (command) =>
      command.kind === "topics" ? answer : report({ topics: { t1: "old 2026-01-01T00:00:00Z" } });
  }
  const topicsCalls = (s: Setup): string[] =>
    s.calls
      .map(({ command }) => command)
      .filter((command) => command.kind === "topics")
      .map((command) =>
        command.kind === "topics" ? `${command.home} ${command.tasks.join(" ")}` : "",
      );

  it("returns the tags of the tasks asked for and leaves what the board knows untouched", async () => {
    const s = setup();
    const stdout = JSON.stringify({
      topics: { t1: "a 2026-01-01T00:00:00Z\nb 2026-01-02T00:00:00Z", other: "x" },
    });
    s.answers.set("main", topicsFeed({ code: 0, stdout, stderr: "" }));
    await s.poller.readNow("main");
    const before = JSON.stringify(s.poller.snapshots());
    const changes = s.changes();
    expect(await s.poller.readTopics("main", ["t1", "t2"])).toEqual({
      t1: "a 2026-01-01T00:00:00Z\nb 2026-01-02T00:00:00Z",
    });
    expect(s.calls.at(-1)).toEqual({
      command: { kind: "topics", home: "main", tasks: ["t1", "t2"] },
      timeout: 111,
    });
    expect(JSON.stringify(s.poller.snapshots())).toBe(before);
    expect(s.changes()).toBe(changes);
  });

  it("treats task ids that name object properties like any other", async () => {
    const s = setup();
    const stdout = '{"topics":{"__proto__":"a 2026-01-01T00:00:00Z"}}';
    s.answers.set("main", topicsFeed({ code: 0, stdout, stderr: "" }));
    const tags = await s.poller.readTopics("main", ["__proto__"]);
    expect(tags !== null && Object.hasOwn(tags, "__proto__")).toBe(true);
    s.answers.set("main", topicsFeed({ code: 0, stdout: '{"topics":{}}', stderr: "" }));
    expect(await s.poller.readTopics("main", ["toString", "constructor"])).toEqual({});
  });

  it("gives null for a failure or output not of the shape, and asks again next time", async () => {
    const s = setup();
    const failures: CommandResult[] = [
      { code: 1, stdout: "", stderr: "broken" },
      { code: null, stdout: "", stderr: "killed" },
      { code: 4, stdout: "", stderr: "cannot report" },
      { code: 0, stdout: "not json", stderr: "" },
      { code: 0, stdout: "[]", stderr: "" },
      { code: 0, stdout: '{"tags":{}}', stderr: "" },
      { code: 0, stdout: '{"topics":["t1"]}', stderr: "" },
      { code: 0, stdout: '{"topics":{"t1":3}}', stderr: "" },
    ];
    for (const failure of failures) {
      s.answers.set("main", topicsFeed(failure));
      expect(await s.poller.readTopics("main", ["t1"])).toBeNull();
    }
    expect(topicsCalls(s)).toHaveLength(failures.length);
    expect(s.poller.snapshots()[0]).toMatchObject({ error: null, report: null });
  });

  it("stops asking a home whose feed refuses the call (exit 2) until it reports other code", async () => {
    const s = setup();
    s.answers.set("main", () => report({ secondmates: [{ id: "sm1" }] }));
    await s.poller.readNow("main");
    s.answers.set("sm1", topicsFeed({ code: 2, stdout: "", stderr: "feed or deliver" }));
    expect(await s.poller.readTopics("sm1", ["t1"])).toBeNull();
    expect(await s.poller.readTopics("sm1", ["t1"])).toBeNull();
    expect(topicsCalls(s)).toEqual(["sm1 t1"]);
    expect(s.poller.snapshots().find((home) => home.id === "sm1")?.error).toBeNull();
    await s.poller.readNow("sm1");
    await s.poller.readNow("sm1");
    expect(await s.poller.readTopics("sm1", ["t1"])).toBeNull();
    expect(topicsCalls(s)).toEqual(["sm1 t1"]);
    s.answers.set("sm1", (command) =>
      command.kind === "topics"
        ? { code: 0, stdout: '{"topics":{}}', stderr: "" }
        : report({ code_commit: "c2" }),
    );
    await s.poller.readNow("sm1");
    expect(await s.poller.readTopics("sm1", ["t1"])).toEqual({});
    expect(topicsCalls(s)).toEqual(["sm1 t1", "sm1 t1"]);
    expect(await s.poller.readTopics("main", ["t1"])).toEqual({});
  });

  it("runs nothing for an unknown home or while the feed may not run", async () => {
    const s = setup();
    expect(await s.poller.readTopics("nobody", ["t1"])).toBeNull();
    const blocked = setup(TIMINGS, "要先在頁面上確認");
    expect(await blocked.poller.readTopics("main", ["t1"])).toBeNull();
    expect([...s.calls, ...blocked.calls]).toEqual([]);
  });
});

describe("the topics call's turn", () => {
  const TOPICS_OK: CommandResult = { code: 0, stdout: '{"topics":{}}', stderr: "" };

  /** A feed whose every call waits until the test lets it answer, logging when each starts and ends. */
  function heldFeed(s: Setup) {
    const log: string[] = [];
    const held: { name: string; finish: (result?: CommandResult) => void }[] = [];
    const answer = (command: AllowedCommand): Promise<CommandResult> => {
      const name = command.kind === "deliver" ? "deliver" : `${command.kind} ${command.home}`;
      log.push(`start ${name}`);
      return new Promise((resolve) => {
        held.push({
          name,
          finish: (result) => {
            log.push(`end ${name}`);
            resolve(result ?? (command.kind === "topics" ? TOPICS_OK : report(SM_LIST)));
          },
        });
      });
    };
    for (const home of ["main", "sm1", "far1"]) s.answers.set(home, answer);
    /** Lets the oldest held call named `name` answer, then lets the poller react. */
    const finish = async (name: string, result?: CommandResult): Promise<void> => {
      const index = held.findIndex((call) => call.name === name);
      if (index < 0) throw new Error(`no held call: ${name}; held: ${held.map((c) => c.name)}`);
      const [call] = held.splice(index, 1);
      call?.finish(result);
      await settle();
    };
    return { log, held, finish };
  }
  const SM_LIST = { secondmates: SECONDMATES };
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  /** A poller that knows sm1 and far1, every later call held. */
  async function knowingSetup() {
    const s = setup();
    s.answers.set("main", () => report(SM_LIST));
    await s.poller.readNow("main");
    s.calls.length = 0;
    return { s, feed: heldFeed(s) };
  }

  it("waits out a read of the same home before it starts", async () => {
    const { s, feed } = await knowingSetup();
    const read = s.poller.readNow("sm1");
    const topics = s.poller.readTopics("sm1", ["t1"]);
    await settle();
    expect(feed.log).toEqual(["start feed sm1"]);
    await feed.finish("feed sm1");
    expect(await read).toBe(true);
    expect(feed.log).toEqual(["start feed sm1", "end feed sm1", "start topics sm1"]);
    await feed.finish("topics sm1");
    expect(await topics).toEqual({});
  });

  it("holds off a read of the same home until it ends, and not a read of another home", async () => {
    const { s, feed } = await knowingSetup();
    const topics = s.poller.readTopics("sm1", ["t1"]);
    await settle();
    const own = s.poller.readNow("sm1");
    const other = s.poller.readNow("far1");
    await settle();
    expect(feed.log).toEqual(["start topics sm1", "start feed far1"]);
    await feed.finish("topics sm1");
    expect(await topics).toEqual({});
    expect(feed.log.slice(2)).toEqual(["end topics sm1", "start feed sm1"]);
    await feed.finish("feed sm1");
    await feed.finish("feed far1");
    expect(await own).toBe(true);
    expect(await other).toBe(true);
  });

  it(`runs at most ${MAX_TOPICS_CALLS} calls at once and starts a waiting one when a call fails`, async () => {
    const { s, feed } = await knowingSetup();
    const homes = ["main", "sm1", "far1"];
    expect(homes.length).toBeGreaterThan(MAX_TOPICS_CALLS);
    const answers = homes.map((home) => s.poller.readTopics(home, ["t1"]));
    await settle();
    expect(feed.held.map((call) => call.name)).toEqual(
      homes.slice(0, MAX_TOPICS_CALLS).map((home) => `topics ${home}`),
    );
    await feed.finish("topics main", { code: 1, stdout: "", stderr: "broken" });
    expect(await answers[0]).toBeNull();
    expect(feed.held.map((call) => call.name)).toEqual(["topics sm1", "topics far1"]);
    await feed.finish("topics sm1");
    await feed.finish("topics far1");
    expect(await Promise.all(answers)).toEqual([null, {}, {}]);
  });

  it("runs nothing once its home's feed refused the call while it waited", async () => {
    const { s, feed } = await knowingSetup();
    const first = s.poller.readTopics("sm1", ["t1"]);
    const second = s.poller.readTopics("sm1", ["t2"]);
    const third = s.poller.readTopics("sm1", ["t3"]);
    await settle();
    await feed.finish("topics sm1", { code: 2, stdout: "", stderr: "feed or deliver" });
    await feed.finish("topics sm1", { code: 2, stdout: "", stderr: "feed or deliver" });
    expect(await Promise.all([first, second, third])).toEqual([null, null, null]);
    expect(feed.log.filter((line) => line.startsWith("start"))).toHaveLength(MAX_TOPICS_CALLS);
  });

  describe("with a deadline", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("runs nothing when it could not start before the deadline", async () => {
      const { s, feed } = await knowingSetup();
      vi.useFakeTimers({ toFake: ["Date"] });
      const read = s.poller.readNow("sm1");
      const topics = s.poller.readTopics("sm1", ["t1"], Date.now() + 100);
      await settle();
      vi.advanceTimersByTime(100);
      await feed.finish("feed sm1");
      await read;
      expect(await topics).toBeNull();
      expect(feed.log).toEqual(["start feed sm1", "end feed sm1"]);
    });

    it("starts before the deadline when the read ends in time", async () => {
      const { s, feed } = await knowingSetup();
      vi.useFakeTimers({ toFake: ["Date"] });
      const read = s.poller.readNow("sm1");
      const topics = s.poller.readTopics("sm1", ["t1"], Date.now() + 100);
      await settle();
      vi.advanceTimersByTime(99);
      await feed.finish("feed sm1");
      await read;
      await feed.finish("topics sm1");
      expect(await topics).toEqual({});
    });
  });
});
