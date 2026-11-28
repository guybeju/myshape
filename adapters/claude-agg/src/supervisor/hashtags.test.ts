// Step 6 of the plan: the guarded hashtag operation. Against scratch board
// homes and the fake board command; nothing reaches a board service.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { BoardCommand } from "./commands.js";
import { generator, removeHomes, writeHome } from "./fixtures.test-helper.js";
import { ENV, FakeCommands } from "./harness.test-helper.js";
import { HASHTAG_DEFAULTS, readBoard, type HashtagsFile } from "./board-files.js";
import {
  changeKey,
  EXAMPLE_MAX,
  exampleName,
  HASHTAG_REASON,
  hashtagChangesInLastHour,
  hashtagKey,
  hashtagList,
  LIST_MAX,
  normalizeName,
  PAGE_BY,
  PICK_REASON,
  pickHashtags,
  quoted,
  revertedChanges,
  Tagger,
  type PickSituation,
} from "./hashtags.js";
import type { HashtagAsk } from "./outputs.js";

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

  it("says a name is meant as a new hashtag with --new only when asked to", async () => {
    const { tagger, sent } = setUp();
    expect(await tagger.change("gpu", "add", "GPU", true)).toEqual({ sent: true });
    expect(await tagger.change("gpu", "remove", "GPU", true)).toMatchObject({ sent: false });
    expect(sent()).toEqual([["hashtag", "gpu", "+GPU", "--new"]]);
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

describe("normalizeName", () => {
  it.each([
    ["GPU", "GPU"],
    [" #GPU ", "GPU"],
    ["\u3000#AI_INFRA\u3000", "AI_INFRA"],
    ["AI INFRA", "AI_INFRA"],
    ["ai-infra", "ai_infra"],
    ["a. b/c--d", "a_b_c_d"],
    ["-x-", "x"],
    ["ＧＰＵ", "GPU"],
    ["ＡＩ＿infra", "AI_infra"],
    ["基礎 設施", "基礎_設施"],
    ["x".repeat(32), "x".repeat(32)],
  ])("makes %j the name %j", (raw, name) => {
    expect(normalizeName(raw)).toBe(name);
  });

  it.each(["", "   ", "#", "##GPU", "a+b", "x".repeat(33), "a b".repeat(11), "-- /", "<b>"])(
    "finds no name in %j",
    (raw) => {
      expect(normalizeName(raw)).toBeUndefined();
    },
  );
});

/** A hashtags.json read: these topics' hashtags, these names on the board, these locked. */
function registry(
  topics: Record<string, string[]>,
  names: readonly string[],
  locked: readonly string[] = [],
): HashtagsFile {
  return {
    topics: new Map(Object.entries(topics)),
    keys: new Map(names.map((name) => [name, hashtagKey(name)])),
    locked: new Set(locked.map(hashtagKey)),
    settings: HASHTAG_DEFAULTS,
  };
}

function situation(hashtags: HashtagsFile, extra: Partial<PickSituation> = {}): PickSituation {
  return { hashtags, topic: "gpu", merged: new Map(), reverted: new Set(), ...extra };
}

const listed = (name: string): HashtagAsk => ({ name, change: "listed" });
const fresh = (name: string): HashtagAsk => ({ name, change: "new" });
const remove = (name: string): HashtagAsk => ({ name, change: "remove" });
const add = (name: string, opening = false) => ({ change: "add", name, opening });
const off = (name: string) => ({ change: "remove", name, opening: false });

describe("pickHashtags: putting on", () => {
  const board = registry({}, ["AI_INFRA", "GPU"]);

  it.each([
    ["the same key", "ai_infra"],
    ["the key once normalized", "AI INFRA"],
    ["the key without underscores", "AIINFRA"],
    ["the key of the full-width spelling", "ＡＩ_ＩＮＦＲＡ"],
  ])("uses the board's spelling for %s", (_case, name) => {
    expect(pickHashtags([listed(name)], situation(board))).toEqual({
      send: [add("AI_INFRA")],
      dropped: [],
    });
  });

  it("drops a listed name the board does not have, and opens nothing for it", () => {
    expect(pickHashtags([listed("GPUS")], situation(board))).toEqual({
      send: [],
      dropped: [PICK_REASON.unlisted("GPUS")],
    });
  });

  it("opens a new name with --new, and uses the board's for a new one it has", () => {
    expect(pickHashtags([fresh("#基礎 設施"), fresh("gpu")], situation(board))).toEqual({
      send: [add("基礎_設施", true), add("GPU")],
      dropped: [],
    });
  });

  it("drops a name that matches two once underscores are dropped", () => {
    const two = registry({}, ["A_I_INFRA", "AI_INFRA_"]);
    expect(pickHashtags([fresh("AIINFRA")], situation(two))).toEqual({
      send: [],
      dropped: [PICK_REASON.twoMatches("AIINFRA", ["A_I_INFRA", "AI_INFRA_"])],
    });
  });

  it("prefers the same key to one without underscores", () => {
    const both = registry({}, ["AIINFRA", "AI_INFRA"]);
    expect(pickHashtags([listed("aiinfra")], situation(both)).send).toEqual([add("AIINFRA")]);
  });

  it("drops a locked one, however it is spelled", () => {
    const locked = registry({}, ["URGENT"], ["URGENT"]);
    for (const ask of [listed("urgent"), fresh("ＵＲＧＥＮＴ")]) {
      expect(pickHashtags([ask], situation(locked))).toEqual({
        send: [],
        dropped: [PICK_REASON.locked("URGENT")],
      });
    }
  });

  it("drops a name that is no hashtag name, writing it as a JSON string", () => {
    const evil = "a\u001b[31m\nb";
    const picked = pickHashtags([fresh(evil)], situation(board));
    expect(picked).toEqual({ send: [], dropped: [PICK_REASON.name(evil)] });
    expect(picked.dropped[0]).toContain(String.raw`"a\u001b[31m\nb"`);
  });
});

describe("pickHashtags: taking off", () => {
  it("takes off the topic's own spelling, found by the same key", () => {
    const board = registry({ gpu: ["AI_INFRA"] }, ["AI_INFRA"]);
    expect(pickHashtags([remove("#ai infra")], situation(board))).toEqual({
      send: [off("AI_INFRA")],
      dropped: [],
    });
  });

  it("drops a name whose key differs, even only by underscores", () => {
    const board = registry({ gpu: ["AI_INFRA"] }, ["AI_INFRA", "AIINFRA"]);
    expect(pickHashtags([remove("AIINFRA")], situation(board))).toEqual({
      send: [],
      dropped: [PICK_REASON.notOnTopic("AIINFRA")],
    });
  });

  it("drops one the board has but the topic does not, and one on another topic", () => {
    const board = registry({ other: ["GPU"] }, ["GPU"]);
    expect(pickHashtags([remove("GPU")], situation(board)).send).toEqual([]);
  });

  it("counts a hashtag left on an id merged into the topic", () => {
    const board = registry({ old: ["GPU"] }, ["GPU"]);
    const merged = new Map([["old", "gpu"]]);
    expect(pickHashtags([remove("gpu")], situation(board, { merged })).send).toEqual([off("GPU")]);
  });

  it("drops a locked one", () => {
    const board = registry({ gpu: ["URGENT"] }, ["URGENT"], ["URGENT"]);
    expect(pickHashtags([remove("URGENT")], situation(board))).toEqual({
      send: [],
      dropped: [PICK_REASON.locked("URGENT")],
    });
  });
});

describe("pickHashtags: one plan", () => {
  it("drops both changes of a key asked to go on and come off, and keeps the others", () => {
    const board = registry({ gpu: ["AI_INFRA"] }, ["AI_INFRA", "GPU"]);
    const asks = [listed("AIINFRA"), remove("ai_infra"), listed("GPU")];
    expect(pickHashtags(asks, situation(board))).toEqual({
      send: [add("GPU")],
      dropped: [PICK_REASON.both("AI_INFRA"), PICK_REASON.both("AI_INFRA")],
    });
  });

  it("keeps the planner's order", () => {
    const board = registry({ gpu: ["OLD"] }, ["OLD", "GPU"]);
    expect(pickHashtags([remove("OLD"), fresh("NEW"), listed("gpu")], situation(board))).toEqual({
      send: [off("OLD"), add("NEW", true), add("GPU")],
      dropped: [],
    });
  });

  it("does not make again a change the captain reverted, but makes the other kind", () => {
    const board = registry({ gpu: ["URGENT"] }, ["URGENT"]);
    const reverted = new Set([changeKey("gpu", "urgent", "remove")]);
    expect(pickHashtags([remove("Urgent")], situation(board, { reverted }))).toEqual({
      send: [],
      dropped: [PICK_REASON.reverted("remove", "URGENT")],
    });
    const back = new Set([changeKey("gpu", "urgent", "add")]);
    expect(pickHashtags([remove("URGENT")], situation(board, { reverted: back })).send).toEqual([
      off("URGENT"),
    ]);
    const elsewhere = new Set([changeKey("cpu", "urgent", "remove")]);
    expect(
      pickHashtags([remove("URGENT")], situation(board, { reverted: elsewhere })).send,
    ).toEqual([off("URGENT")]);
  });
});

describe("pickHashtags over random asks", () => {
  const ALPHABET = ["a", "A", "_", " ", "-", "#", "Ａ", "b", "é", "\n", "+", "基"];
  const NAMES = ["a", "A_B", "AB", "a_b_", "基", "b"];

  function word(next: () => number): string {
    const length = 1 + Math.floor(next() * 6);
    return Array.from({ length }, () => ALPHABET[Math.floor(next() * ALPHABET.length)]).join("");
  }

  function board(next: () => number): HashtagsFile {
    const names = NAMES.filter(() => next() < 0.6);
    const on = names.filter(() => next() < 0.5);
    const locked = names.filter(() => next() < 0.2);
    return registry({ gpu: on.slice(0, 2), old: on.slice(2) }, names, locked);
  }

  it("never opens a listed name, sends only names, and takes off only the topic's spellings", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = generator(seed);
      const hashtags = board(next);
      const where = situation(hashtags, { merged: new Map([["old", "gpu"]]) });
      const kinds = ["listed", "new", "remove"] as const;
      const asks = Array.from({ length: 1 + Math.floor(next() * 3) }, () => ({
        name: next() < 0.5 ? word(next) : (NAMES[Math.floor(next() * NAMES.length)] ?? "a"),
        change: kinds[Math.floor(next() * 3)] ?? "new",
      }));
      const picked = pickHashtags(asks, where);
      const carried = [
        ...(hashtags.topics.get("gpu") ?? []),
        ...(hashtags.topics.get("old") ?? []),
      ];
      expect(picked.send.length + picked.dropped.length, `seed ${seed}`).toBe(asks.length);
      for (const send of picked.send) {
        expect(send.name, `seed ${seed}`).toMatch(/^[\p{L}\p{M}\p{N}_]{1,32}$/u);
        if (send.change === "remove") expect(carried, `seed ${seed}`).toContain(send.name);
        if (!send.opening && send.change === "add") expect(hashtags.keys.has(send.name)).toBe(true);
        expect(hashtags.locked.has(hashtagKey(send.name)), `seed ${seed}`).toBe(false);
      }
      for (const ask of asks.filter((entry) => entry.change === "listed")) {
        const alone = pickHashtags([ask], where);
        expect(
          alone.send.every((send) => !send.opening),
          `seed ${seed}`,
        ).toBe(true);
      }
    }
  });
});

