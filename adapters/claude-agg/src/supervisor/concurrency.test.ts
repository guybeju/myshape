// Step 4 of the plan: at most 2 sessions in all and 1 per topic, the rest
// queued with a reason; 待辦 stops nothing and starts nothing; the quota stop
// and its resume; and reconciliation after a restart.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  errorResult,
  Gate,
  init,
  plan,
  rejected,
  removeScratch,
  result,
  workerOutput,
} from "./harness.test-helper.js";
import { RESUME_PROMPT } from "./prompts.js";
import { WAIT } from "./scheduler.js";
import type { Supervisor } from "./supervisor.js";
import { REPO, START_MS, World } from "./world.test-helper.js";

afterAll(removeScratch);

/** Lets the sessions that were started run up to their gates. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A world with these queued tasks, each worker gated; returns the gates in start order. */
function gated(
  world: World,
  count: number,
  messages: (n: number) => object[] = (n) => [init(`s${n}`), result(workerOutput("report"))],
) {
  const gates = Array.from({ length: count }, () => new Gate());
  gates.forEach((gate, n) => world.query.worker.push({ messages: messages(n), gate }));
  return gates;
}

function running(world: World): string[] {
  return [...world.query.active].map((call) => call.options.cwd.split("/").at(-1) ?? "");
}

function holdOf(world: World, id: string): string | null | undefined {
  return world.queued().find((entry) => entry.id === id)?.hold;
}

describe("the semaphore", () => {
  it("runs exactly 2 of 4 tasks and queues the rest with the reason", async () => {
    const world = new World({ normal: ["a", "b", "c", "d"] });
    world.seedQueued(["a", "b", "c", "d"].map((topic) => ({ id: `${topic}-1`, topic })));
    const gates = gated(world, 4);
    const supervisor = await world.start();
    supervisor.tick();
    await settle();
    expect(running(world)).toEqual(["a-1", "b-1"]);
    expect(world.tasks()["a-1"]).toMatchObject({
      state: "working",
      model: "test-model",
      session_id: "s0",
    });
    expect(world.queued().map((entry) => [entry.id, entry.hold, entry.turn])).toEqual([
      ["c-1", WAIT.full, true],
      ["d-1", WAIT.full, true],
    ]);
    expect(WAIT.full).toBe("等空位（2/2）");
    gates[0]?.open();
    await settle();
    expect(running(world)).toEqual(["b-1", "c-1"]);
    expect(holdOf(world, "d-1")).toBe(WAIT.full);
    for (const gate of gates) gate.open();
    await supervisor.idle();
    expect(Object.values(world.tasks()).map((task) => task.state)).toEqual([
      "done",
      "done",
      "done",
      "done",
    ]);
    expect(world.queued()).toEqual([]);
    supervisor.close();
  });

  it("runs at most 1 per topic", async () => {
    const world = new World({ normal: ["a", "b"] });
    world.seedQueued([
      { id: "a-1", topic: "a" },
      { id: "a-2", topic: "a" },
      { id: "b-1", topic: "b" },
    ]);
    const gates = gated(world, 3);
    const supervisor = await world.start();
    supervisor.tick();
    await settle();
    expect(running(world)).toEqual(["a-1", "b-1"]);
    expect(holdOf(world, "a-2")).toBe(WAIT.topicBusy("a-1"));
    // Only a wait for a free place says the supervisor starts it by itself.
    expect(world.queued().find((entry) => entry.id === "a-2")?.turn).toBeUndefined();
    gates[1]?.open();
    await settle();
    expect(running(world)).toEqual(["a-1"]);
    expect(holdOf(world, "a-2")).toBe("同一個議題已經有 worker 在跑（a-1）");
    gates[0]?.open();
    await settle();
    expect(running(world)).toEqual(["a-2"]);
    gates[2]?.open();
    await supervisor.idle();
    supervisor.close();
  });

  it("counts the planner as a session", async () => {
    const world = new World({ normal: ["a", "b", "c"] });
    const gates = [new Gate(), new Gate(), new Gate()];
    for (const gate of gates) {
      world.query.planner.push({ messages: [init("p", "default"), result(plan([]))], gate });
    }
    const supervisor = await world.start();
    supervisor.tick();
    await settle();
    expect(world.query.active.size).toBe(2);
    expect(supervisor.snapshot().running.map((slot) => slot.id)).toEqual(["plan:a", "plan:b"]);
    for (const gate of gates) gate.open();
    await supervisor.idle();
    expect(world.query.calls).toHaveLength(3);
    supervisor.close();
  });
});

