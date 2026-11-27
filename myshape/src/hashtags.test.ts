import { describe, expect, it } from "vitest";
import {
  addHashtags,
  carryMerge,
  carrySplit,
  changeSettings,
  checkName,
  colorHashtag,
  deleteHashtag,
  deleteView,
  emptyHashtags,
  hashtagKey,
  hashtagView,
  lockHashtag,
  markSeen,
  mergeHashtags,
  parseHashtags,
  reconcile,
  removeHashtag,
  renameHashtag,
  revertChange,
  saveView,
} from "./hashtags.js";
import type {
  HashtagContext,
  HashtagEntry,
  HashtagRecord,
  HashtagResult,
  HashtagStore,
} from "./hashtags.js";
import type { Frozen } from "./records.js";
import { emptyState } from "./topics.js";
import type { TopicState } from "./topics.js";

const NOW = "2026-11-26T02:00:00Z";
const NOW_S = Date.parse(NOW) / 1000;

function topicState(): TopicState {
  const state = emptyState();
  const topic = (name: string) => ({
    name,
    goal: "g",
    status: "confirmed" as const,
    created_at: "T",
  });
  state.doc.topics = { a: topic("A"), b: topic("B"), c: topic("C") };
  state.doc.queues = { high: ["a"], normal: ["b", "c"], later: [] };
  state.doc.merged = { old: "a" };
  state.archive.topics = { z: { ...topic("Z"), archived_at: "T" } };
  return state;
}

function ctx(
  store: Frozen<HashtagStore> = emptyHashtags(),
  extra: Partial<HashtagContext> = {},
): HashtagContext {
  return { store, topics: topicState(), by: "aggregator", records: [], now: NOW, ...extra };
}

/** The store after a change that must have been made. */
function after(result: HashtagResult): HashtagStore {
  if (!result.ok || !result.changed) throw new Error(`expected a change, got ${result.line}`);
  return result.store;
}

function tagged(): HashtagStore {
  let store = after(addHashtags(ctx(), "a", ["AI_INFRA", "URGENT"]));
  store = after(addHashtags(ctx(store), "b", ["AI_INFRA"]));
  return store;
}

describe("a hashtag name", () => {
  it("is letters of any script, digits and underscore, 1 to 32 characters", () => {
    expect(checkName("AI_INFRA")).toEqual({ name: "AI_INFRA", key: "ai_infra" });
    expect(checkName(" #基礎設施2 ")).toEqual({ name: "基礎設施2", key: "基礎設施2" });
    expect(checkName("x".repeat(32))).not.toBeTypeOf("string");
    for (const bad of [
      "",
      "#",
      "a-b",
      "a b",
      "x".repeat(33),
      "a.b",
      "<b>",
      "__proto__",
      "constructor",
      "toString",
    ])
      expect(checkName(bad)).toBeTypeOf("string");
  });

  it("is the same hashtag in any case and in full-width forms", () => {
    expect(hashtagKey("AI_INFRA")).toBe(hashtagKey("ai_infra"));
    expect(hashtagKey("ＡＩ＿ＩＮＦＲＡ")).toBe("ai_infra");
  });

  it("keeps the spelling first created when another spelling is put on", () => {
    const store = after(addHashtags(ctx(), "a", ["AI_INFRA"]));
    const again = addHashtags(ctx(store), "a", ["ai_infra", "ＡＩ_INFRA"]);
    expect(again).toMatchObject({ ok: true, changed: false, line: "ok a 本來就有 #AI_INFRA" });
    const other = after(addHashtags(ctx(store), "b", ["ＡＩ_INFRA"]));
    expect(other.topics["b"]).toEqual(["AI_INFRA"]);
    expect(Object.keys(other.hashtags)).toEqual(["AI_INFRA"]);
  });
});

