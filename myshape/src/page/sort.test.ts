import { describe, expect, it } from "vitest";
import { generator } from "#board/seeded-random.test-helper.js";
import { NO_FILTER, shownTopics } from "./filter.js";
import type { FilterSource } from "./filter.js";
import { parseOrder, shownOrder, sortCards } from "./sort.js";

const born: Record<string, string> = {
  a: "2026-11-01T00:00:00Z",
  b: "2026-11-03T00:00:00Z",
  c: "2026-11-02T00:00:00Z",
  d: "2026-11-02T00:00:00Z",
  e: "2026-11-02T00:00:00.000+00:00",
  none: "",
  junk: "not a time",
};
const createdAt = (id: string): string => born[id] ?? "";

describe("the order of a queue's cards", () => {
  it("keeps the queue's own order under 照優先順序", () => {
    expect(sortCards(["b", "a", "c"], "priority", createdAt)).toEqual(["b", "a", "c"]);
  });

  it("puts the newest first, or the oldest first", () => {
    expect(sortCards(["a", "b", "c"], "newest", createdAt)).toEqual(["b", "c", "a"]);
    expect(sortCards(["a", "b", "c"], "oldest", createdAt)).toEqual(["a", "c", "b"]);
  });

  it("keeps the priority order among equal times, in both directions", () => {
    // c, d and e were made at one moment, e written another way.
    expect(sortCards(["d", "b", "e", "c"], "newest", createdAt)).toEqual(["b", "d", "e", "c"]);
    expect(sortCards(["d", "b", "e", "c"], "oldest", createdAt)).toEqual(["d", "e", "c", "b"]);
  });

  it("counts a topic with no readable time as older than every other", () => {
    expect(sortCards(["none", "a", "junk", "b"], "newest", createdAt)).toEqual([
      "b",
      "a",
      "none",
      "junk",
    ]);
    expect(sortCards(["none", "a", "junk", "b"], "oldest", createdAt)).toEqual([
      "none",
      "junk",
      "a",
      "b",
    ]);
  });

  it("lists an empty queue as empty", () => {
    for (const order of ["priority", "newest", "oldest"] as const)
      expect(sortCards([], order, createdAt)).toEqual([]);
  });

  it("does not change the list it is given", () => {
    const queue = ["a", "b", "c"];
    sortCards(queue, "newest", createdAt);
    expect(queue).toEqual(["a", "b", "c"]);
  });

  it("only reorders: every card is listed once, and the two directions mirror each other", () => {
    const random = generator(20261127);
    for (let round = 0; round < 200; round += 1) {
      const ids = Array.from({ length: Math.floor(random() * 9) }, (_, index) => `t${index}`);
      const times = new Map(
        ids.map((id) => [id, random() < 0.2 ? "" : `2026-11-0${1 + Math.floor(random() * 3)}`]),
      );
      const at = (id: string): string => times.get(id) ?? "";
      const newest = sortCards(ids, "newest", at);
      expect(newest.toSorted()).toEqual(ids.toSorted());
      const key = (id: string): number => Date.parse(at(id)) || -Infinity;
      for (let index = 1; index < newest.length; index += 1)
        expect(key(newest[index - 1] as string)).toBeGreaterThanOrEqual(
          key(newest[index] as string),
        );
      const groups = (list: string[]) => list.map((id) => String(key(id)));
      expect(groups(sortCards(ids, "oldest", at))).toEqual(groups(newest).toReversed());
    }
  });
});

describe("with a hashtag filter", () => {
  function topic(name: string, created: string) {
    return {
      name,
      goal: "",
      status: "confirmed" as const,
      queue: "normal" as const,
      close_reason: null,
      close_at: null,
      kept_until: null,
      archived_at: null,
      created_at: created,
    };
  }
  const source: FilterSource = {
    topics: {
      a: topic("A", born["a"] as string),
      b: topic("B", born["b"] as string),
      c: topic("C", born["c"] as string),
    },
    agents: [],
    queued: [],
    holds: [],
    questions: [],
    todos: [],
    summaries: [],
    hashtags: { topics: { a: ["GPU"], b: ["GPU"] }, hashtags: [] },
  };

  it("orders only the cards the filter shows", () => {
    const shown = shownTopics(source, { ...NO_FILTER, any: ["GPU"] });
    const listed = ["a", "b", "c"].filter((id) => shown?.has(id));
    expect(sortCards(listed, "newest", createdAt)).toEqual(["b", "a"]);
    expect(sortCards(listed, "oldest", createdAt)).toEqual(["a", "b"]);
    expect(sortCards(listed, "priority", createdAt)).toEqual(["a", "b"]);
  });

  it("lists nothing when the filter hides the whole queue", () => {
    const shown = shownTopics(source, { ...NO_FILTER, any: ["NONE"] });
    const listed = ["a", "b", "c"].filter((id) => shown?.has(id));
    expect(sortCards(listed, "newest", createdAt)).toEqual([]);
  });
});

describe("which order the page shows", () => {
  const views = [
    { id: "work", order: "newest" as const },
    { id: "home", order: "priority" as const },
  ];

  it("is the chosen saved view's", () => {
    expect(shownOrder("work", views, "oldest")).toBe("newest");
    expect(shownOrder("home", views, "oldest")).toBe("priority");
  });

  it("is the page's own without a saved view, or when the view is gone", () => {
    expect(shownOrder(null, views, "oldest")).toBe("oldest");
    expect(shownOrder("deleted", views, "newest")).toBe("newest");
  });
});

describe("the page's remembered order", () => {
  it("reads the three orders and nothing else", () => {
    expect(parseOrder("newest")).toBe("newest");
    expect(parseOrder("oldest")).toBe("oldest");
    expect(parseOrder("priority")).toBe("priority");
    expect(parseOrder(null)).toBe("priority");
    expect(parseOrder("")).toBe("priority");
    expect(parseOrder("Newest")).toBe("priority");
    expect(parseOrder('"newest"')).toBe("priority");
  });
});
