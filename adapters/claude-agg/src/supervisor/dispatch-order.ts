// The order the supervisor hands out new work in, computed from the board's
// files alone. Deterministic: the same files and the same time give the same
// order, whatever order the files list their keys in.
//
// 1. Open schedule occurrences, hard-rt then soft-rt then none, then by T,
//    then by key. One past its closes_by has ended. A topic in later (待辦)
//    with an open occurrence is dispatched here.
// 2. queues.high, then queues.normal, in their array order.
// 3. Topics in no queue, by created_at, then id.
// Topics in later without an open occurrence, and archived topics, get no new
// work. Every topic id read from a queue or a schedule follows `merged` to its
// end. Each topic appears at most once, at its first place in this order.

import { QUEUES } from "./board-files.js";
import type { Board, Occurrence, OccurrenceState, Queue, Rt } from "./board-files.js";

/** Followed merges stop here, as the board's own readers do, so a cycle ends. */
const MAX_MERGE_HOPS = 64;

const RT_RANK: Readonly<Record<Rt, number>> = { "hard-rt": 0, "soft-rt": 1, none: 2 };

export interface OpenOccurrence {
  key: string;
  series: string;
  at: string;
  state: OccurrenceState;
  rt: Rt;
  closes_by: string;
}

export interface OrderEntry {
  topic: string;
  name: string;
  goal: string;
  /** Where the topic sits on the board: a queue, or none. */
  queue: Queue | "none";
  /** 1-based place in that queue, or null in no queue. */
  position: number | null;
  occurrence: OpenOccurrence | null;
  /** The topic's hashtags, merged topics' included. They never change the order. */
  hashtags: string[];
  reason: string;
}

export interface SkipEntry {
  /** The topic (merges followed), or null when the schedule it would come from is missing. */
  topic: string | null;
  occurrence: string | null;
  reason: string;
}

export interface DispatchOrder {
  order: OrderEntry[];
  skipped: SkipEntry[];
}

interface Place {
  queue: Queue;
  position: number;
  listedAs: string;
}

interface Candidate {
  key: string;
  occurrence: Occurrence;
  rt: Rt;
  topic: string;
}