describe("putting hashtags on a topic", () => {
  it("opens a new hashtag on first use and records before and after", () => {
    const result = addHashtags(ctx(), "old", ["AI_INFRA"]);
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      line: "ok a 已貼上 #AI_INFRA（新開的 hashtag：#AI_INFRA）",
      records: [
        { kind: "hashtag.added", topic: "a", before: "", after: "AI_INFRA", outcome: "created" },
      ],
    });
    expect(after(result).hashtags["AI_INFRA"]).toMatchObject({
      key: "ai_infra",
      created_at: NOW,
      created_by: "aggregator",
      locked: false,
    });
  });

  it("refuses a topic that is archived or missing, and a malformed name", () => {
    expect(addHashtags(ctx(), "z", ["X"])).toMatchObject({
      ok: false,
      line: "議題 z 已封存，要先 reopen。",
    });
    expect(addHashtags(ctx(), "nope", ["X"])).toMatchObject({ ok: false });
    expect(addHashtags(ctx(), "a", ["-X"])).toMatchObject({ ok: false });
  });

  it("refuses more than the per-topic maximum, for the captain too", () => {
    const store = {
      ...emptyHashtags(),
      settings: { ...emptyHashtags().settings, per_topic_max: 2 },
    };
    const two = after(addHashtags(ctx(store), "a", ["A1", "A2"]));
    for (const by of ["aggregator", "captain"] as const) {
      const third = addHashtags(ctx(two, { by }), "a", ["A3"]);
      expect(third).toMatchObject({ ok: false });
      expect(!third.ok && third.line).toContain("已經有 2 個 hashtag，上限 2 個");
    }
  });

  it("lets only the captain open a hashtag past the board-wide maximum", () => {
    const base = emptyHashtags();
    const store = after(
      addHashtags(ctx({ ...base, settings: { ...base.settings, board_max: 1 } }), "a", ["ONE"]),
    );
    expect(addHashtags(ctx(store), "b", ["ONE"])).toMatchObject({ ok: true, changed: true });
    const refused = addHashtags(ctx(store), "b", ["TWO"]);
    expect(!refused.ok && refused.line).toContain("看板最多 1 個 hashtag");
    expect(addHashtags(ctx(store, { by: "captain" }), "b", ["TWO"])).toMatchObject({
      changed: true,
    });
  });

  it("follows the captain's settings for the aggregator", () => {
    const store = tagged();
    const noTagging = { ...store, settings: { ...store.settings, aggregator_may_tag: false } };
    expect(addHashtags(ctx(noTagging), "c", ["URGENT"])).toMatchObject({ ok: false });
    expect(removeHashtag(ctx(noTagging), "a", "URGENT")).toMatchObject({ ok: false });
    expect(addHashtags(ctx(noTagging, { by: "captain" }), "c", ["URGENT"])).toMatchObject({
      changed: true,
    });
    const noOpening = { ...store, settings: { ...store.settings, aggregator_may_create: false } };
    expect(addHashtags(ctx(noOpening), "c", ["URGENT"])).toMatchObject({ changed: true });
    const refused = addHashtags(ctx(noOpening), "c", ["FRESH"]);
    expect(!refused.ok && refused.line).toContain("關掉了 aggregator 開新的 hashtag");
  });

  it("keeps a locked hashtag for the captain", () => {
    const store = after(lockHashtag(ctx(tagged(), { by: "captain" }), "ai_infra", true));
    const add = addHashtags(ctx(store), "c", ["AI_INFRA"]);
    expect(!add.ok && add.line).toContain("#AI_INFRA 鎖上了");
    expect(removeHashtag(ctx(store), "a", "AI_INFRA")).toMatchObject({ ok: false });
    expect(removeHashtag(ctx(store, { by: "captain" }), "a", "AI_INFRA")).toMatchObject({
      changed: true,
    });
  });

  it("refuses the aggregator past its hourly cap, and the captain never", () => {
    const store = tagged();
    const made = (ts: number): HashtagRecord => ({
      rid: `r${ts}`,
      ts,
      kind: "hashtag.added",
      by: "aggregator",
    });
    const full = Array.from({ length: 20 }, (_, n) => made(NOW_S - n));
    const refused = addHashtags(ctx(store, { records: full }), "c", ["URGENT"]);
    expect(!refused.ok && refused.line).toContain("超過每小時上限");
    const old = [...full.slice(1), made(NOW_S - 3600)];
    expect(addHashtags(ctx(store, { records: old }), "c", ["URGENT"])).toMatchObject({
      changed: true,
    });
    expect(
      addHashtags(ctx(store, { records: full, by: "captain" }), "c", ["URGENT"]),
    ).toMatchObject({
      changed: true,
    });
  });
});