describe("revertedChanges", () => {
  const change = (rid: string, kind: string, before: string, after: string, extra = {}) => ({
    src: "board",
    rid,
    ts: NOW - 60,
    kind,
    by: "aggregator",
    topic: "gpu",
    before,
    after,
    ...extra,
  });
  const revert = (rid: string, ref: string, by = PAGE_BY) => ({
    src: "board",
    rid,
    ts: NOW,
    kind: "hashtag.reverted",
    by,
    topic: "gpu",
    ref,
  });

  it("reads the page's reverts of the aggregator's changes: topic, key and kind", () => {
    const { home } = setUp({
      events: [
        change("r1", "hashtag.removed", "URGENT AI_INFRA", "AI_INFRA"),
        change("r2", "hashtag.added", "", "ＧＰＵ Big", { topic: "old" }),
        change("r3", "hashtag.added", "", "KEPT"),
        revert("r4", "r1"),
        revert("r5", "r2"),
      ],
    });
    expect(revertedChanges(home, new Map([["old", "gpu"]]))).toEqual(
      new Set([
        changeKey("gpu", "urgent", "remove"),
        changeKey("gpu", "gpu", "add"),
        changeKey("gpu", "big", "add"),
      ]),
    );
  });

  it("does not count a revert that is not the page's, or one of a change not the aggregator's", () => {
    const { home } = setUp({
      events: [
        change("r1", "hashtag.removed", "URGENT", ""),
        change("r2", "hashtag.added", "", "X", { by: "captain" }),
        change("r3", "hashtag.renamed", "A", "B"),
        revert("r4", "r1", "aggregator"),
        revert("r5", "r2"),
        revert("r6", "r3"),
        revert("r7", "nowhere"),
        { ...revert("r8", "r1"), ref: 7 },
      ],
    });
    expect(revertedChanges(home, new Map())).toEqual(new Set());
  });

  it("holds nothing when there is no events file, and skips lines that are not JSON", () => {
    const { home } = setUp();
    expect(revertedChanges(home, new Map())).toEqual(new Set());
    const lines = [
      '{"kind":"hashtag.',
      "null",
      JSON.stringify(change("r1", "hashtag.removed", "URGENT", "")),
      JSON.stringify(revert("r2", "r1")),
    ];
    writeFileSync(join(home, "data", "myshape", "events.jsonl"), `${lines.join("\n")}\n`);
    expect(revertedChanges(home, new Map())).toEqual(
      new Set([changeKey("gpu", "urgent", "remove")]),
    );
  });
});

