import { describe, expect, it } from "vitest";
import { generator } from "#board/seeded-random.test-helper.js";
import * as topics from "#board/topics.js";
import type { MovePosition, Queue, TopicState } from "#board/topics.js";
import { dropAnchor, dropHint, timeDropAnchor } from "./drop.js";
import type { Anchor, Slot } from "./drop.js";

const NOW = "2026-11-27T00:00:00Z";

/** A board whose queues hold exactly these topics, in this order. */
function board(queues: Record<Queue, string[]>): TopicState {
  let state = topics.emptyState();
  for (const queue of topics.QUEUES) {
    for (const id of queues[queue]) {
      const made = topics.create(state, { name: id, goal: "g", id, queue }, NOW);
      if (!made.ok) throw new Error(made.line);
      state = made.state as TopicState;
    }
  }
  return state;
}

function position(anchor: Anchor): MovePosition {
  return "last" in anchor ? { last: true } : anchor;
}

/** The queues after the page's drop goes through the board's own move. */
function dropped(state: TopicState, id: string, queue: Queue, anchor: Anchor | null) {
  if (anchor === null) return state.doc.queues;
  const moved = topics.move(state, id, queue, position(anchor), NOW);
  if (!moved.ok) throw new Error(moved.line);
  return (moved.state as TopicState).doc.queues;
}

const EMPTY: Record<Queue, string[]> = { high: [], normal: [], later: [] };
const slot = (queue: Queue, above: string | null, below: string | null): Slot => ({
  queue,
  above,
  below,
});

describe("where a drop puts the topic without a filter", () => {
  it("goes before the card below it, or to the end, as it always has", () => {
    const start = slot("normal", "a", "c");
    expect(dropAnchor(start, slot("normal", null, "a"), false)).toEqual({ before: "a" });
    expect(dropAnchor(start, slot("high", "x", null), false)).toEqual({ last: true });
    expect(dropAnchor(start, start, false)).toEqual({ before: "c" });
  });

  it("keeps a scheduled topic, which 待辦 never lists, before the card below the drop", () => {
    const state = board({ ...EMPTY, later: ["a", "s", "b", "c"] });
    const anchor = dropAnchor(slot("later", "b", null), slot("later", "a", "b"), false);
    expect(dropped(state, "c", "later", anchor).later).toEqual(["a", "s", "c", "b"]);
  });
});

describe("where a drop puts the topic under a filter", () => {
  // normal: a h1 b h2 c, with h1 and h2 hidden by the filter.
  const state = board({ high: ["x", "hx"], normal: ["a", "h1", "b", "h2", "c"], later: [] });

  it("goes directly after the visible card above it, ahead of the hidden ones there", () => {
    const anchor = dropAnchor(slot("normal", "b", null), slot("normal", "a", "b"), true);
    expect(anchor).toEqual({ after: "a" });
    expect(dropped(state, "c", "normal", anchor).normal).toEqual(["a", "c", "h1", "b", "h2"]);
  });

  it("goes directly before the first visible card at the head of the list", () => {
    const anchor = dropAnchor(slot("normal", "b", null), slot("normal", null, "a"), true);
    expect(anchor).toEqual({ before: "a" });
    expect(dropped(state, "c", "normal", anchor).normal).toEqual(["c", "a", "h1", "b", "h2"]);
  });

  it("goes directly after the last visible card at the tail, ahead of the hidden ones after it", () => {
    const anchor = dropAnchor(slot("normal", null, "h1"), slot("normal", "c", null), true);
    expect(dropped(state, "a", "normal", anchor).normal).toEqual(["h1", "b", "h2", "c", "a"]);
    const toB = dropAnchor(slot("normal", null, "b"), slot("normal", "b", null), true);
    expect(toB).toEqual({ after: "b" });
    expect(dropped(state, "a", "normal", toB).normal).toEqual(["h1", "b", "a", "h2", "c"]);
  });

  it("follows the same rule into another queue", () => {
    const anchor = dropAnchor(slot("normal", "a", "c"), slot("high", "x", null), true);
    const queues = dropped(state, "b", "high", anchor);
    expect(queues.high).toEqual(["x", "b", "hx"]);
    expect(queues.normal).toEqual(["a", "h1", "h2", "c"]);
  });

  it("goes to the end of a queue with no visible card", () => {
    const anchor = dropAnchor(slot("normal", "a", "c"), slot("later", null, null), true);
    expect(anchor).toEqual({ last: true });
    const hidden = board({ ...EMPTY, normal: ["a", "b"], later: ["h3", "h4"] });
    expect(dropped(hidden, "b", "later", anchor).later).toEqual(["h3", "h4", "b"]);
  });

  it("moves nothing when the card is dropped where it started", () => {
    expect(dropAnchor(slot("normal", "a", "c"), slot("normal", "a", "c"), true)).toBeNull();
    // A filter that leaves one topic: dropped back in its own queue, it stays put.
    expect(dropAnchor(slot("normal", null, null), slot("normal", null, null), true)).toBeNull();
    expect(dropAnchor(slot("normal", null, null), slot("high", null, "x"), true)).toEqual({
      before: "x",
    });
  });
});

