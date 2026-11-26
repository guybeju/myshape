import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AllowedCommand, CommandResult } from "./commands.js";
import { Journal, Offsets } from "./journal.js";
import { boardPaths } from "./layout.js";
import {
  LOOKUP_MARGIN_MS,
  LOOKUP_WAIT_MS,
  findTasks,
  freshTags,
  knowHomes,
  lookupDeadline,
  reminderPrefix,
} from "./lookup.js";
import { DEFAULT_TIMINGS, Poller } from "./poller.js";
import { REQUEST_TIMEOUT_MS } from "./protocol.js";
import { emptyState } from "./topics.js";
import type { TopicState } from "./topics.js";

const LOGIN = "login 2026-07-01T00:00:00Z";
const BILLING = "billing 2026-07-02T00:00:00Z";

/** A command's result, given after `delayMs` when set. */
type Delayed = CommandResult & { delayMs?: number };
/** What a home's feed does with one command. */
type Answer = (command: AllowedCommand) => Delayed;

interface Setup {
  poller: Poller;
  /** "<kind> <home>" of every command run, in order. */
  runs: string[];
  answers: Map<string, Answer>;
  topics: TopicState;
}

let dir: string;
let pollers: Poller[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-lookup-"));
  pollers = [];
});
afterEach(() => {
  for (const poller of pollers) poller.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

function reportOf(topics: Record<string, string>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: 1,
    code_commit: "c1",
    tasks: [],
    holds: [],
    status_decisions: [],
    topics,
    ledger: { status: "absent", to_offset: 0, to_prefix_sha256: "-", more: false, lines: [] },
    secondmates: [],
    ...extra,
  });
}

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });
const topicsAnswer = (topics: Record<string, string>): CommandResult =>
  ok(JSON.stringify({ topics }));

/** A feed whose full read reports `read` and whose topics call gives `asked`. */
function feed(read: Record<string, string>, asked: CommandResult, extra = {}): Answer {
  return (command) => (command.kind === "topics" ? asked : ok(reportOf(read, extra)));
}