/** `id` with `merged` followed to its end. */
export function followMerges(merged: ReadonlyMap<string, string>, id: string): string {
  let current = id;
  for (let hops = 0; hops < MAX_MERGE_HOPS; hops += 1) {
    const next = merged.get(current);
    if (next === undefined) return current;
    current = next;
  }
  return current;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function sortedKeys<T>(map: ReadonlyMap<string, T>): string[] {
  return [...map.keys()].toSorted(compareText);
}

class Planner {
  private readonly order: OrderEntry[] = [];
  private readonly skipped: SkipEntry[] = [];
  private readonly taken = new Set<string>();
  private readonly places = new Map<string, Place>();

  private readonly board: Board;
  private readonly nowMs: number;

  constructor(board: Board, nowMs: number) {
    this.board = board;
    this.nowMs = nowMs;
  }

  run(): DispatchOrder {
    this.placeQueues();
    this.addOccurrences();
    this.addQueue("high");
    this.addQueue("normal");
    this.addUnqueued();
    this.skipLater();
    return { order: this.order, skipped: this.skipped };
  }

  /** The entry `topic` would have, with `reason`, or undefined when it cannot get work at all. */
  single(topic: string, reason: string): OrderEntry | undefined {
    this.placeQueues();
    if (this.unusable(topic) !== undefined) return undefined;
    this.add(topic, null, reason);
    return this.order[0];
  }

  private resolve(id: string): string {
    return followMerges(this.board.topics.merged, id);
  }

  /** Why `topic` cannot get work at all, or undefined when it is a live topic. */
  private unusable(topic: string): string | undefined {
    if (this.board.archived.has(topic)) return "the topic is archived";
    if (!this.board.topics.topics.has(topic)) return "no such topic";
    return undefined;
  }

  private placeQueues(): void {
    for (const queue of QUEUES) {
      this.board.topics.queues[queue].forEach((listedAs, index) => {
        const topic = this.resolve(listedAs);
        const problem = this.unusable(topic);
        if (problem !== undefined) {
          this.skip(topic, null, `listed in ${queue} as ${listedAs}, but ${problem}`);
        } else if (!this.places.has(topic)) {
          this.places.set(topic, { queue, position: index + 1, listedAs });
        }
      });
    }
  }

  private candidates(): Candidate[] {
    const found: Candidate[] = [];
    const { series, occurrences } = this.board.schedules;
    for (const [key, occurrence] of [...occurrences].toSorted(([a], [b]) => compareText(a, b))) {
      if (occurrence.closesByMs <= this.nowMs) continue;
      const schedule = series.get(occurrence.series);
      if (schedule === undefined) {
        this.skip(null, key, `open, but its schedule ${occurrence.series} is not in the file`);
        continue;
      }
      found.push({ key, occurrence, rt: schedule.rt, topic: this.resolve(schedule.topic) });
    }
    return found.toSorted(
      (a, b) =>
        RT_RANK[a.rt] - RT_RANK[b.rt] ||
        a.occurrence.atMs - b.occurrence.atMs ||
        compareText(a.key, b.key),
    );
  }

  private addOccurrences(): void {
    for (const candidate of this.candidates()) {
      const { key, occurrence, rt, topic } = candidate;
      const problem = this.unusable(topic);
      if (problem !== undefined) {
        this.skip(topic, key, `open, but ${problem}`);
      } else if (this.taken.has(topic)) {
        this.skip(topic, key, "open, but the topic already has an earlier open occurrence");
      } else {
        const open = { key, series: occurrence.series, at: occurrence.at, state: occurrence.state };
        const later = this.places.get(topic)?.queue === "later" ? "; the topic is in later" : "";
        this.add(
          topic,
          { ...open, rt, closes_by: occurrence.closes_by },
          `open occurrence ${key} (${occurrence.state}, ${rt}) at ${occurrence.at}${later}`,
        );
      }
    }
  }

  private addQueue(queue: "high" | "normal"): void {
    const placed = [...this.places].filter(([, place]) => place.queue === queue);
    for (const [topic, place] of placed.toSorted(([, a], [, b]) => a.position - b.position)) {
      if (this.taken.has(topic)) continue;
      const merged = place.listedAs === topic ? "" : ` (listed as ${place.listedAs}, merged)`;
      this.add(topic, null, `queue ${queue}, position ${place.position}${merged}`);
    }
  }

  private addUnqueued(): void {
    const { topics } = this.board.topics;
    const loose = [...topics.keys()].filter(
      (topic) =>
        !this.places.has(topic) && !this.taken.has(topic) && !this.board.archived.has(topic),
    );
    const byAge = loose.toSorted(
      (a, b) =>
        compareText(topics.get(a)?.created_at ?? "", topics.get(b)?.created_at ?? "") ||
        compareText(a, b),
    );
    for (const topic of byAge) this.add(topic, null, "in no queue");
  }

  private skipLater(): void {
    const later = [...this.places].filter(([topic, place]) => {
      return place.queue === "later" && !this.taken.has(topic);
    });
    for (const [topic] of later.toSorted(([, a], [, b]) => a.position - b.position)) {
      this.skip(topic, null, "in later (待辦) with no open occurrence");
    }
  }

  private add(topic: string, occurrence: OpenOccurrence | null, reason: string): void {
    const details = this.board.topics.topics.get(topic);
    const place = this.places.get(topic);
    this.taken.add(topic);
    this.order.push({
      topic,
      name: details?.name ?? "",
      goal: details?.goal ?? "",
      queue: place?.queue ?? "none",
      position: place?.position ?? null,
      occurrence,
      hashtags: this.hashtagsOf(topic),
      reason,
    });
  }

  private skip(topic: string | null, occurrence: string | null, reason: string): void {
    this.skipped.push({ topic, occurrence, reason });
  }

  /** The topic's own hashtags first, then those of the ids merged into it, by id; one per key. */
  private hashtagsOf(topic: string): string[] {
    const { topics, keys } = this.board.hashtags;
    const sources = sortedKeys(topics).filter((id) => id !== topic && this.resolve(id) === topic);
    const seen = new Set<string>();
    const result: string[] = [];
    for (const id of [topic, ...sources]) {
      for (const name of topics.get(id) ?? []) {
        const key = keys.get(name) ?? name.normalize("NFKC").toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(name);
      }
    }
    return result;
  }
}

/**
 * The dispatch order for one board home at `nowMs`, with the reason for each
 * entry, and the topics and occurrences that get no new work, with why.
 */
export function dispatchOrder(board: Board, nowMs: number): DispatchOrder {
  return new Planner(board, nowMs).run();
}

/**
 * The order entry of one live topic outside the order (a scheduled topic in
 * 待辦 whose make-up or held schedule work goes on), or undefined when the
 * topic is archived or not on the board.
 */
export function topicEntry(board: Board, topic: string, reason: string): OrderEntry | undefined {
  return new Planner(board, 0).single(topic, reason);
}
