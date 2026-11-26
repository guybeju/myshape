// Step 7 of the plan (section 3.8): the board's schedule notices. A coming-up
// notice is taken at once and keeps a place free without stopping anything;
// work starts only at the occurrence's time, for a topic that stays in 待辦;
// the occurrence is closed done when its work ends; a missed one is made up
// once (soft-rt) or reported (hard-rt, none). A restart neither takes an
// occurrence twice nor loses one. The fake board plays take and close against
// the scratch home's schedules.json, as the board does.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { Gate, init, plan, removeScratch, result, workerOutput } from "./harness.test-helper.js";
import { NOTE } from "./occurrences.js";
import { SCHEDULE_LOG } from "./schedule-step.js";
import { WAIT } from "./scheduler.js";
import type { Supervisor } from "./supervisor.js";
import { World } from "./world.test-helper.js";

afterAll(removeScratch);

const KEY = "weekly:20261127T0215Z";
const AT = "2026-11-27T02:15:00Z";
const WORK = "weekly-at-20261127T0215Z-1";

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function pass(supervisor: Supervisor): Promise<void> {
  supervisor.tick();
  await settle();
}

function running(world: World): string[] {
  return [...world.query.active].map((call) => call.options.cwd.split("/").at(-1) ?? "");
}

function planOne(world: World, title = "整理紀錄"): void {
  world.query.planner.push({
    messages: [
      init("p", "dontAsk"),
      result(plan([{ title, repo: "app", kind: "scout", prompt: "照目標做" }])),
    ],
  });
}

/** A world with the scheduled topic `weekly` in 待辦, and these ordinary topics. */
function scheduled(rt = "none", normal: string[] = []): World {
  const world = new World({ normal, later: ["weekly"] });
  world.writeSchedules({ weekly: { topic: "weekly", rt } }, { [KEY]: { at: AT } });
  return world;
}

function takes(world: World): string[][] {
  return world.commands.scheduleCalls().filter((args) => args[1] === "take");
}

describe("a coming-up occurrence", () => {
  it("is taken on its notice, and nothing starts for it before its time", async () => {
    const world = scheduled();
    const supervisor = await world.start();
    world.notice("schedule.upcoming", KEY, "weekly");
    await pass(supervisor);
    expect(takes(world)).toEqual([["schedule", "take", KEY, "--note", NOTE.take]]);
    expect(world.schedulesDoc().occurrences[KEY]?.["state"]).toBe("taken");
    expect(world.inbox().waiting).toEqual([]);
    expect(world.query.calls).toEqual([]);
    world.nowMs = Date.parse(AT) - 1;
    await pass(supervisor);
    expect(world.query.calls).toEqual([]);
    expect(takes(world)).toHaveLength(1);
    supervisor.close();
  });

  it("keeps a place free from other work, and stops none that runs", async () => {
    const world = scheduled("none", ["a", "b"]);
    world.seedQueued([
      { id: "a-1", topic: "a" },
      { id: "b-1", topic: "b" },
    ]);
    const gate = new Gate();
    world.query.worker.push({ messages: [init("w"), result(workerOutput("report"))], gate });
    const supervisor = await world.start();
    world.notice("schedule.upcoming", KEY, "weekly");
    await pass(supervisor);
    expect(running(world)).toEqual(["a-1"]);
    expect(world.queued().map((entry) => [entry.id, entry.hold])).toEqual([
      ["b-1", WAIT.reserved(KEY)],
    ]);
    world.nowMs = Date.parse(AT);
    planOne(world);
    world.query.worker.push({ messages: [init("w2"), result(workerOutput("report"))] });
    await pass(supervisor);
    expect(running(world)).toContain("a-1");
    expect(world.tasks()[WORK]?.state).toBe("done");
    gate.open();
    await supervisor.idle();
    supervisor.close();
  });
});