function setup(): Setup {
  const paths = boardPaths({
    state: path.join(dir, "state"),
    data: path.join(dir, "data"),
    config: path.join(dir, "config"),
  });
  fs.mkdirSync(paths.boardDataDir, { recursive: true });
  const runs: string[] = [];
  const answers = new Map<string, Answer>();
  const poller = new Poller(
    async (command) => {
      const home = command.kind === "deliver" ? "main" : command.home;
      runs.push(`${command.kind} ${home}`);
      const answer: Delayed = answers.get(home)?.(command) ?? ok(reportOf({}));
      const { delayMs, ...result } = answer;
      if (delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return result;
    },
    new Journal(paths.events),
    new Offsets(paths),
    DEFAULT_TIMINGS,
    {
      onChange: () => undefined,
      onAggregator: () => undefined,
      closedCursor: () => null,
      onReport: () => undefined,
      onCursorRefused: () => undefined,
    },
    () => null,
  );
  pollers.push(poller);
  const topics = emptyState();
  const topic = (name: string) => ({
    name,
    goal: "g",
    status: "confirmed" as const,
    created_at: "",
  });
  topics.doc.topics = { login: topic("Login"), billing: topic("Billing") };
  topics.doc.queues = { high: [], normal: ["login", "billing"], later: [] };
  return { poller, runs, answers, topics };
}

function host(s: Setup) {
  return { poller: s.poller, topics: () => s.topics };
}

const far = (): number => lookupDeadline();

describe("the lookup deadline", () => {
  it("ends a margin before myshape.sh stops waiting, from the one request timeout", () => {
    expect(LOOKUP_WAIT_MS).toBe(10_000);
    expect(REQUEST_TIMEOUT_MS - LOOKUP_WAIT_MS).toBe(LOOKUP_MARGIN_MS);
    expect(LOOKUP_MARGIN_MS).toBeGreaterThanOrEqual(1000);
    expect(lookupDeadline(5000)).toBe(5000 + LOOKUP_WAIT_MS);
  });

  it("answers a slow read at the deadline from the last read, or as unknown", async () => {
    const s = setup();
    s.answers.set("main", () => ({ ...ok(reportOf({ t1: LOGIN })), delayMs: 1500 }));
    const started = Date.now();
    expect(await reminderPrefix(host(s), "main", "t1", Date.now() + 200)).toBe("議題不明（t1）：");
    expect(Date.now() - started).toBeLessThan(1000);
    await s.poller.readNow("main");
    expect(await reminderPrefix(host(s), "main", "t1", Date.now() + 200)).toBe("Login：");
  });

  it("is one deadline for a --home lookup's read of the root home and its own read", async () => {
    const s = setup();
    s.answers.set("main", () => ({
      ...ok(reportOf({}, { secondmates: [{ id: "sm1" }] })),
      delayMs: 400,
    }));
    s.answers.set("sm1", () => ({ ...topicsAnswer({ t1: LOGIN }), delayMs: 3000 }));
    const started = Date.now();
    const deadline = started + 600;
    await knowHomes(s.poller, deadline);
    expect(s.poller.knows("sm1")).toBe(true);
    expect(await reminderPrefix(host(s), "sm1", "t1", deadline)).toBe("議題不明（t1）：");
    expect(Date.now() - started).toBeLessThan(900);
  });

  it("starts no read once the deadline has passed", async () => {
    const s = setup();
    await knowHomes(s.poller, Date.now() - 1);
    expect(await reminderPrefix(host(s), "main", "t1", Date.now() - 1)).toBe("議題不明（t1）：");
    expect(s.runs).toEqual([]);
  });
});

describe("which and summary's prefix", () => {
  it("asks the feed for the one task's tag instead of reading the home", async () => {
    const s = setup();
    s.answers.set("main", feed({ t1: LOGIN }, topicsAnswer({ t1: `${LOGIN}\n${BILLING}` })));
    expect(await reminderPrefix(host(s), "main", "t1", far())).toBe("Billing：");
    expect(s.runs).toEqual(["topics main"]);
  });

  it("knows a task the topics call leaves out has no tag, whatever the last read said", async () => {
    const s = setup();
    s.answers.set("main", feed({ t1: LOGIN }, topicsAnswer({})));
    await s.poller.readNow("main");
    expect(await reminderPrefix(host(s), "main", "t1", far())).toBe("未分類：");
  });

  it("reads the whole home when the call fails or prints something else", async () => {
    for (const failed of [
      { code: 1, stdout: "", stderr: "broken" },
      ok("not json"),
      ok('{"topics":{"t1":7}}'),
    ]) {
      const s = setup();
      s.answers.set("main", feed({ t1: LOGIN }, failed));
      expect(await reminderPrefix(host(s), "main", "t1", far())).toBe("Login：");
      expect(s.runs).toEqual(["topics main", "feed main"]);
    }
  });

  it("asks a home that refused the call (exit 2) no more, and keeps reading it whole", async () => {
    const s = setup();
    s.answers.set("main", feed({ t1: LOGIN }, { code: 2, stdout: "", stderr: "feed or deliver" }));
    expect(await reminderPrefix(host(s), "main", "t1", far())).toBe("Login：");
    expect(await reminderPrefix(host(s), "main", "t1", far())).toBe("Login：");
    expect(s.runs).toEqual(["topics main", "feed main", "feed main"]);
  });

  it("answers from a tag seen earlier when no read succeeds, and 議題不明 without one", async () => {
    const s = setup();
    const broken = { code: 1, stdout: "", stderr: "broken" };
    s.answers.set("main", () => broken);
    expect(await reminderPrefix(host(s), "main", "t1", far())).toBe("議題不明（t1）：");
    s.answers.set("main", feed({ t1: LOGIN }, broken));
    await s.poller.readNow("main");
    s.answers.set("main", () => broken);
    expect(await reminderPrefix(host(s), "main", "t1", far())).toBe("Login：");
    expect(await reminderPrefix(host(s), "main", "t2", far())).toBe("議題不明（t2）：");
  });

  it("names a tag of a topic the board does not know as unsorted", async () => {
    const s = setup();
    s.answers.set("main", feed({}, topicsAnswer({ t1: "nope 2026-07-01T00:00:00Z" })));
    expect(await reminderPrefix(host(s), "main", "t1", far())).toBe("未分類：");
  });
});

describe("find <task>", () => {
  it("takes the main home's tag from the topics call and the others' from their last read", async () => {
    const s = setup();
    s.answers.set("sm1", feed({ t1: LOGIN }, topicsAnswer({})));
    s.answers.set("main", (command) =>
      command.kind === "topics"
        ? topicsAnswer({ t1: BILLING })
        : ok(reportOf({ t1: LOGIN }, { secondmates: [{ id: "sm1" }] })),
    );
    await s.poller.refreshAll();
    s.runs.length = 0;
    const found = await findTasks(s.poller, "t1", far());
    expect(
      found.map((entry) => `${entry.home} ${entry.tags.map((tag) => tag.topic).join(",")}`),
    ).toEqual(["main billing", "sm1 login"]);
    expect(s.runs).toEqual(["topics main"]);
  });

  it("drops the main home's old tag when the topics call says it has none, and keeps an empty file", async () => {
    const s = setup();
    s.answers.set("main", feed({ t1: LOGIN }, topicsAnswer({})));
    await s.poller.readNow("main");
    expect(await findTasks(s.poller, "t1", far())).toEqual([]);
    s.answers.set("main", feed({}, topicsAnswer({ t1: "" })));
    expect(await findTasks(s.poller, "t1", far())).toEqual([
      { home: "main", task: "t1", tags: [] },
    ]);
  });

  it("falls back to a full read of the main home, then to its last read", async () => {
    const s = setup();
    s.answers.set("main", feed({ t1: LOGIN }, { code: 2, stdout: "", stderr: "" }));
    expect((await findTasks(s.poller, "t1", far())).map((entry) => entry.home)).toEqual(["main"]);
    expect(s.runs).toEqual(["topics main", "feed main"]);
    s.answers.set("main", () => ({ code: 1, stdout: "", stderr: "broken" }));
    expect((await findTasks(s.poller, "t1", far())).map((entry) => entry.home)).toEqual(["main"]);
  });
});

describe("a page write's re-read of a tag", () => {
  it("gets the tag files from the topics call, else the full read, else null", async () => {
    const s = setup();
    s.answers.set("main", feed({ t1: LOGIN, t2: BILLING }, topicsAnswer({ t1: BILLING })));
    expect(await freshTags(s.poller, "main", "t1")).toEqual({ t1: BILLING });
    s.answers.set("main", feed({ t1: LOGIN }, ok("{}")));
    expect(await freshTags(s.poller, "main", "t1")).toEqual({ t1: LOGIN });
    s.answers.set("main", () => ({ code: 1, stdout: "", stderr: "broken" }));
    expect(await freshTags(s.poller, "main", "t1")).toBeNull();
    expect(await freshTags(s.poller, "nobody", "t1")).toBeNull();
  });

  it("starts no full read once the deadline passed during a failed topics call", async () => {
    const s = setup();
    s.answers.set("main", (command) =>
      command.kind === "topics"
        ? { code: 1, stdout: "", stderr: "broken", delayMs: 60 }
        : ok(reportOf({ t1: LOGIN })),
    );
    expect(await freshTags(s.poller, "main", "t1", Date.now() + 30)).toBeNull();
    expect(s.runs).toEqual(["topics main"]);
  });
});