describe("taking a hashtag off a topic", () => {
  it("records what the topic had, and drops a topic left with none", () => {
    const result = removeHashtag(ctx(tagged()), "b", "ai_infra");
    expect(result).toMatchObject({
      records: [{ kind: "hashtag.removed", before: "AI_INFRA", after: "" }],
    });
    expect(after(result).topics["b"]).toBeUndefined();
    expect(removeHashtag(ctx(after(result)), "b", "AI_INFRA")).toMatchObject({ changed: false });
    expect(removeHashtag(ctx(tagged()), "c", "NEVER")).toMatchObject({ changed: false });
  });
});

describe("the captain's changes to a whole hashtag", () => {
  const captain = (store: Frozen<HashtagStore>) => ctx(store, { by: "captain" });

  function withView(): HashtagStore {
    return after(
      saveView(captain(tagged()), {
        name: "工作",
        any: [],
        none: ["AI_INFRA"],
        text: "",
        untagged: false,
      }),
    );
  }

  it("rename changes the spelling everywhere and refuses one another hashtag has", () => {
    const store = after(renameHashtag(captain(withView()), "AI_INFRA", "AI_INFRASTRUCTURE"));
    expect(store.topics).toEqual({ a: ["AI_INFRASTRUCTURE", "URGENT"], b: ["AI_INFRASTRUCTURE"] });
    expect(Object.values(store.views)[0]?.none).toEqual(["AI_INFRASTRUCTURE"]);
    expect(renameHashtag(captain(store), "AI_INFRA", "AI_INFRASTRUCTURE")).toMatchObject({
      changed: false,
    });
    expect(renameHashtag(captain(store), "AI_INFRASTRUCTURE", "urgent")).toMatchObject({
      ok: false,
    });
    const spelling = after(renameHashtag(captain(store), "urgent", "Urgent"));
    expect(spelling.topics["a"]).toEqual(["AI_INFRASTRUCTURE", "Urgent"]);
  });

  it("merge moves every topic to the other hashtag, once each", () => {
    const store = after(mergeHashtags(captain(withView()), "URGENT", "AI_INFRA"));
    expect(store.topics).toEqual({ a: ["AI_INFRA"], b: ["AI_INFRA"] });
    expect(store.hashtags["URGENT"]).toBeUndefined();
    expect(mergeHashtags(captain(store), "URGENT", "AI_INFRA")).toMatchObject({ changed: false });
    expect(mergeHashtags(captain(store), "AI_INFRA", "ai_infra")).toMatchObject({ ok: false });
  });

  it("delete takes it off every topic and view", () => {
    const result = deleteHashtag(captain(withView()), "AI_INFRA");
    expect(result).toMatchObject({
      records: [{ kind: "hashtag.deleted", topic: null, before: "AI_INFRA" }],
    });
    const store = after(result);
    expect(store.topics).toEqual({ a: ["URGENT"] });
    expect(Object.values(store.views)[0]?.none).toEqual([]);
    expect(deleteHashtag(captain(store), "AI_INFRA")).toMatchObject({ changed: false });
  });

  it("lock and colour say when nothing changes, and colour takes only the palette", () => {
    const locked = after(lockHashtag(captain(tagged()), "URGENT", true));
    expect(lockHashtag(captain(locked), "URGENT", true)).toMatchObject({ changed: false });
    expect(colorHashtag(captain(tagged()), "URGENT", "red")).toMatchObject({ ok: false });
    const colored = after(colorHashtag(captain(tagged()), "URGENT", "c7"));
    expect(colored.hashtags["URGENT"]?.color).toBe("c7");
  });
});

