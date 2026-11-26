// Property test of the supervisor over random runs (a seeded generator, no
// dependency): sessions end in random ways, topics move to 待辦 and back, the
// clock jumps past quota stops, and the supervisor restarts while sessions
// still hang. After every step: never more than 2 sessions run, never 2 on
// one topic, no task is in both tasks.json and queued.json, and no task is
// ever started fresh twice.

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

function outcome(pick: number): object[] {
  if (pick < 0.4) return [init("s"), result(workerOutput("report"))];
  if (pick < 0.6) return [init("s"), result(workerOutput("failed"))];
  if (pick < 0.8) return [init("s"), rejected(), errorResult(["limit"], 429)];
  return [init("s"), maxTurns()];
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
  const topics = active.map((id) => id.replace(/-\d+$/, ""));
  expect(new Set(topics).size, context).toBe(topics.length);
  const queued = new Set(world.queued().map((entry) => entry.id));
  for (const id of Object.keys(world.tasks()))
    expect(queued.has(id), `${context}: ${id}`).toBe(false);
  const fresh = new Map<string, number>();
  for (const call of world.query.calls) {
    if (call.options.cwd === world.root || call.options.resume !== undefined) continue;
    fresh.set(call.options.cwd, (fresh.get(call.options.cwd) ?? 0) + 1);
  }
  for (const [cwd, count] of fresh) expect(count, `${context}: ${cwd} started fresh twice`).toBe(1);
}

async function step(run: Run, random: () => number): Promise<void> {
  const { world } = run;
  const pick = random();
  if (pick < 0.45) {
    const open = [...world.query.active].filter((call) => !run.abandoned.has(call));
    open[Math.floor(random() * open.length)]?.script?.gate?.open();
  } else if (pick < 0.65) {
    const later = TOPICS.filter(() => random() < 0.3);
    world.moveTopics({ normal: TOPICS.filter((topic) => !later.includes(topic)), later });
    run.supervisor.tick();
  } else if (pick < 0.8) {
    world.nowMs += 3_600_000;
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
      for (let i = 0; i < 60; i += 1) {
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
    }
  }, 60_000);
});
