import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AllowedCommand, CommandResult } from "./commands.js";
import { Journal, Offsets } from "./journal.js";
import { boardPaths } from "./layout.js";
import { DEFAULT_TIMINGS, Poller } from "./poller.js";
import type { PollTimings } from "./poller.js";

const LINE = (task: string) => JSON.stringify({ v: 1, ts: 5, event: "task.status", task });
const TIMINGS: PollTimings = {
  readMs: 40,
  timeoutMs: 111,
  idleMs: 600,
  staleMs: 1000,
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
  const refused: string[] = [];
  const poller = new Poller(
    async (command, timeout) => {
      calls.push({ command, timeout });
      const home = command.kind === "feed" ? command.home : "main";
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
      onReport: (home, parsed) => reported.push(`${home}:${parsed.closed_holds.length}`),
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
      { id: "main", report: null, lastOkAt: null, error: null, version: "unknown" },
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
    const aggregator = { name: "plain", label: "plain", update_hint: null };
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
