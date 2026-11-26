import { afterAll, describe, expect, it } from "vitest";

import { readBoard } from "./board-files.js";
import { dispatchOrder } from "./dispatch-order.js";
import type { DispatchOrder } from "./dispatch-order.js";
import { generator, removeHomes, writeHome } from "./fixtures.test-helper.js";
import type { HomeFiles } from "./fixtures.test-helper.js";

afterAll(removeHomes);

const CASES = 300;
const NOW = Date.parse("2026-12-07T02:30:00Z");
const QUEUE_NAMES = ["high", "normal", "later"] as const;
const RTS = ["hard-rt", "soft-rt", "none", "bogus"];
const RT_RANK: Record<string, number> = { "hard-rt": 0, "soft-rt": 1 };
const TIMES = ["2026-12-07T00:00:00Z", "2026-12-07T01:00:00Z", "2026-12-07T03:00:00Z"];
const CLOSES = [NOW - 3_600_000, NOW, NOW + 1000, NOW + 7_200_000];

interface Case {
  live: string[];
  archived: string[];
  topics: { queues: Record<string, string[]>; topics: Record<string, object>; merged: object };
  series: Record<string, { topic: string; rt: string }>;
  occurrences: Record<string, { series: string; at: string; state: string; closes_by: string }>;
  hashtags: Record<string, string[]>;
}

function makeCase(random: () => number): Case {
  const int = (below: number): number => Math.floor(random() * below);
  const pick = <T>(values: readonly T[]): T => values[int(values.length)] as T;
  // Integer-like ids too: an object lists those keys first, whatever order they were written in.
  const ids = (prefix: string, base: number, count: number): string[] =>
    Array.from({ length: count }, (_, i) => (random() < 0.3 ? String(base + i) : `${prefix}${i}`));
  const live = ids("t", 0, int(8));
  const archived = [...ids("a", 10, int(3)), ...live.filter(() => random() < 0.15)];
  const old = ids("o", 20, int(5));
  const everyId = [...live, ...archived, ...old, "ghost"];
  const merged = Object.fromEntries(old.map((id) => [id, pick(everyId)]));
  const queues = Object.fromEntries(
    QUEUE_NAMES.map((queue) => [queue, Array.from({ length: int(8) }, () => pick(everyId))]),
  );
  const topics = Object.fromEntries(
    live.map((id) => [id, { name: id, goal: "", created_at: pick(TIMES) }]),
  );
  const series = Object.fromEntries(
    Array.from({ length: int(4) }, (_, i) => [`s${i}`, { topic: pick(everyId), rt: pick(RTS) }]),
  );
  const occurrences = Object.fromEntries(
    Array.from({ length: int(5) }, (_, i) => [
      `o${i}`,
      {
        series: `s${int(5)}`,
        at: pick(TIMES),
        state: pick(["upcoming", "due", "taken"]),
        closes_by: new Date(pick(CLOSES)).toISOString(),
      },
    ]),
  );
  const hashtags = Object.fromEntries(
    everyId.filter(() => random() < 0.4).map((id) => [id, [pick(["A", "B", "a"])]]),
  );
  return {
    live,
    archived,
    topics: { queues, topics, merged },
    series,
    occurrences,
    hashtags,
  };
}

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

function reorder(record: object, random: () => number): object {
  return Object.fromEntries(shuffled(Object.entries(record), random));
}

function files(c: Case, random?: () => number): HomeFiles {
  const keys = (record: object): object =>
    random === undefined ? record : reorder(record, random);
  return {
    topics: {
      v: 1,
      queues: c.topics.queues,
      topics: keys(c.topics.topics),
      merged: keys(c.topics.merged),
    },
    archive: { v: 1, topics: keys(Object.fromEntries(c.archived.map((id) => [id, {}]))) },
    hashtags: { v: 1, hashtags: {}, topics: keys(c.hashtags) },
    schedules: { v: 1, series: keys(c.series), occurrences: keys(c.occurrences) },
  };
}

function orderOf(home: HomeFiles): DispatchOrder {
  return dispatchOrder(readBoard(writeHome(home)), NOW);
}