describe("the settings", () => {
  const captain = ctx(emptyHashtags(), { by: "captain" });

  it("change only within their ranges, all or none", () => {
    const result = changeSettings(captain, { per_topic_max: 3, aggregator_may_create: false });
    expect(after(result).settings).toMatchObject({
      per_topic_max: 3,
      aggregator_may_create: false,
    });
    expect(result).toMatchObject({ records: [{ kind: "hashtag.settings_changed" }] });
    for (const bad of [
      { per_topic_max: 0 },
      { board_max: 501 },
      { aggregator_hourly_max: 1.5 },
      { aggregator_may_tag: "yes" },
      { default_view: "missing" },
      { per_topic_max: 3, nonsense: 1 },
    ])
      expect(changeSettings(captain, bad)).toMatchObject({ ok: false, code: "usage" });
    expect(changeSettings(captain, { per_topic_max: 8 })).toMatchObject({ changed: false });
  });
});

describe("saved views", () => {
  const captain = (store: Frozen<HashtagStore>) => ctx(store, { by: "captain" });

  it("save under a minted id, rewrite by name, and fall back to 全部 when deleted", () => {
    const store = after(
      saveView(captain(tagged()), {
        name: "AI 基礎設施",
        any: ["ai_infra"],
        none: [],
        text: " gpu ",
        untagged: false,
      }),
    );
    expect(store.views).toEqual({
      ai: {
        name: "AI 基礎設施",
        any: ["AI_INFRA"],
        none: [],
        text: "gpu",
        untagged: false,
        order: "priority",
      },
    });
    const again = saveView(captain(store), {
      name: "AI 基礎設施",
      any: ["AI_INFRA"],
      none: [],
      text: "gpu",
      untagged: false,
    });
    expect(again).toMatchObject({ changed: false });
    const defaulted = after(changeSettings(captain(store), { default_view: "ai" }));
    const gone = after(deleteView(captain(defaulted), "ai"));
    expect(gone.views).toEqual({});
    expect(gone.settings.default_view).toBe("all");
    expect(deleteView(captain(gone), "ai")).toMatchObject({ changed: false });
  });

  it("keep the order the cards are listed in, and save it again when only the order changes", () => {
    const view = { name: "工作", any: [], none: [], text: "", untagged: false };
    const store = after(saveView(captain(tagged()), { ...view, order: "newest" }));
    expect(Object.values(store.views)[0]?.order).toBe("newest");
    const id = Object.keys(store.views)[0] as string;
    const oldest = saveView(captain(store), { ...view, id, order: "oldest" });
    expect(oldest).toMatchObject({ changed: true });
    expect(after(oldest).views[id]?.order).toBe("oldest");
    expect(saveView(captain(store), { ...view, id, order: "newest" })).toMatchObject({
      changed: false,
    });
    expect(Object.values(after(saveView(captain(tagged()), view)).views)[0]?.order).toBe(
      "priority",
    );
  });

  it("read a view's order from the file, and 照優先順序 when it is missing or unknown", () => {
    const store = parseHashtags({
      v: 1,
      views: {
        a: { name: "a", order: "newest" },
        b: { name: "b", order: "oldest" },
        c: { name: "c" },
        d: { name: "d", order: "sideways" },
        e: { name: "e", order: 1 },
      },
    });
    expect(Object.fromEntries(Object.entries(store.views).map(([id, v]) => [id, v.order]))).toEqual(
      { a: "newest", b: "oldest", c: "priority", d: "priority", e: "priority" },
    );
  });

  it("refuse an unknown hashtag, a bad id and a name that is not one line", () => {
    const view = { name: "x", any: ["NOPE"], none: [], text: "", untagged: false };
    expect(saveView(captain(tagged()), view)).toMatchObject({ ok: false });
    expect(saveView(captain(tagged()), { ...view, any: [], id: "all" })).toMatchObject({
      code: "usage",
    });
    expect(saveView(captain(tagged()), { ...view, any: [], name: "a\nb" })).toMatchObject({
      ok: false,
    });
  });
});

