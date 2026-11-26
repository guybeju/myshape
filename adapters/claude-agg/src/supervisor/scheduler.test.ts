import { describe, expect, it } from "vitest";

import { generator } from "./fixtures.test-helper.js";
import {
  MAX_PER_TOPIC,
  MAX_RUNNING,
  schedule,
  WAIT,
  type Candidate,
  type Slot,
  type TopicStatus,
} from "./scheduler.js";

const live = (): TopicStatus => "dispatchable";

describe("schedule", () => {
  it("starts in order until both places are taken", () => {
    const candidates = ["a", "b", "c"].map((topic) => ({ id: `${topic}-1`, topic }));
    const decision = schedule({
      running: [],
      candidates,
      status: live,
      quotaUntil: null,
      reserved: new Set(),
    });
    expect(decision.start.map((c) => c.id)).toEqual(["a-1", "b-1"]);
    expect([...decision.waiting]).toEqual([["c-1", WAIT.full]]);
  });

  it("counts what already runs, and one per topic", () => {
    const decision = schedule({
      running: [{ id: "a-1", topic: "a" }],
      candidates: [
        { id: "a-2", topic: "a" },
        { id: "b-1", topic: "b" },
        { id: "c-1", topic: "c" },
      ],
      status: live,
      quotaUntil: null,
      reserved: new Set(),
    });
    expect(decision.start.map((c) => c.id)).toEqual(["b-1"]);
    expect(decision.waiting.get("a-2")).toBe(WAIT.topicBusy("a-1"));
    expect(decision.waiting.get("c-1")).toBe(WAIT.full);
  });

  it("starts nothing during the quota stop, and names later and gone topics first", () => {
    const decision = schedule({
      running: [],
      candidates: [
        { id: "a-1", topic: "a" },
        { id: "l-1", topic: "l" },
        { id: "g-1", topic: "g" },
      ],
      status: ({ topic }) => (topic === "l" ? "later" : topic === "g" ? "gone" : "dispatchable"),
      quotaUntil: "2026-11-27T03:00:00Z",
      reserved: new Set(),
    });
    expect(decision.start).toEqual([]);
    expect([...decision.waiting]).toEqual([
      ["a-1", "額度用盡或被限流，暫停派工，預計 2026-11-27T03:00:00Z 恢復"],
      ["l-1", WAIT.later],
      ["g-1", WAIT.gone],
    ]);
    expect(WAIT.quota("")).toBe("額度用盡或被限流，暫停派工");
  });

  it("never starts what already runs, or one id twice", () => {
    const decision = schedule({
      running: [{ id: "a-1", topic: "a" }],
      candidates: [
        { id: "a-1", topic: "a" },
        { id: "b-1", topic: "b" },
        { id: "b-1", topic: "b" },
      ],
      status: live,
      quotaUntil: null,
      reserved: new Set(),
    });
    expect(decision.start.map((c) => c.id)).toEqual(["b-1"]);
  });
});

describe("schedule, with a place kept for a schedule's occurrence", () => {
  const key = "s:20261207T0200Z";

  it("starts no other work that would take the place an open occurrence needs", () => {
    const decision = schedule({
      running: [{ id: "a-1", topic: "a" }],
      candidates: [{ id: "b-1", topic: "b" }],
      status: live,
      quotaUntil: null,
      reserved: new Set([key]),
    });
    expect(decision.start).toEqual([]);
    expect(decision.waiting.get("b-1")).toBe(WAIT.reserved(key));
  });

  it("lets other work start while a place stays free, and stops none that runs", () => {
    const decision = schedule({
      running: [],
      candidates: [
        { id: "a-1", topic: "a" },
        { id: "b-1", topic: "b" },
      ],
      status: live,
      quotaUntil: null,
      reserved: new Set([key]),
    });
    expect(decision.start.map((c) => c.id)).toEqual(["a-1"]);
    expect(decision.waiting.get("b-1")).toBe(WAIT.reserved(key));
  });

  it("gives the kept place to the occurrence's own work", () => {
    const decision = schedule({
      running: [{ id: "a-1", topic: "a" }],
      candidates: [
        { id: "b-1", topic: "b" },
        { id: "plan:s", topic: "s", occurrence: key },
      ],
      status: live,
      quotaUntil: null,
      reserved: new Set([key]),
    });
    expect(decision.start.map((c) => c.id)).toEqual(["plan:s"]);
    expect(decision.waiting.get("b-1")).toBe(WAIT.reserved(key));
  });

  it("keeps no place for an occurrence whose work already runs", () => {
    const decision = schedule({
      running: [{ id: "s-at-20261207T0200Z-1", topic: "s", occurrence: key }],
      candidates: [{ id: "b-1", topic: "b" }],
      status: live,
      quotaUntil: null,
      reserved: new Set([key]),
    });
    expect(decision.start.map((c) => c.id)).toEqual(["b-1"]);
  });

  it("names an occurrence not due yet, and a silent one", () => {
    const decision = schedule({
      running: [],
      candidates: [
        { id: "plan:s", topic: "s", occurrence: key },
        { id: "plan:p", topic: "p", occurrence: "p:20261207T0200Z" },
      ],
      status: ({ topic }) => (topic === "s" ? "notYet" : "silent"),
      quotaUntil: null,
      reserved: new Set(),
    });
    expect(decision.start).toEqual([]);
    expect([...decision.waiting]).toEqual([
      ["plan:s", WAIT.notYet],
      ["plan:p", WAIT.silent],
    ]);
  });
});

