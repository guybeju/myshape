import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DispatchNotifier, fileStore } from "./notifier.js";
import type { NotifyStore, PendingNotice } from "./notifier.js";
import { emptyState } from "./topics.js";
import type { Queue, TopicState } from "./topics.js";

function state(queues: Partial<Record<Queue, string[]>>): TopicState {
  const result = emptyState();
  result.doc.queues = { high: [], normal: [], later: [], ...queues };
  return result;
}

/** A store kept in memory, as the file would keep it between starts. */
function memoryStore(): NotifyStore & { saved: Map<string, PendingNotice> } {
  const saved = new Map<string, PendingNotice>();
  return {
    saved,
    load: () => new Map(saved),
    save: (pending) => {
      saved.clear();
      for (const [id, entry] of pending) saved.set(id, { ...entry });
    },
  };
}

describe("DispatchNotifier", () => {
  let notified: string[][];
  let notifier: DispatchNotifier;
  let store: ReturnType<typeof memoryStore>;

  beforeEach(() => {
    vi.useFakeTimers();
    notified = [];
    store = memoryStore();
    notifier = new DispatchNotifier(30_000, store, (ready) =>
      notified.push(ready.map((entry) => entry.id)),
    );
  });
  afterEach(() => {
    notifier.stop();
    vi.useRealTimers();
  });

  it("notifies once the topic has stayed dispatchable for the whole delay", () => {
    notifier.observe(state({ later: ["a"] }), state({ normal: ["a"] }), ["a"]);
    vi.advanceTimersByTime(29_999);
    expect(notified).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(notified).toEqual([["a"]]);
    vi.advanceTimersByTime(120_000);
    expect(notified).toEqual([["a"]]);
  });

  it("cancels when the topic goes back to later, is archived, or disappears", () => {
    for (const after of [state({ later: ["a"] }), state({})]) {
      notifier.observe(state({ later: ["a"] }), state({ normal: ["a"] }), ["a"]);
      vi.advanceTimersByTime(10_000);
      notifier.observe(state({ normal: ["a"] }), after, []);
      vi.advanceTimersByTime(60_000);
    }
    expect(notified).toEqual([]);
  });

  it("restarts the wait when the topic moves again, by queue or by position", () => {
    notifier.observe(state({ later: ["a"] }), state({ normal: ["b", "a"] }), ["a"]);
    vi.advanceTimersByTime(20_000);
    notifier.observe(state({ normal: ["b", "a"] }), state({ normal: ["a", "b"] }), []);
    vi.advanceTimersByTime(20_000);
    notifier.observe(state({ normal: ["a", "b"] }), state({ high: ["a"], normal: ["b"] }), []);
    vi.advanceTimersByTime(29_999);
    expect(notified).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(notified).toEqual([["a"]]);
  });

  it("does not restart the wait for a change that leaves the topic where it is", () => {
    notifier.observe(state({ later: ["a"] }), state({ normal: ["a"] }), ["a"]);
    vi.advanceTimersByTime(20_000);
    notifier.observe(state({ normal: ["a"] }), state({ normal: ["a", "b"] }), []);
    vi.advanceTimersByTime(10_000);
    expect(notified).toEqual([["a"]]);
  });

  it("batches topics due within a second and sends later ones separately", () => {
    notifier.observe(
      state({ later: ["a", "b", "c"] }),
      state({ normal: ["a"], later: ["b", "c"] }),
      ["a"],
    );
    vi.advanceTimersByTime(1000);
    notifier.observe(
      state({ normal: ["a"], later: ["b", "c"] }),
      state({ normal: ["a"], high: ["b"], later: ["c"] }),
      ["b"],
    );
    vi.advanceTimersByTime(1001);
    notifier.observe(
      state({ normal: ["a"], high: ["b"], later: ["c"] }),
      state({ normal: ["a", "c"], high: ["b"] }),
      ["c"],
    );
    vi.advanceTimersByTime(27_999);
    expect(notified).toEqual([["a", "b"]]);
    vi.advanceTimersByTime(2001);
    expect(notified).toEqual([["a", "b"], ["c"]]);
  });

  it("sends nothing after stop", () => {
    notifier.observe(state({ later: ["a"] }), state({ normal: ["a"] }), ["a"]);
    notifier.stop();
    vi.advanceTimersByTime(60_000);
    expect(notified).toEqual([]);
  });

  it("says whether the topic left later or was reopened", () => {
    const reasons: string[] = [];
    const other = new DispatchNotifier(1000, memoryStore(), (ready) =>
      reasons.push(...ready.map((entry) => `${entry.id}:${entry.reason}`)),
    );
    const archived = state({});
    archived.archive.topics["r"] = {
      name: "R",
      goal: "g",
      status: "confirmed",
      created_at: "",
      archived_at: "T",
    };
    other.observe(state({ later: ["m"] }), state({ normal: ["m"] }), ["m"]);
    other.observe(archived, state({ normal: ["m", "r"] }), ["r"]);
    vi.advanceTimersByTime(1000);
    expect(reasons).toEqual(["m:left-later", "r:reopened"]);
    other.stop();
  });

  it("keeps the wait across a restart and fires once it is due", () => {
    notifier.observe(state({ later: ["a", "b"] }), state({ normal: ["a", "b"] }), ["a", "b"]);
    vi.advanceTimersByTime(10_000);
    notifier.stop();
    expect([...store.saved.keys()]).toEqual(["a", "b"]);
    const restarted = new DispatchNotifier(30_000, store, (ready) =>
      notified.push(ready.map((entry) => entry.id)),
    );
    restarted.start(state({ normal: ["a"], later: ["b"] }));
    expect([...store.saved.keys()]).toEqual(["a"]);
    vi.advanceTimersByTime(19_999);
    expect(notified).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(notified).toEqual([["a"]]);
    expect(store.saved.size).toBe(0);
    restarted.stop();
  });

  it("fires at once a wait that ended while the board was down", () => {
    notifier.observe(state({ later: ["a"] }), state({ normal: ["a"] }), ["a"]);
    notifier.stop();
    vi.advanceTimersByTime(60_000);
    const restarted = new DispatchNotifier(30_000, store, (ready) =>
      notified.push(ready.map((entry) => entry.id)),
    );
    restarted.start(state({ normal: ["a"] }));
    vi.advanceTimersByTime(0);
    expect(notified).toEqual([["a"]]);
    restarted.stop();
  });
});

describe("fileStore", () => {
  it("round-trips the waits and reads a missing or broken file as none", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-notify-"));
    const file = path.join(dir, "notify-pending.json");
    const store = fileStore(file);
    expect(store.load().size).toBe(0);
    store.save(new Map([["a", { dueAt: 5, reason: "reopened" }]]));
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      v: 1,
      pending: { a: { due_at: 5, reason: "reopened" } },
    });
    expect([...fileStore(file).load()]).toEqual([["a", { dueAt: 5, reason: "reopened" }]]);
    fs.writeFileSync(file, "{not json");
    expect(fileStore(file).load().size).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