describe("the hashtag list the planner is shown", () => {
  function listHome(names: Record<string, string>, tags: Record<string, string[]>, extra = {}) {
    return writeHome({
      topics: {
        topics: Object.fromEntries(
          Object.entries(names).map(([id, name]) => [id, { name, goal: "", created_at: "" }]),
        ),
        merged: { old: "gpu" },
      },
      archive: { topics: { gone: { name: "封存的議題" } } },
      hashtags: {
        v: 1,
        hashtags: { GPU: { key: "gpu" }, AI: { key: "ai", locked: true }, ZERO: { key: "zero" } },
        topics: tags,
        ...extra,
      },
    });
  }

  it("counts live and archived topics, merges followed, with examples from live ones only", () => {
    const home = listHome(
      { gpu: "GPU 叢集", a: "甲", b: "乙", c: "丙" },
      { gpu: ["GPU"], old: ["GPU", "AI"], a: ["GPU"], b: ["GPU", "AI"], c: ["GPU"], gone: ["AI"] },
      { settings: { aggregator_may_create: false, per_topic_max: 4 } },
    );
    expect(hashtagList(readBoard(home))).toEqual({
      hashtags: [
        { name: "GPU", topics: 4, examples: ["甲", "乙", "丙"], locked: false },
        { name: "AI", topics: 3, examples: ["乙", "GPU 叢集"], locked: true },
        { name: "ZERO", topics: 0, examples: [], locked: false },
      ],
      unlisted: 0,
      may_tag: true,
      may_create: false,
      per_topic_max: 4,
    });
  });

  it("lists at most LIST_MAX, most used first, then by key, and counts the rest", () => {
    const names = Array.from({ length: LIST_MAX + 5 }, (_, n) => `T${String(n).padStart(3, "0")}`);
    const home = writeHome({
      topics: { topics: { a: { name: "甲", goal: "", created_at: "" } } },
      hashtags: {
        v: 1,
        hashtags: Object.fromEntries(names.map((name) => [name, { key: name.toLowerCase() }])),
        topics: { a: ["T204"] },
      },
    });
    const list = hashtagList(readBoard(home));
    expect(list.hashtags).toHaveLength(LIST_MAX);
    expect(list.unlisted).toBe(5);
    expect(list.hashtags.slice(0, 3).map((row) => row.name)).toEqual(["T204", "T000", "T001"]);
  });

  it("makes an example one plain line of at most 40 code points", () => {
    expect(exampleName("a\nb\rc\td\u0000e\u007ff\u0085g")).toBe("a b c d e f g");
    expect(exampleName("x\u202ey\u2066z\u200fw\u061cv\u2028u\u2029t")).toBe("x y z w v u t");
    const forty = "議".repeat(EXAMPLE_MAX);
    expect(exampleName(forty)).toBe(forty);
    expect(exampleName(`${forty}題`)).toBe(`${forty}…`);
    expect(exampleName("🙂".repeat(EXAMPLE_MAX))).toBe("🙂".repeat(EXAMPLE_MAX));
    expect([...exampleName("🙂".repeat(EXAMPLE_MAX + 1))]).toHaveLength(EXAMPLE_MAX + 1);
  });
});

describe("quoted", () => {
  it("writes a name as a JSON string with no control or direction character left raw", () => {
    const raw = 'a"\u001b[2J\n\u007f\u0085\u202e\u2028b';
    const line = quoted(raw);
    expect(line).toBe(String.raw`"a\"\u001b[2J\n\u007f\u0085\u202e\u2028b"`);
    expect(JSON.parse(line)).toBe(raw);
  });
});
