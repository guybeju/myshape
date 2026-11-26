// Property test of the supervisor with the board's schedules over random runs
// (a seeded generator, no dependency): the board's clock opens occurrences
// and sends their notices, time passes, occurrences come due and end, the
// captain closes one on the page, missed notices land with any rt, sessions
// end, and the supervisor restarts while sessions still hang. After every
// step: never more than 2 sessions run and never 2 on one topic, no
// occurrence is taken or closed more than once, an occurrence's work never
// runs before its time, and the only schedule writes are take and close done.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { generator } from "./fixtures.test-helper.js";
import {
  Gate,
  init,
  plan,
  removeScratch,
  result,
  workerOutput,
  type Call,
} from "./harness.test-helper.js";
import { keyAt, workOf } from "./occurrences.js";
import { MAX_RUNNING } from "./scheduler.js";
import type { Supervisor } from "./supervisor.js";
import { World } from "./world.test-helper.js";

afterAll(removeScratch);

const CASES = 30;
const STEPS = 30;
const MIN = 60_000;
const SERIES = ["s0", "s1"];
const RTS = ["none", "soft-rt", "hard-rt"];

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function compact(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replaceAll(/[-:]/g, "") + "Z";
}

interface Run {
  world: World;
  supervisor: Supervisor;
  random: () => number;
  rts: Record<string, string>;
  abandoned: Set<object>;
  /** Every key the clock has opened: the board never opens one key twice. */
  used: Set<string>;
}

function seriesOf(rts: Record<string, string>): Record<string, { topic: string; rt: string }> {
  return Object.fromEntries(SERIES.map((id) => [id, { topic: id, rt: rts[id] ?? "none" }]));
}

function open(run: Run): Record<string, Record<string, unknown>> {
  return run.world.schedulesDoc().occurrences;
}

/** The board's clock opens an occurrence of a schedule that has none open, with its notice. */
function openOne(run: Run): void {
  const { world, random } = run;
  const busy = new Set(Object.values(open(run)).map((o) => o["series"]));
  const series = SERIES.find((id) => !busy.has(id) && random() < 0.7);
  if (series === undefined) return;
  const lead = Math.floor(random() * 3) * 10;
  const at = Math.ceil((world.nowMs + lead * MIN) / MIN) * MIN;
  const key = `${series}:${compact(at)}`;
  if (run.used.has(key)) return;
  run.used.add(key);
  const state = lead === 0 ? "due" : "upcoming";
  world.writeSchedules(seriesOf(run.rts), { [key]: { at: new Date(at).toISOString(), state } });
  if (random() < 0.85)
    world.notice(state === "due" ? "schedule.due" : "schedule.upcoming", key, series);
}

/** Time passes: occurrences come due (a due notice unless taken) and end at closes_by. */
function advance(run: Run): void {
  const { world, random } = run;
  world.nowMs += Math.ceil(random() * 40) * MIN;
  const doc = world.schedulesDoc();
  for (const [key, o] of Object.entries(doc.occurrences)) {
    if (Date.parse(String(o["closes_by"])) <= world.nowMs) {
      world.endOccurrence(key);
    } else if (o["state"] === "upcoming" && Date.parse(String(o["at"])) <= world.nowMs) {
      world.writeSchedules(seriesOf(run.rts), { [key]: { at: String(o["at"]), state: "due" } });
      world.notice("schedule.due", key, String(o["series"]));
    }
  }
}

async function step(run: Run): Promise<void> {
  const { world, random } = run;
  const pick = random();
  if (pick < 0.3) {
    const live = [...world.query.active].filter((call) => !run.abandoned.has(call));
    live[Math.floor(random() * live.length)]?.script?.gate?.open();
  } else if (pick < 0.45) {
    openOne(run);
  } else if (pick < 0.65) {
    advance(run);
  } else if (pick < 0.72) {
    const [key] = Object.keys(open(run));
    if (key !== undefined) {
      world.endOccurrence(key);
      world.notice("schedule.closed", key, key.split(":")[0] ?? "");
    }
  } else if (pick < 0.8) {
    const series = SERIES[Math.floor(random() * SERIES.length)] ?? "s0";
    const key = `${series}:${compact(world.nowMs - 26 * 60 * MIN)}`;
    const rt = RTS[Math.floor(random() * RTS.length)] ?? "none";
    world.notice("schedule.missed", key, series, { rt });
  } else if (pick < 0.9) {
    for (const call of world.query.active) run.abandoned.add(call);
    world.query.active.clear();
    run.supervisor.close();
    run.supervisor = await world.start();
  }
  run.supervisor.tick();
  await settle();
}