describe("an occurrence at its time", () => {
  it("is planned from its topic's goal, dispatched though the topic is in 待辦, and closed done", async () => {
    const world = scheduled();
    const supervisor = await world.start();
    world.notice("schedule.upcoming", KEY, "weekly");
    await pass(supervisor);
    world.nowMs = Date.parse(AT);
    planOne(world);
    const gate = new Gate();
    world.query.worker.push({ messages: [init("w"), result(workerOutput("report"))], gate });
    await pass(supervisor);
    expect(world.query.calls[0]?.prompts[0]).toContain("目標 weekly");
    expect(running(world)).toEqual([WORK]);
    expect(world.commands.scheduleCalls().filter((args) => args[1] === "close")).toEqual([]);
    gate.open();
    await supervisor.idle();
    await pass(supervisor);
    expect(world.commands.scheduleCalls()).toEqual([
      ["schedule", "take", KEY, "--note", NOTE.take],
      ["schedule", "close", KEY, "done", "--note", NOTE.ended([`${WORK} done`])],
    ]);
    expect(world.schedulesDoc().occurrences[KEY]).toBeUndefined();
    expect(world.boardWrites().some((args) => args[0] === "close-propose")).toBe(false);
    supervisor.close();
  });

  it("is taken on its due notice when nothing took it before", async () => {
    const world = scheduled();
    world.nowMs = Date.parse(AT);
    world.writeSchedules({ weekly: { topic: "weekly" } }, { [KEY]: { at: AT, state: "due" } });
    planOne(world);
    world.query.worker.push({ messages: [init("w"), result(workerOutput("report"))] });
    const supervisor = await world.start();
    world.notice("schedule.due", KEY, "weekly");
    await pass(supervisor);
    await supervisor.idle();
    await pass(supervisor);
    expect(world.commands.scheduleCalls().map((args) => args.slice(0, 3))).toEqual([
      ["schedule", "take", KEY],
      ["schedule", "close", KEY],
    ]);
    supervisor.close();
  });

  it("is closed done when its planner finds nothing to do", async () => {
    const world = scheduled();
    world.nowMs = Date.parse(AT);
    world.query.planner.push({ messages: [init("p", "dontAsk"), result(plan([]))] });
    const supervisor = await world.start();
    await pass(supervisor);
    await supervisor.idle();
    await pass(supervisor);
    expect(world.commands.scheduleCalls()).toEqual([
      ["schedule", "take", KEY, "--note", NOTE.takeDue],
      ["schedule", "close", KEY, "done", "--note", NOTE.nothing],
    ]);
    supervisor.close();
  });

  it("is planned again for the schedule's next occurrence", async () => {
    const world = scheduled();
    world.nowMs = Date.parse(AT);
    planOne(world);
    world.query.worker.push({ messages: [init("w"), result(workerOutput("report"))] });
    const supervisor = await world.start();
    await pass(supervisor);
    await supervisor.idle();
    await pass(supervisor);
    const next = "weekly:20261128T0215Z";
    world.nowMs = Date.parse("2026-11-28T02:15:00Z");
    world.writeSchedules(
      { weekly: { topic: "weekly" } },
      { [next]: { at: "2026-11-28T02:15:00Z" } },
    );
    planOne(world);
    world.query.worker.push({ messages: [init("w2"), result(workerOutput("report"))] });
    await pass(supervisor);
    await supervisor.idle();
    await pass(supervisor);
    expect(Object.keys(world.tasks())).toEqual([WORK, "weekly-at-20261128T0215Z-1"]);
    expect(world.commands.scheduleCalls().map((args) => args.slice(1, 3))).toEqual([
      ["take", KEY],
      ["close", KEY],
      ["take", next],
      ["close", next],
    ]);
    supervisor.close();
  });

  it("starts nothing for a schedule that does not ring, and takes nothing for it", async () => {
    const world = new World({ normal: [], later: ["weekly"] });
    world.writeSchedules(
      { weekly: { topic: "weekly", state: "paused" } },
      { [KEY]: { at: AT, state: "due" } },
    );
    world.nowMs = Date.parse(AT);
    const supervisor = await world.start();
    world.notice("schedule.due", KEY, "weekly");
    await pass(supervisor);
    expect(world.query.calls).toEqual([]);
    expect(world.commands.scheduleCalls()).toEqual([]);
    expect(world.logs).toContain(SCHEDULE_LOG.silent(KEY));
    supervisor.close();
  });

  it("drops queued work whose occurrence ended before it started, and keeps the rest", async () => {
    const world = scheduled("none", ["a"]);
    world.nowMs = Date.parse(AT);
    world.seedQueued([
      { id: WORK, topic: "weekly" },
      { id: "weekly-at-20261126T0215Z-makeup-1", topic: "weekly" },
      { id: "a-1", topic: "a" },
    ]);
    world.endOccurrence(KEY);
    const gates = [new Gate(), new Gate()];
    for (const gate of gates)
      world.query.worker.push({ messages: [init("w"), result(workerOutput("report"))], gate });
    const supervisor = await world.start();
    await pass(supervisor);
    expect(world.logs).toContain(
      `${WORK}: its occurrence ended before it started; taken off the queue`,
    );
    expect(running(world).toSorted()).toEqual(["a-1", "weekly-at-20261126T0215Z-makeup-1"]);
    expect(world.tasks()[WORK]).toBeUndefined();
    for (const gate of gates) gate.open();
    await supervisor.idle();
    supervisor.close();
  });
});