describe("待辦 (later)", () => {
  it("never stops a running worker and starts no new one for the topic", async () => {
    const world = new World({ normal: ["a"] });
    world.seedQueued([
      { id: "a-1", topic: "a" },
      { id: "a-2", topic: "a" },
    ]);
    const gates = gated(world, 2);
    const supervisor = await world.start();
    supervisor.tick();
    await settle();
    expect(running(world)).toEqual(["a-1"]);
    world.moveTopics({ later: ["a"] });
    supervisor.tick();
    await settle();
    expect(running(world)).toEqual(["a-1"]);
    expect(world.query.aborted).toBe(0);
    expect(holdOf(world, "a-2")).toBe(WAIT.later);
    gates[0]?.open();
    await supervisor.idle();
    expect(world.tasks()["a-1"]?.state).toBe("done");
    expect(holdOf(world, "a-2")).toBe("議題在待辦，不開新工作");
    expect(world.query.calls).toHaveLength(1);
    world.moveTopics({ normal: ["a"] });
    supervisor.tick();
    gates[1]?.open();
    await supervisor.idle();
    expect(world.tasks()["a-2"]?.state).toBe("done");
    supervisor.close();
  });

  it("starts nothing for a topic that was archived", async () => {
    const world = new World({ normal: ["a"] });
    world.seedQueued([{ id: "a-1", topic: "a" }]);
    world.moveTopics({});
    writeFileSync(
      join(world.home, "data", "topics-archive.json"),
      JSON.stringify({ topics: { a: {} } }),
    );
    const supervisor = await world.start();
    supervisor.tick();
    await settle();
    expect(world.query.calls).toEqual([]);
    expect(holdOf(world, "a-1")).toBe(WAIT.gone);
    supervisor.close();
  });
});

const RESETS_AT_S = START_MS / 1000 + 3600;

/** a-1 hits the quota while b-1 runs; c-1 waits. */
async function quotaWorld(): Promise<{ world: World; supervisor: Supervisor; gates: Gate[] }> {
  const world = new World({ normal: ["a", "b", "c"] });
  world.seedQueued(["a", "b", "c"].map((topic) => ({ id: `${topic}-1`, topic })));
  const gates = gated(world, 2, (n) =>
    n === 0
      ? [init("a-session"), rejected(RESETS_AT_S), errorResult(["rate limited"], 429)]
      : [init("b-session"), result(workerOutput("report"))],
  );
  const supervisor = await world.start();
  supervisor.tick();
  await settle();
  gates[0]?.open();
  await settle();
  return { world, supervisor, gates };
}

describe("the quota stop", () => {
  it("stops dispatching, leaves the running worker alone and opens a hold that says so", async () => {
    const { world, supervisor, gates } = await quotaWorld();
    const until = "2026-11-27T03:00:00Z";
    expect(world.tasks()["a-1"]).toMatchObject({ state: "paused", session_id: "a-session" });
    expect(world.holds()["a-1"]).toMatchObject({
      state: "open",
      title: "額度用盡或被限流",
      hold_until: until,
    });
    expect(running(world)).toEqual(["b-1"]);
    expect(holdOf(world, "c-1")).toBe(WAIT.quota(until));
    gates[1]?.open();
    await supervisor.idle();
    expect(world.tasks()["b-1"]?.state).toBe("done");
    expect(world.query.calls).toHaveLength(2);
    expect(world.commands.allWorktrees()).toContain(join(world.root, "a-1"));
    supervisor.close();
  });

  it("resumes when the time comes: the paused task's session first, then the queue", async () => {
    const { world, supervisor, gates } = await quotaWorld();
    gates[1]?.open();
    await supervisor.idle();
    world.query.worker.push({ messages: [init("a-session"), result(workerOutput("report"))] });
    world.query.worker.push({ messages: [init("c-session"), result(workerOutput("report"))] });
    world.nowMs = RESETS_AT_S * 1000;
    supervisor.tick();
    await supervisor.idle();
    expect(world.holds()["a-1"]?.state).toBe("closed");
    const [, , resumed, next] = world.query.calls;
    expect(resumed?.options.resume).toBe("a-session");
    expect(resumed?.options.cwd).toBe(join(world.root, "a-1"));
    expect(resumed?.prompts).toEqual([RESUME_PROMPT]);
    expect(next?.options.cwd).toBe(join(world.root, "c-1"));
    expect(world.tasks()["a-1"]?.state).toBe("done");
    supervisor.close();
  });

  it("resumes at once when the captain answers 現在恢復", async () => {
    const { world, supervisor, gates } = await quotaWorld();
    gates[1]?.open();
    await supervisor.idle();
    const record = { v: 1, id: "w-9", kind: "answer", answer: "現在恢復", label: "現在恢復" };
    writeFileSync(
      join(world.agg, "answers", "a-1.json"),
      JSON.stringify({ v: 1, received_ms: 1, record }),
    );
    world.query.worker.push({ messages: [init("a-session"), result(workerOutput("report"))] });
    world.query.worker.push({ messages: [init("c-session"), result(workerOutput("report"))] });
    supervisor.tick();
    await supervisor.idle();
    expect(world.holds()["a-1"]?.state).toBe("closed");
    expect(existsSync(join(world.agg, "answers", "handled", "a-1.w-9.json"))).toBe(true);
    expect(world.query.calls).toHaveLength(4);
    supervisor.close();
  });

  it("keeps waiting when the captain answers 等它自己恢復", async () => {
    const { world, supervisor, gates } = await quotaWorld();
    gates[1]?.open();
    await supervisor.idle();
    const record = {
      v: 1,
      id: "w-8",
      kind: "answer",
      answer: "等它自己恢復",
      label: "等它自己恢復",
    };
    writeFileSync(
      join(world.agg, "answers", "a-1.json"),
      JSON.stringify({ v: 1, received_ms: 1, record }),
    );
    supervisor.tick();
    await settle();
    expect(world.holds()["a-1"]?.state).toBe("closed");
    expect(world.query.calls).toHaveLength(2);
    expect(holdOf(world, "c-1")).toBe(WAIT.quota("2026-11-27T03:00:00Z"));
    supervisor.close();
  });

  it("keeps the stop across a restart", async () => {
    const { world, supervisor, gates } = await quotaWorld();
    gates[1]?.open();
    await supervisor.idle();
    supervisor.close();
    const again = await world.start();
    again.tick();
    await settle();
    expect(world.query.calls).toHaveLength(2);
    expect(holdOf(world, "c-1")).toBe(WAIT.quota("2026-11-27T03:00:00Z"));
    again.close();
  });
});