describe("taking back the aggregator's change", () => {
  function recorded(
    store: Frozen<HashtagStore>,
    result: HashtagResult,
    rid: string,
  ): HashtagRecord[] {
    if (!result.ok || !result.changed) throw new Error("expected a change");
    void store;
    return [{ ...result.records[0], rid, ts: NOW_S, by: "aggregator" }];
  }

  it("takes off what it put on, and drops a hashtag it opened that nobody saw", () => {
    const base = tagged();
    const add = addHashtags(ctx(base), "c", ["AI_INFA", "URGENT"]);
    const records = recorded(base, add, "r-typo");
    const result = revertChange(ctx(after(add), { by: "captain", records }), "r-typo");
    expect(result).toMatchObject({
      records: [
        {
          kind: "hashtag.reverted",
          topic: "c",
          ref: "r-typo",
          before: "AI_INFA URGENT",
          after: "",
        },
      ],
    });
    const store = after(result);
    expect(store.topics["c"]).toBeUndefined();
    expect(store.hashtags["AI_INFA"]).toBeUndefined();
    expect(store.hashtags["URGENT"]).toBeDefined();
  });

  it("puts back what it took off, once", () => {
    const base = tagged();
    const remove = removeHashtag(ctx(base), "a", "URGENT");
    const records = recorded(base, remove, "r-rm");
    const result = revertChange(ctx(after(remove), { by: "captain", records }), "r-rm");
    const store = after(result);
    expect(store.topics["a"]).toEqual(["AI_INFRA", "URGENT"]);
    const done = [
      ...records,
      { rid: "r-back", ts: NOW_S, kind: "hashtag.reverted", by: "captain", ref: "r-rm" },
    ];
    expect(revertChange(ctx(store, { by: "captain", records: done }), "r-rm")).toMatchObject({
      changed: false,
    });
  });

  it("refuses when what it took off is no longer on the board", () => {
    const base = tagged();
    const remove = removeHashtag(ctx(base), "a", "URGENT");
    const records = recorded(base, remove, "r-rm");
    const gone = after(deleteHashtag(ctx(after(remove), { by: "captain" }), "URGENT"));
    const result = revertChange(ctx(gone, { by: "captain", records }), "r-rm");
    expect(!result.ok && result.line).toContain("已經不在了");
  });
});

describe("the seen mark", () => {
  it("clears the 新 mark and the list of recent changes", () => {
    const add = addHashtags(ctx(), "a", ["AI_INFA"]);
    if (!add.ok || !add.changed) throw new Error("expected a change");
    const records: HashtagRecord[] = [
      { ...add.records[0], rid: "r1", ts: NOW_S, by: "aggregator" },
    ];
    const before = hashtagView(add.store, records);
    expect(before.hashtags[0]).toMatchObject({ name: "AI_INFA", new: true, topics: ["a"] });
    expect(before.recent).toMatchObject([{ rid: "r1", topic: "a", reverted: false }]);
    const seen = markSeen(ctx(add.store, { by: "captain", records }));
    expect(seen).toMatchObject({ records: [{ kind: "hashtag.seen", topic: null }] });
    const marked = [...records, { rid: "r2", ts: NOW_S + 1, kind: "hashtag.seen", by: "captain" }];
    const view = hashtagView(add.store, marked);
    expect(view.hashtags[0]?.new).toBe(false);
    expect(view.recent).toEqual([]);
    expect(markSeen(ctx(add.store, { by: "captain", records: marked }))).toMatchObject({
      changed: false,
    });
  });
});