describe("a restart", () => {
  it("does not take an occurrence twice, and still starts and closes it", async () => {
    const world = scheduled();
    let supervisor = await world.start();
    world.notice("schedule.upcoming", KEY, "weekly");
    await pass(supervisor);
    supervisor.close();
    supervisor = await world.start();
    world.notice("schedule.upcoming", KEY, "weekly");
    await pass(supervisor);
    expect(takes(world)).toHaveLength(1);
    world.nowMs = Date.parse(AT);
    planOne(world);
    world.query.worker.push({ messages: [init("w"), result(workerOutput("report"))] });
    await pass(supervisor);
    await supervisor.idle();
    await pass(supervisor);
    expect(takes(world)).toHaveLength(1);
    expect(world.commands.scheduleCalls().filter((args) => args[1] === "close")).toHaveLength(1);
    supervisor.close();
  });

  it("does not plan an occurrence again whose work is queued, and closes one whose close was lost", async () => {
    const world = scheduled();
    world.nowMs = Date.parse(AT);
    planOne(world);
    const gate = new Gate();
    world.query.worker.push({ messages: [init("w"), result(workerOutput("report"))], gate });
    let supervisor = await world.start();
    await pass(supervisor);
    world.commands.closeStatus = 3;
    gate.open();
    await supervisor.idle();
    expect(world.logs.some((line) => line.startsWith(`occurrence ${KEY} was not closed`))).toBe(
      true,
    );
    supervisor.close();
    world.commands.closeStatus = 0;
    supervisor = await world.start();
    await pass(supervisor);
    expect(world.query.calls.filter((call) => call.options.cwd === world.root)).toHaveLength(1);
    expect(world.schedulesDoc().occurrences[KEY]).toBeUndefined();
    expect(takes(world)).toHaveLength(1);
    supervisor.close();
  });
});

describe("a missed occurrence", () => {
  const MISSED = "weekly:20261126T0215Z";

  it("is made up once when soft-rt, though its topic is in 待辦", async () => {
    const world = scheduled("soft-rt");
    world.writeSchedules({ weekly: { topic: "weekly", rt: "soft-rt" } });
    world.endOccurrence(KEY);
    planOne(world, "補做");
    world.query.worker.push({ messages: [init("w"), result(workerOutput("report"))] });
    const supervisor = await world.start();
    world.notice("schedule.missed", MISSED, "weekly", {
      rt: "soft-rt",
      expires_at: AT,
    });
    await pass(supervisor);
    await supervisor.idle();
    await pass(supervisor);
    expect(Object.keys(world.tasks())).toEqual(["weekly-at-20261126T0215Z-makeup-1"]);
    expect(world.tasks()["weekly-at-20261126T0215Z-makeup-1"]?.state).toBe("done");
    expect(world.inbox().waiting).toEqual([]);
    expect(world.commands.scheduleCalls()).toEqual([]);
    supervisor.close();
    const again = await world.start();
    world.notice("schedule.missed", MISSED, "weekly", { rt: "soft-rt" });
    await pass(again);
    expect(world.query.calls.filter((call) => call.options.cwd === world.root)).toHaveLength(1);
    expect(world.logs).toContain(SCHEDULE_LOG.madeUp(MISSED));
    again.close();
  });

  it("is not made up once its notice has expired", async () => {
    const world = scheduled("soft-rt");
    world.nowMs = Date.parse(AT);
    world.endOccurrence(KEY);
    const supervisor = await world.start();
    world.notice("schedule.missed", MISSED, "weekly", { rt: "soft-rt", expires_at: AT });
    await pass(supervisor);
    expect(world.query.calls).toEqual([]);
    expect(world.logs).toContain(SCHEDULE_LOG.expired(MISSED));
    supervisor.close();
  });

  it.each(["hard-rt", "none"])(
    "is reported under its topic when %s, and not made up",
    async (rt) => {
      const world = scheduled(rt);
      world.endOccurrence(KEY);
      const supervisor = await world.start();
      world.notice("schedule.missed", MISSED, "weekly", { rt });
      await pass(supervisor);
      const id = "weekly-at-20261126T0215Z-missed";
      expect(world.commands.summaries).toEqual([
        {
          task: id,
          kind: "report",
          text: expect.stringContaining(`排程的這一場 ${MISSED}`) as string,
        },
      ]);
      const tag = join(world.agg, "tags", id);
      expect(existsSync(tag) ? readFileSync(tag, "utf8") : "").toMatch(/^weekly \S+Z\n$/);
      expect(world.query.calls).toEqual([]);
      expect(world.inbox().waiting).toEqual([]);
      expect(Object.keys(world.tasks())).toEqual([]);
      supervisor.close();
    },
  );
});

describe("what it writes on the board for schedules", () => {
  it("is only take and close done, never a schedule change", async () => {
    const world = scheduled();
    const supervisor = await world.start();
    world.notice("schedule.upcoming", KEY, "weekly");
    world.notice("schedule.closed", KEY, "weekly");
    await pass(supervisor);
    world.nowMs = Date.parse(AT);
    planOne(world);
    world.query.worker.push({ messages: [init("w"), result(workerOutput("failed"))] });
    await pass(supervisor);
    await supervisor.idle();
    await pass(supervisor);
    for (const args of world.commands.scheduleCalls()) {
      expect(["take", "close"]).toContain(args[1]);
      if (args[1] === "close") expect(args[3]).toBe("done");
    }
    supervisor.close();
  });
});