describe("a queued task whose repo left the settings", () => {
  it("is taken off the queue without being claimed", async () => {
    const world = new World({ normal: ["a"] });
    world.seedQueued([{ id: "a-1", topic: "a" }]);
    const queued = world.queued().map((entry) => ({ ...entry, repo: "gone" }));
    writeFileSync(join(world.agg, "queued.json"), JSON.stringify({ v: 1, queued }));
    world.query.planner.push({ messages: [init("p", "default"), result(plan([]))] });
    const supervisor = await world.start();
    supervisor.tick();
    await supervisor.idle();
    expect(world.queued()).toEqual([]);
    expect(world.tasks()).toEqual({});
    expect(world.logs.some((line) => line.includes("repo gone is not in the settings"))).toBe(true);
    supervisor.close();
  });
});

describe("restart reconciliation", () => {
  it("pauses workers that are gone, drops a task queued twice and never takes one task twice", async () => {
    const world = new World({ normal: ["a", "b", "c"] });
    world.seedQueued(["a", "b", "c"].map((topic) => ({ id: `${topic}-1`, topic })));
    gated(world, 2);
    const crashed = await world.start();
    crashed.tick();
    await settle();
    expect(running(world)).toEqual(["a-1", "b-1"]);
    world.query.active.clear();
    const queued = world.queued();
    world.seedQueued([
      { id: "a-1", topic: "a" },
      ...queued.map((entry) => ({ id: entry.id, topic: entry.topic_hint })),
    ]);
    const git = world.commands.worktrees.get(REPO) ?? new Set<string>();
    git.delete(join(world.root, "b-1"));
    git.add(join(world.root, "stray"));
    mkdirSync(join(world.root, "stray"));

    world.query.worker.push({ messages: [init("c"), result(workerOutput("report"))] });
    const supervisor = await world.start();
    expect(world.tasks()["a-1"]).toMatchObject({
      state: "paused",
      detail: "supervisor 重啟時這個 worker 已經不在了，等 captain 決定接著做或結束",
      worktree: join(world.root, "a-1"),
    });
    expect(world.tasks()["b-1"]?.worktree).toBeUndefined();
    expect(world.queued().map((entry) => entry.id)).toEqual(["c-1"]);
    expect(world.logs.some((line) => line.includes("stray belongs to no task"))).toBe(true);
    supervisor.tick();
    await supervisor.idle();
    const cwds = world.query.calls.map((call) => call.options.cwd.split("/").at(-1));
    expect(cwds).toEqual(["a-1", "b-1", "c-1"]);
    expect(world.tasks()["a-1"]?.state).toBe("paused");
    const listed = [...(world.commands.worktrees.get(REPO) ?? [])].filter(
      (path) => path !== join(world.root, "stray"),
    );
    const recorded = Object.values(world.tasks()).flatMap((task) =>
      task.worktree === undefined ? [] : [task.worktree],
    );
    expect(listed.toSorted()).toEqual(recorded.toSorted());
    supervisor.close();
  });

  it("finishes the cleanup a crash cut off", async () => {
    const world = new World({ normal: ["a"] });
    world.seedQueued([{ id: "a-1", topic: "a" }]);
    world.query.worker.push({ messages: [init("s"), result(workerOutput("report"))] });
    const first = await world.start();
    first.tick();
    await first.idle();
    first.close();
    const tasks = world.tasks();
    tasks["a-1"] = {
      ...tasks["a-1"],
      kind: "ship",
      state: "done",
      worktree: join(world.root, "a-1"),
    };
    writeFileSync(join(world.agg, "tasks.json"), JSON.stringify({ v: 1, tasks }));
    world.commands.worktrees.get(REPO)?.add(join(world.root, "a-1"));
    const supervisor = await world.start();
    expect(world.tasks()["a-1"]?.worktree).toBeUndefined();
    expect(world.events("a-1").at(-1)).toBe("task.cleaned_up");
    supervisor.close();
  });
});