describe("what topic changes do to hashtags", () => {
  it("a merge takes the union and may go over the per-topic maximum, which the page flags", () => {
    let store = after(addHashtags(ctx(), "a", ["A1", "A2"]));
    store = after(addHashtags(ctx(store), "b", ["A2", "B1"]));
    store = { ...store, settings: { ...store.settings, per_topic_max: 2 } };
    const carried = carryMerge(store, "b", { id: "a", name: "A" });
    expect(carried?.records[0]).toMatchObject({
      kind: "hashtag.carried",
      topic: "a",
      before: "A1 A2",
      after: "A1 A2 B1",
      text: "議題「A」：併進來時帶上 #B1",
    });
    const merged = carried?.store as HashtagStore;
    expect(merged.topics["b"]).toBeUndefined();
    expect(hashtagView(merged, []).over).toEqual(["a"]);
    expect(addHashtags(ctx(merged, { by: "captain" }), "a", ["C1"])).toMatchObject({ ok: false });
    expect(carryMerge(store, "c", { id: "a", name: "A" })).toBeNull();
  });

  it("a split copies the source's hashtags to the new topic", () => {
    const carried = carrySplit(tagged(), "a", { id: "c", name: "C" });
    expect(carried?.store.topics["c"]).toEqual(["AI_INFRA", "URGENT"]);
    expect(carried?.records[0]?.text).toBe("議題「C」：拆出時帶上 #AI_INFRA、#URGENT");
    expect(carrySplit(tagged(), "c", { id: "x", name: "X" })).toBeNull();
  });
});

describe("reading hashtags.json", () => {
  it("keeps one entry per key, the earliest, and drops what it does not know", () => {
    const store = parseHashtags({
      v: 1,
      hashtags: {
        ai_infra: { created_at: "2026-11-02T00:00:00Z", color: "c2" },
        AI_INFRA: { created_at: "2026-11-01T00:00:00Z", color: "bogus", created_by: "aggregator" },
        "bad name": {},
      },
      topics: { a: ["ai_infra", "AI_INFRA", "GHOST"], "-bad": ["AI_INFRA"], b: ["GHOST"] },
      views: { all: { name: "x" }, w: { name: "工作", none: ["Ai_Infra"], any: "x" } },
      settings: { per_topic_max: 99, board_max: 10, default_view: "w", aggregator_may_tag: false },
    });
    expect(Object.keys(store.hashtags)).toEqual(["AI_INFRA"]);
    expect(store.hashtags["AI_INFRA"]).toMatchObject({
      color: "c1",
      created_by: "aggregator",
      key: "ai_infra",
    });
    expect(store.topics).toEqual({ a: ["AI_INFRA"] });
    expect(store.views).toEqual({
      w: {
        name: "工作",
        any: [],
        none: ["AI_INFRA"],
        text: "",
        untagged: false,
        order: "priority",
      },
    });
    expect(store.settings).toMatchObject({
      per_topic_max: 8,
      board_max: 10,
      default_view: "w",
      aggregator_may_tag: false,
    });
    expect(() => parseHashtags({ v: 2 })).toThrow("v: 1");
  });

  it("puts a merged topic's hashtags on the topic it went into and drops a missing topic's", () => {
    const store = parseHashtags({
      v: 1,
      hashtags: { X: {}, Y: {} },
      topics: { old: ["X"], a: ["Y"], z: ["X"], gone: ["Y"] },
    });
    expect(reconcile(store, topicState()).topics).toEqual({ a: ["Y", "X"], z: ["X"] });
  });
});

describe("a setting name", () => {
  it("is one of the settings, never something every object has", () => {
    const captain = ctx(emptyHashtags(), { by: "captain" });
    for (const name of ["constructor", "__proto__", "toString"])
      expect(changeSettings(captain, { [name]: 1 })).toMatchObject({ ok: false, code: "usage" });
  });
});

describe("a view id", () => {
  it("that every object has is no saved view", () => {
    expect(deleteView(ctx(tagged(), { by: "captain" }), "constructor")).toMatchObject({
      changed: false,
    });
  });
});