/**
 * The topic a running session works on, read apart from the supervisor: a
 * worker's from its task's tag file, the planner's from its prompt's topic frame.
 */
function topicOfSession(world: World, call: Call): string {
  if (call.options.cwd === world.root)
    return /"id": "([^"]+)"/.exec(call.prompts[0] ?? "")?.[1] ?? "";
  const task = call.options.cwd.split("/").at(-1) ?? "";
  const tag = join(world.agg, "tags", task);
  const lines = existsSync(tag) ? readFileSync(tag, "utf8").split("\n").filter(Boolean) : [];
  return lines.at(-1)?.split(" ")[0] ?? "";
}

function check(run: Run, context: string): void {
  const { world, supervisor } = run;
  expect(world.query.active.size, context).toBeLessThanOrEqual(MAX_RUNNING);
  const topics = [...world.query.active].map((call) => topicOfSession(world, call));
  expect(new Set(topics).size, `${context}: two on one topic`).toBe(topics.length);
  expect(supervisor.snapshot().running.length, context).toBeLessThanOrEqual(MAX_RUNNING);
  const writes = world.commands.scheduleCalls();
  for (const args of writes) {
    expect(["take", "close"], context).toContain(args[1]);
    if (args[1] === "close") expect(args[3], context).toBe("done");
  }
  for (const op of ["take", "close"]) {
    const keys = writes.filter((args) => args[1] === op).map((args) => args[2]);
    expect(new Set(keys).size, `${context}: one occurrence sent ${op} twice`).toBe(keys.length);
  }
  for (const call of world.query.active) {
    const ref = workOf(call.options.cwd.split("/").at(-1) ?? "");
    if (ref !== undefined && !ref.makeUp)
      expect(Date.parse(keyAt(ref.key)), `${context}: ${ref.key} ran early`).toBeLessThanOrEqual(
        world.nowMs,
      );
  }
}

describe("the supervisor with schedules over random runs", () => {
  it(`keeps its limits and takes and closes each occurrence at most once (${CASES} seeds × ${STEPS} steps)`, async () => {
    const seen = { take: 0, close: 0, makeUp: 0, report: 0 };
    for (let seed = 1; seed <= CASES; seed += 1) {
      const random = generator(seed);
      const world = new World({ normal: ["t0", "t1"], later: SERIES });
      const rts = Object.fromEntries(SERIES.map((id) => [id, RTS[Math.floor(random() * 3)] ?? ""]));
      world.writeSchedules(seriesOf(rts));
      for (let i = 0; i < 150; i += 1) {
        const outcome = random() < 0.7 ? "report" : "failed";
        world.query.worker.push({
          messages: [init("w"), result(workerOutput(outcome))],
          gate: new Gate(),
        });
        const tasks =
          random() < 0.8 ? [{ title: "做", repo: "app", kind: "scout", prompt: "p" }] : [];
        world.query.planner.push({ messages: [init("p", "dontAsk"), result(plan(tasks))] });
      }
      const run: Run = {
        world,
        supervisor: await world.start(),
        random,
        rts,
        abandoned: new Set(),
        used: new Set(),
      };
      run.supervisor.tick();
      await settle();
      for (let s = 0; s < STEPS; s += 1) {
        await step(run);
        check(run, `seed ${seed}, step ${s}`);
      }
      run.supervisor.close();
      const writes = world.commands.scheduleCalls();
      seen.take += writes.filter((args) => args[1] === "take").length;
      seen.close += writes.filter((args) => args[1] === "close").length;
      seen.makeUp += Object.keys(world.tasks()).filter((id) => workOf(id)?.makeUp === true).length;
      seen.report += world.commands.summaries.filter((entry) =>
        entry.task.endsWith("-missed"),
      ).length;
    }
    expect(
      Object.values(seen).every((count) => count > 0),
      JSON.stringify(seen),
    ).toBe(true);
  }, 120_000);
});