describe("where a drop puts the topic while the cards are listed by creation time", () => {
  const state = board({ high: ["x"], normal: ["a", "b", "c"], later: ["s", "l"] });

  it("moves nothing when the card is dropped in its own queue, wherever in the list", () => {
    expect(timeDropAnchor("normal", "normal")).toBeNull();
    expect(dropped(state, "b", "normal", timeDropAnchor("normal", "normal")).normal).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("puts it last in another queue, after every topic there, listed or not", () => {
    const anchor = timeDropAnchor("normal", "later");
    expect(anchor).toEqual({ last: true });
    const queues = dropped(state, "a", "later", anchor);
    expect(queues.later).toEqual(["s", "l", "a"]);
    expect(queues.normal).toEqual(["b", "c"]);
  });

  it("puts it last in an empty queue too", () => {
    const empty = board({ ...EMPTY, normal: ["a", "b"] });
    expect(dropped(empty, "b", "high", timeDropAnchor("normal", "high")).high).toEqual(["b"]);
  });
});

describe("the drop hint", () => {
  it("says, while listed by creation time, that only a move to another queue counts", () => {
    const hint = "照建立時間排列中：拖到別的佇列會排在那裡的最後，在原來的佇列裡放下不會改順序";
    expect(dropHint(3, 0, false, true)).toBe(hint);
    expect(dropHint(0, 0, false, true)).toBe(hint);
    expect(dropHint(1, 2, true, true)).toBe(
      "照建立時間排列中：拖到別的佇列會排在那裡的最後（連沒列出的也算），在原來的佇列裡放下不會改順序",
    );
  });

  it("says a filter is on, how many cards it orders among, and how many stay put", () => {
    expect(dropHint(3, 2, false, false)).toBe("拖到這裡");
    expect(dropHint(3, 2, true, false)).toBe(
      "篩選中：只在看得到的 3 個議題之間排順序，沒列出的 2 個位置不變",
    );
    expect(dropHint(0, 2, true, false)).toBe(
      "篩選中：這裡沒有看得到的議題，放下會排在沒列出的 2 個之後",
    );
    expect(dropHint(1, 0, true, false)).toBe(
      "篩選中：只在看得到的 1 個議題之間排順序，沒列出的 0 個位置不變",
    );
    expect(dropHint(0, 1, true, false)).toBe(
      "篩選中：這裡沒有看得到的議題，放下會排在沒列出的 1 個之後",
    );
    expect(dropHint(0, 0, true, false)).toBe("篩選中：放下會排在這個佇列最後");
  });
});

/** A random board, a random filter, and the cards each queue lists under it. */
function randomCase(random: () => number) {
  const queues: Record<Queue, string[]> = { high: [], normal: [], later: [] };
  const visible: Record<Queue, string[]> = { high: [], normal: [], later: [] };
  const count = 1 + Math.floor(random() * 12);
  for (let index = 0; index < count; index += 1) {
    const queue = topics.QUEUES[Math.floor(random() * 3)] as Queue;
    const id = `t${index}`;
    queues[queue].push(id);
    if (index === 0 || random() < 0.5) visible[queue].push(id);
  }
  return { queues, visible };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

const around = (list: string[], at: number) => ({
  above: list[at - 1] ?? null,
  below: list[at] ?? null,
});

/** The order of `list` without `id`. */
const without = (list: readonly string[], id: string) => list.filter((entry) => entry !== id);

/** The topic the anchor puts the dropped one beside, read from the queue after the drop. */
function nextTo(queue: readonly string[], anchor: Anchor): string | undefined {
  if ("after" in anchor) return queue[queue.indexOf(anchor.after) + 1];
  if ("before" in anchor) return queue[queue.indexOf(anchor.before) - 1];
  return queue.at(-1);
}

describe("any drop under any filter", () => {
  it("moves only the dragged topic, keeps the hidden ones in order, and shows what was dropped", () => {
    const random = generator(20261127);
    for (let round = 0; round < 500; round += 1) {
      const { queues, visible } = randomCase(random);
      const from = pick(
        random,
        topics.QUEUES.filter((queue) => visible[queue].length > 0),
      );
      const id = pick(random, visible[from]);
      const to = pick(random, topics.QUEUES);
      const seen = without(visible[to], id);
      const at = Math.floor(random() * (seen.length + 1));
      const index = visible[from].indexOf(id);
      const start = {
        queue: from,
        above: visible[from][index - 1] ?? null,
        below: visible[from][index + 1] ?? null,
      };
      const anchor = dropAnchor(start, { queue: to, ...around(seen, at) }, true);
      const after = dropped(board(queues), id, to, anchor);
      const replay = `seed round ${round}: ${JSON.stringify({ queues, visible, id, to, at })}`;
      for (const queue of topics.QUEUES) {
        expect(without(after[queue], id), replay).toEqual(without(queues[queue], id));
      }
      const shown = new Set([...visible[to], id]);
      const expected =
        anchor === null ? visible[to] : [...seen.slice(0, at), id, ...seen.slice(at)];
      expect(
        after[to].filter((entry) => shown.has(entry)),
        replay,
      ).toEqual(expected);
      if (anchor !== null) expect(nextTo(after[to], anchor), replay).toBe(id);
    }
  });
});

describe("any drop while listed by creation time", () => {
  it("moves only the dragged topic, and only to the end of another queue", () => {
    const random = generator(20261128);
    for (let round = 0; round < 500; round += 1) {
      const { queues } = randomCase(random);
      const from = pick(
        random,
        topics.QUEUES.filter((queue) => queues[queue].length > 0),
      );
      const id = pick(random, queues[from]);
      const to = pick(random, topics.QUEUES);
      const after = dropped(board(queues), id, to, timeDropAnchor(from, to));
      const replay = `seed round ${round}: ${JSON.stringify({ queues, id, to })}`;
      for (const queue of topics.QUEUES)
        expect(without(after[queue], id), replay).toEqual(without(queues[queue], id));
      expect(after[to].at(-1), replay).toBe(from === to ? queues[to].at(-1) : id);
      if (from === to) expect(after[to], replay).toEqual(queues[to]);
    }
  });
});
