// Step 6 of the plan: the guarded hashtag operation. Against scratch board
// homes and the fake board command; nothing reaches a board service.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { BoardCommand } from "./commands.js";
import { removeHomes, writeHome } from "./fixtures.test-helper.js";
import { ENV, FakeCommands } from "./harness.test-helper.js";
import { HASHTAG_REASON, hashtagChangesInLastHour, hashtagKey, Tagger } from "./hashtags.js";

afterAll(removeHomes);

const COMMAND = "/opt/board/bin/myshape.sh";
const NOW_MS = Date.parse("2026-11-27T02:00:00Z");
const NOW = NOW_MS / 1000;

interface Setup {
  settings?: Record<string, unknown>;
  tags?: Record<string, string[]>;
  hashtags?: Record<string, { key: string; locked?: boolean }>;
  events?: object[];
  merged?: Record<string, string>;
}

function setUp(setup: Setup = {}) {
  const home = writeHome({
    topics: {
      topics: { gpu: { name: "GPU 叢集", goal: "g", created_at: "" } },
      queues: { high: [], normal: ["gpu"], later: [] },
      merged: setup.merged ?? {},
    },
    hashtags: {
      v: 1,
      hashtags: setup.hashtags ?? {},
      topics: setup.tags ?? {},
      settings: setup.settings ?? {},
    },
  });
  if (setup.events !== undefined) {
    const lines = setup.events.map((event) => JSON.stringify(event)).join("\n");
    writeFileSync(join(home, "data", "myshape", "events.jsonl"), `${lines}\n`);
  }
  const commands = new FakeCommands(COMMAND);
  const tagger = new Tagger(home, new BoardCommand(commands.run, COMMAND, home, ENV), () => NOW_MS);
  const sent = () => commands.calls.map((call) => [...call.args]);
  return { home, tagger, sent };
}

function changes(count: number, extra: Record<string, unknown> = {}): object[] {
  return Array.from({ length: count }, (_, n) => ({
    src: "board",
    rid: `r-${n}`,
    ts: NOW - 60,
    kind: n % 2 === 0 ? "hashtag.added" : "hashtag.removed",
    by: "aggregator",
    topic: "gpu",
    ...extra,
  }));
}