describe("the edges", () => {
  const captain = (store: Frozen<HashtagStore> = emptyHashtags()) => ctx(store, { by: "captain" });

  it("a name whose NFKC form is not a name is refused", () => {
    expect(checkName("½")).toBeTypeOf("string");
  });

  it("reading keeps the first of two equally old spellings and drops a key that is not a name as written", () => {
    const store = parseHashtags({
      v: 1,
      hashtags: { ai: { created_at: "T" }, AI: { created_at: "T" }, "#B": {} },
      views: { "3": { name: "x" } },
      settings: { default_view: 3 },
    });
    expect(Object.keys(store.hashtags)).toEqual(["ai"]);
    expect(store.settings.default_view).toBe("all");
  });

  it("settings take both ends of their ranges, and say the range when outside it", () => {
    expect(
      after(changeSettings(captain(), { per_topic_max: 32, board_max: 1 })).settings,
    ).toMatchObject({
      per_topic_max: 32,
      board_max: 1,
    });
    expect(changeSettings(captain(), { per_topic_max: 33 })).toMatchObject({
      line: "per_topic_max 要是 1 到 32 的整數。",
    });
  });

  it("a lock change records what it was and what it is", () => {
    const locked = after(lockHashtag(captain(tagged()), "URGENT", true));
    expect(lockHashtag(captain(locked), "URGENT", false)).toMatchObject({
      records: [{ kind: "hashtag.lock_changed", before: "true", after: "false" }],
    });
  });

  it("a view gets v1 when its name has no slug, and a rewrite records the view it replaced", () => {
    const view = { name: "工作", any: [], none: [], text: "", untagged: false };
    const first = saveView(captain(tagged()), view);
    expect(first).toMatchObject({ line: "ok v1 視圖「工作」已存下", records: [{ before: "" }] });
    const second = saveView(captain(after(first)), { ...view, text: "gpu" });
    expect(second).toMatchObject({
      changed: true,
      records: [{ before: JSON.stringify({ ...view, order: "priority" }) }],
    });
    expect(saveView(captain(), { ...view, id: "all" })).toMatchObject({
      line: "視圖 id 格式不對：all",
    });
  });

  it("a hashtag is 新 only when the aggregator opened it after the last seen mark", () => {
    const store = after(addHashtags(ctx(), "a", ["X"]));
    const atSeen: HashtagRecord[] = [{ rid: "s", ts: NOW_S, kind: "hashtag.seen", by: "captain" }];
    expect(hashtagView(store, atSeen).hashtags[0]?.new).toBe(false);
    const undated = {
      ...store,
      hashtags: { X: { ...(store.hashtags["X"] as HashtagEntry), created_at: "" } },
    };
    expect(hashtagView(undated, []).hashtags[0]?.new).toBe(true);
    expect(markSeen(ctx(store, { by: "captain" }))).toMatchObject({ changed: true });
  });

  it("a topic at the per-topic maximum is not flagged as over it", () => {
    const base = emptyHashtags();
    const store = after(
      addHashtags(ctx({ ...base, settings: { ...base.settings, per_topic_max: 2 } }), "a", [
        "A",
        "B",
      ]),
    );
    expect(hashtagView(store, []).over).toEqual([]);
  });
});

describe("view ids", () => {
  it("count up past the ones taken, and a bad one is a usage refusal", () => {
    const captain = (store: Frozen<HashtagStore>) => ctx(store, { by: "captain" });
    const view = (name: string) => ({ name, any: [], none: [], text: "", untagged: false });
    const one = after(saveView(captain(emptyHashtags()), view("工作")));
    const two = saveView(captain(one), view("家裡"));
    expect(two).toMatchObject({ line: "ok v2 視圖「家裡」已存下" });
    expect(saveView(captain(one), { ...view("x"), id: "-x" })).toEqual({
      ok: false,
      code: "usage",
      line: "視圖 id 格式不對：-x",
    });
  });
});
