// Property test of the supervisor over random runs (a seeded generator, no
// dependency): sessions end in random ways (questions and todos included),
// topics move to 待辦 and back, the clock jumps past quota stops, the captain
// answers holds, sends directs and messages and claims todos, and the
// supervisor restarts while sessions still hang. After every step: never more
// than 2 sessions run, never 2 on one topic or one task, no task is in both
// tasks.json and queued.json, and no task is ever started fresh twice.

import { afterAll, describe, expect, it } from "vitest";

import { generator } from "./fixtures.test-helper.js";
import {
  errorResult,
  Gate,
  init,
  maxTurns,
  plan,
  rejected,
  removeScratch,
  result,
  workerOutput,
} from "./harness.test-helper.js";
import { MAX_RUNNING } from "./scheduler.js";
import type { Supervisor } from "./supervisor.js";
import { World } from "./world.test-helper.js";

afterAll(removeScratch);

const CASES = 40;
const STEPS = 25;
const TOPICS = ["t0", "t1", "t2", "t3"];

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const QUESTION = { title: "Q", text: "q", options: ["A", "B"] };
const TODO = { id: "vpn", title: "VPN", do: "登入", cmds: [] };

function outcome(pick: number): object[] {
  if (pick < 0.3) return [init("s"), result(workerOutput("report"))];
  if (pick < 0.45) return [init("s"), result(workerOutput("failed"))];
  if (pick < 0.6) return [init("s"), rejected(), errorResult(["limit"], 429)];
  if (pick < 0.7) return [init("s"), maxTurns()];
  if (pick < 0.85) return [init("s"), result(workerOutput("report", { question: QUESTION }))];
  return [init("s"), result(workerOutput("report", { todos: [TODO] }))];
}

/** One thing the captain does on the page, picked at random. */
function captain(world: World, random: () => number): void {
  const tasks = Object.keys(world.tasks());
  const task = tasks[Math.floor(random() * tasks.length)];
  const pick = random();
  if (pick < 0.35) {
    const open = Object.entries(world.holds()).filter(([, hold]) => hold.state === "open");
    const held = open[Math.floor(random() * open.length)];
    if (held !== undefined) world.answer(held[0], "A");
  } else if (pick < 0.6 && task !== undefined) {
    world.deliver({ kind: "direct", home: "main", task, text: "直送" });
  } else if (pick < 0.8) {
    const topic = TOPICS[Math.floor(random() * TOPICS.length)] ?? "t0";
    world.deliver({ kind: "message", topic: { id: topic, name: topic }, text: "訊息" });
  } else {
    const blocked = tasks.filter((id) => world.tasks()[id]?.state === "blocked");
    world.boardTodos(
      Object.fromEntries(blocked.map((id) => [`${id}-vpn`, { state: "claimed", ref: id }])),
    );
    for (const id of blocked) {
      const item = { id: `${id}-vpn`, title: "VPN", ref: id };
      world.deliver({ kind: "notice", event: "todo.claimed", text: "t", item });
    }
  }
}

interface Run {
  world: World;
  supervisor: Supervisor;
  /** Sessions of a supervisor that "crashed": they hang for good. */
  abandoned: Set<object>;
}

function check(run: Run, context: string): void {
  const { world } = run;
  const active = [...world.query.active].map((call) => call.options.cwd.split("/").at(-1) ?? "");
  expect(active.length, context).toBeLessThanOrEqual(MAX_RUNNING);
  expect(new Set(active).size, `${context}: one task twice`).toBe(active.length);
  const topics = active.map((id) => id.replace(/-\d+$/, ""));
  expect(new Set(topics).size, context).toBe(topics.length);
  const queued = new Set(world.queued().map((entry) => entry.id));
  for (const id of Object.keys(world.tasks()))
    expect(queued.has(id), `${context}: ${id}`).toBe(false);
  const fresh = new Map<string, number>();
  for (const call of world.query.calls) {
    if (call.options.cwd === world.plannerDir || call.options.resume !== undefined) continue;
    fresh.set(call.options.cwd, (fresh.get(call.options.cwd) ?? 0) + 1);
  }
  for (const [cwd, count] of fresh) expect(count, `${context}: ${cwd} started fresh twice`).toBe(1);
}

async function step(run: Run, random: () => number): Promise<void> {
  const { world } = run;
  const pick = random();
  if (pick < 0.4) {
    const open = [...world.query.active].filter((call) => !run.abandoned.has(call));
    open[Math.floor(random() * open.length)]?.script?.gate?.open();
  } else if (pick < 0.55) {
    const later = TOPICS.filter(() => random() < 0.3);
    world.moveTopics({ normal: TOPICS.filter((topic) => !later.includes(topic)), later });
    run.supervisor.tick();
  } else if (pick < 0.65) {
    world.nowMs += 3_600_000;
    run.supervisor.tick();
  } else if (pick < 0.8) {
    captain(world, random);
    run.supervisor.tick();
  } else if (pick < 0.9) {
    run.supervisor.tick();
  } else {
    for (const call of world.query.active) run.abandoned.add(call);
    world.query.active.clear();
    run.supervisor.close();
    run.supervisor = await world.start();
    run.supervisor.tick();
  }
  await settle();
}

describe("the supervisor over random runs", () => {
  it(`keeps its limits and never takes a task twice (${CASES} seeds × ${STEPS} steps)`, async () => {
    const resumedWith = { answer: 0, direct: 0, todos: 0 };
    for (let seed = 1; seed <= CASES; seed += 1) {
      const random = generator(seed);
      const world = new World({ normal: TOPICS });
      const count = 2 + Math.floor(random() * 5);
      world.seedQueued(
        Array.from({ length: count }, (_, i) => ({
          id: `${TOPICS[Math.floor(random() * 4)] ?? "t0"}-${i + 1}`,
          topic: "",
        })).map((entry) => ({ ...entry, topic: entry.id.replace(/-\d+$/, "") })),
      );
      for (let i = 0; i < 120; i += 1) {
        world.query.worker.push({ messages: outcome(random()), gate: new Gate() });
        world.query.planner.push({ messages: [init("p", "dontAsk"), result(plan([]))] });
      }
      const run: Run = { world, supervisor: await world.start(), abandoned: new Set() };
      run.supervisor.tick();
      await settle();
      for (let s = 0; s < STEPS; s += 1) {
        await step(run, random);
        check(run, `seed ${seed}, step ${s}`);
      }
      run.supervisor.close();
      for (const call of world.query.calls) {
        const first = call.prompts[0] ?? "";
        if (call.options.resume === undefined) continue;
        if (first.includes("在看板上的答覆")) resumedWith.answer += 1;
        if (first.includes("直送的話")) resumedWith.direct += 1;
        if (first.includes("要你動手的事")) resumedWith.todos += 1;
      }
    }
    expect(
      Object.values(resumedWith).every((count) => count > 0),
      JSON.stringify(resumedWith),
    ).toBe(true);
  }, 60_000);
});