describe("the guarded hashtag operation", () => {
  it("puts a hashtag on through myshape.sh hashtag when every guard allows it", async () => {
    const { tagger, sent } = setUp();
    expect(await tagger.change("gpu", "add", "#AI_INFRA")).toEqual({ sent: true });
    expect(sent()).toEqual([["hashtag", "gpu", "+AI_INFRA"]]);
  });

  it("takes one off with --remove", async () => {
    const { tagger, sent } = setUp({
      tags: { gpu: ["AI_INFRA"] },
      hashtags: { AI_INFRA: { key: "ai_infra" } },
    });
    expect(await tagger.change("gpu", "remove", "ai_infra")).toEqual({ sent: true });
    expect(sent()).toEqual([["hashtag", "gpu", "--remove", "ai_infra"]]);
  });

  it("sends nothing when the captain turned aggregator_may_tag off", async () => {
    const { tagger, sent } = setUp({ settings: { aggregator_may_tag: false } });
    expect(await tagger.change("gpu", "add", "AI_INFRA")).toEqual({
      sent: false,
      reason: HASHTAG_REASON.mayTag,
    });
    expect(await tagger.change("gpu", "remove", "AI_INFRA")).toMatchObject({ sent: false });
    expect(sent()).toEqual([]);
  });

  it("sends nothing for a locked hashtag, whatever its spelling", async () => {
    const { tagger, sent } = setUp({ hashtags: { AI_INFRA: { key: "ai_infra", locked: true } } });
    expect(await tagger.change("gpu", "add", "ＡＩ_infra")).toEqual({
      sent: false,
      reason: HASHTAG_REASON.locked("ＡＩ_infra"),
    });
    expect(sent()).toEqual([]);
  });

  it("keeps to the hourly cap, counting only the aggregator's changes of the last hour", async () => {
    const old = changes(30, { ts: NOW - 3600 });
    const captain = changes(30, { by: "captain" });
    const full = setUp({ events: [...old, ...captain, ...changes(20)] });
    expect(await full.tagger.change("gpu", "add", "X")).toEqual({
      sent: false,
      reason: HASHTAG_REASON.hourly(20, 20),
    });
    expect(full.sent()).toEqual([]);

    const room = setUp({ events: [...old, ...captain, ...changes(19)] });
    expect(await room.tagger.change("gpu", "add", "X")).toEqual({ sent: true });

    const lower = setUp({ events: changes(3), settings: { aggregator_hourly_max: 3 } });
    expect(await lower.tagger.change("gpu", "add", "X")).toMatchObject({ sent: false });
    const zero = setUp({ settings: { aggregator_hourly_max: 0 } });
    expect(await zero.tagger.change("gpu", "add", "X")).toMatchObject({ sent: false });
  });

  it("keeps to the per-topic cap, counting hashtags left on ids merged into the topic", async () => {
    const names = ["A", "B", "C"];
    const { tagger, sent } = setUp({
      settings: { per_topic_max: 3 },
      tags: { gpu: ["A", "B"], old: ["C"] },
      merged: { old: "gpu" },
      hashtags: Object.fromEntries(names.map((name) => [name, { key: hashtagKey(name) }])),
    });
    expect(await tagger.change("gpu", "add", "D")).toEqual({
      sent: false,
      reason: HASHTAG_REASON.perTopic(3),
    });
    expect(sent()).toEqual([]);
  });

  it("opens no new hashtag past board_max or with aggregator_may_create off, but uses one that exists", async () => {
    const hashtags = { A: { key: "a" }, B: { key: "b" } };
    const full = setUp({ settings: { board_max: 2 }, hashtags });
    expect(await full.tagger.change("gpu", "add", "C")).toEqual({
      sent: false,
      reason: HASHTAG_REASON.boardMax(2),
    });
    expect(await full.tagger.change("gpu", "add", "a")).toEqual({ sent: true });

    const closed = setUp({ settings: { aggregator_may_create: false }, hashtags });
    expect(await closed.tagger.change("gpu", "add", "C")).toEqual({
      sent: false,
      reason: HASHTAG_REASON.mayCreate("C"),
    });
    expect(await closed.tagger.change("gpu", "add", "B")).toEqual({ sent: true });
  });

  it("sends nothing when the topic already is that way", async () => {
    const { tagger, sent } = setUp({ tags: { gpu: ["A"] }, hashtags: { A: { key: "a" } } });
    expect(await tagger.change("gpu", "add", "a")).toEqual({
      sent: false,
      reason: HASHTAG_REASON.already("a"),
    });
    expect(await tagger.change("gpu", "remove", "B")).toEqual({
      sent: false,
      reason: HASHTAG_REASON.absent("B"),
    });
    expect(sent()).toEqual([]);
  });

  it.each(["", "a b", "x".repeat(33), "--all", "a|b", "+x"])(
    "refuses the name %j",
    async (name) => {
      const { tagger, sent } = setUp();
      expect(await tagger.change("gpu", "add", name)).toMatchObject({ sent: false });
      expect(sent()).toEqual([]);
    },
  );

  it("takes Chinese and combining marks, as the board does", async () => {
    const { tagger, sent } = setUp();
    expect(await tagger.change("gpu", "add", "基礎設施_é")).toEqual({ sent: true });
    expect(sent()).toEqual([["hashtag", "gpu", "+基礎設施_é"]]);
  });

  it("follows a merged topic id, and refuses a topic not on the board", async () => {
    const { tagger, sent } = setUp({ merged: { old: "gpu" } });
    expect(await tagger.change("old", "add", "X")).toEqual({ sent: true });
    expect(await tagger.change("gone", "add", "X")).toEqual({
      sent: false,
      reason: HASHTAG_REASON.topic("gone"),
    });
    expect(sent()).toEqual([["hashtag", "gpu", "+X"]]);
  });

  it("reports the board's refusal", async () => {
    const { home } = setUp();
    const commands = new FakeCommands(COMMAND);
    commands.summaryStatus = 1;
    const tagger = new Tagger(
      home,
      new BoardCommand(commands.run, COMMAND, home, ENV),
      () => NOW_MS,
    );
    expect(await tagger.change("gpu", "add", "X")).toEqual({
      sent: false,
      reason: "myshape.sh hashtag exited 1: refused",
    });
  });
});

describe("hashtagChangesInLastHour", () => {
  it("counts nothing in a home with no events file, and skips lines that are not JSON", () => {
    const { home } = setUp();
    expect(hashtagChangesInLastHour(home, NOW)).toBe(0);
    writeFileSync(
      join(home, "data", "myshape", "events.jsonl"),
      `{"kind":"hashtag.\n${JSON.stringify(changes(1)[0])}\n`,
    );
    expect(hashtagChangesInLastHour(home, NOW)).toBe(1);
  });
});