describe("schedule, over random situations", () => {
  const CASES = 500;
  it(`never runs more than ${MAX_RUNNING}, never ${MAX_PER_TOPIC + 1} on a topic, never one id twice, never a kept place (${CASES} seeds)`, () => {
    for (let seed = 1; seed <= CASES; seed += 1) {
      const random = generator(seed);
      const int = (below: number): number => Math.floor(random() * below);
      const topics = ["a", "b", "c", "d"];
      const running: Slot[] = Array.from({ length: int(3) }, (_, i) => ({
        id: `r${i}`,
        topic: topics[int(4)] ?? "a",
      }));
      const keys = ["k0", "k1", "k2"];
      const reserved = new Set(keys.filter(() => random() < 0.3));
      const candidates: Candidate[] = Array.from({ length: int(8) }, () => {
        const topic = topics[int(4)] ?? "a";
        const candidate: Candidate = { id: `${topic}-${int(3)}`, topic };
        if (random() < 0.3) candidate.occurrence = keys[int(3)] ?? "k0";
        return candidate;
      });
      const statuses: TopicStatus[] = ["dispatchable", "dispatchable", "later", "gone"];
      const status = new Map(topics.map((topic) => [topic, statuses[int(4)] ?? "dispatchable"]));
      const quota = random() < 0.2 ? "2026-11-27T03:00:00Z" : null;
      const decision = schedule({
        running,
        candidates,
        status: ({ topic }) => status.get(topic) ?? "gone",
        quotaUntil: quota,
        reserved,
      });
      const after = [...running, ...decision.start];
      const context = `seed ${seed}`;
      if (decision.start.length > 0) expect(after.length, context).toBeLessThanOrEqual(MAX_RUNNING);
      for (const topic of new Set(decision.start.map((c) => c.topic))) {
        expect(after.filter((slot) => slot.topic === topic).length, context).toBeLessThanOrEqual(
          MAX_PER_TOPIC,
        );
        expect(status.get(topic), context).toBe("dispatchable");
      }
      const ids = decision.start.map((c) => c.id);
      expect(new Set(ids).size, context).toBe(ids.length);
      for (const id of ids)
        expect(
          running.some((slot) => slot.id === id),
          context,
        ).toBe(false);
      if (quota !== null) expect(ids, context).toEqual([]);
      const served = new Set(after.map((slot) => slot.occurrence));
      const kept = [...reserved].filter((key) => !served.has(key)).length;
      const other = decision.start.some(
        (c) => c.occurrence === undefined || !reserved.has(c.occurrence),
      );
      if (other)
        expect(after.length + kept, `${context}: a kept place was taken`).toBeLessThanOrEqual(
          MAX_RUNNING,
        );
      for (const candidate of candidates) {
        const started = ids.includes(candidate.id);
        expect(
          started ||
            decision.waiting.has(candidate.id) ||
            running.some((s) => s.id === candidate.id),
          context,
        ).toBe(true);
      }
    }
  });
});