/** The oracle: merges followed with cycle detection, independent of the code under test. */
function resolve(c: Case, id: string): string | null {
  const merged = c.topics.merged as Record<string, string>;
  const seen = new Set<string>();
  let current = id;
  while (Object.hasOwn(merged, current)) {
    if (seen.has(current)) return null;
    seen.add(current);
    current = merged[current] as string;
  }
  return current;
}

function dispatchable(c: Case): Set<string> {
  const isLive = (id: string | null): id is string =>
    id !== null && c.live.includes(id) && !c.archived.includes(id);
  const firstQueue = (id: string): string | undefined =>
    QUEUE_NAMES.find((queue) => c.topics.queues[queue]?.some((entry) => resolve(c, entry) === id));
  const scheduled = new Set<string>();
  for (const occurrence of Object.values(c.occurrences)) {
    const series = c.series[occurrence.series];
    if (series === undefined || Date.parse(occurrence.closes_by) <= NOW) continue;
    const topic = resolve(c, series.topic);
    if (isLive(topic)) scheduled.add(topic);
  }
  return new Set(
    c.live.filter((id) => isLive(id) && (scheduled.has(id) || firstQueue(id) !== "later")),
  );
}

function section(entry: DispatchOrder["order"][number]): number {
  if (entry.occurrence !== null) return 0;
  return { high: 1, normal: 2, none: 3, later: 4 }[entry.queue];
}

function eachCase(check: (c: Case, random: () => number, seed: number) => void): void {
  for (let seed = 1; seed <= CASES; seed += 1) {
    const random = generator(seed);
    check(makeCase(random), random, seed);
  }
}

describe("dispatchOrder over arbitrary queues, merges and occurrences", () => {
  it("is a permutation of the dispatchable topics", () => {
    eachCase((c, _random, seed) => {
      const topics = orderOf(files(c)).order.map((entry) => entry.topic);
      expect(new Set(topics).size, `seed ${seed}`).toBe(topics.length);
      expect(new Set(topics), `seed ${seed}`).toEqual(dispatchable(c));
    });
  });

  it("never dispatches an archived topic, or one in later without an open occurrence", () => {
    eachCase((c, _random, seed) => {
      for (const entry of orderOf(files(c)).order) {
        expect(c.archived, `seed ${seed}`).not.toContain(entry.topic);
        if (entry.queue === "later") expect(entry.occurrence, `seed ${seed}`).not.toBeNull();
      }
    });
  });

  it("is the same for equal input, whatever order the files list their keys in", () => {
    eachCase((c, random, seed) => {
      const first = orderOf(files(c));
      expect(orderOf(files(c)), `seed ${seed}`).toEqual(first);
      expect(orderOf(files(c, random)), `seed ${seed}`).toEqual(first);
    });
  });

  it("puts occurrences by rt and T first, then high, normal and no queue, each in order", () => {
    eachCase((c, _random, seed) => {
      const { order } = orderOf(files(c));
      for (let i = 1; i < order.length; i += 1) {
        const [before, after] = [order[i - 1], order[i]] as const;
        if (before === undefined || after === undefined) continue;
        expect(section(before), `seed ${seed}`).toBeLessThanOrEqual(section(after));
        if (section(before) !== section(after)) continue;
        if (before.occurrence !== null && after.occurrence !== null) {
          const rank = (rt: string): number => RT_RANK[rt] ?? 2;
          const [early, late] = [rank(before.occurrence.rt), rank(after.occurrence.rt)];
          expect(early, `seed ${seed}`).toBeLessThanOrEqual(late);
          if (early === late) {
            const at = Date.parse(after.occurrence.at);
            expect(Date.parse(before.occurrence.at), `seed ${seed}`).toBeLessThanOrEqual(at);
          }
        } else if (before.position !== null && after.position !== null) {
          expect(before.position, `seed ${seed}`).toBeLessThan(after.position);
        }
      }
    });
  });

  it("does not change with hashtags", () => {
    eachCase((c, _random, seed) => {
      const topics = (result: DispatchOrder): string[] => result.order.map((entry) => entry.topic);
      const bare = { ...c, hashtags: {} };
      expect(topics(orderOf(files(c))), `seed ${seed}`).toEqual(topics(orderOf(files(bare))));
    });
  });
});
