// The write engine's fixed ids and expiry, which the schedule clock's notices
// use: a repeated fixed id hands nothing over again, and a notice past its
// expiry is never sent, retried, released, resumed or resent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandResult } from "./commands.js";
import { WriteEngine, expiresAt } from "./writes.js";
import type { Action, WriteRecord } from "./writes.js";

const T0 = Date.parse("2026-11-30T01:45:00Z");
const DELIVERED: CommandResult = { code: 0, stdout: '{"outcome":"delivered"}\n', stderr: "" };
const RETRY: CommandResult = {
  code: 0,
  stdout: '{"outcome":"retry","error":"not woken"}\n',
  stderr: "",
};
const FAILED: CommandResult = {
  code: 0,
  stdout: '{"outcome":"failed","error":"no"}\n',
  stderr: "",
};

let dir: string;
let engines: WriteEngine[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "myshape-writes-"));
  engines = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  for (const engine of engines) engine.stop();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Rig {
  engine: WriteEngine;
  calls: string[];
  expired: WriteRecord[];
  released: string[][];
  next: (...results: CommandResult[]) => void;
  block: (reason: string | null) => void;
  audit: () => Record<string, unknown>[];
}

function rig(blocked: string | null = null, retryDelaysMs = [5, 5]): Rig {
  let reason = blocked;
  const queue: CommandResult[] = [];
  const calls: string[] = [];
  const expired: WriteRecord[] = [];
  const released: string[][] = [];
  const file = path.join(dir, "audit.jsonl");
  const engine = new WriteEngine(
    file,
    {
      run: async (command) => {
        if (command.kind !== "deliver") throw new Error("only deliver");
        calls.push((JSON.parse(command.record) as { id: string }).id);
        return queue.shift() ?? DELIVERED;
      },
      blocked: () => reason,
      onRelease: (ids) => {
        released.push(ids);
        return true;
      },
      readTags: async () => "",
      onChange: () => undefined,
      onFinished: () => undefined,
      onExpired: (record) => expired.push(record),
    },
    { retryDelaysMs, resumeWindowMs: 3_600_000, commandTimeoutMs: 1000 },
  );
  engines.push(engine);
  return {
    engine,
    calls,
    expired,
    released,
    next: (...results) => queue.push(...results),
    block: (value) => {
      reason = value;
    },
    audit: () =>
      fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function notice(expires: number, phase: "pre" | "start" = "pre"): Action {
  return {
    kind: "notice",
    event: phase === "pre" ? "schedule.upcoming" : "schedule.due",
    text: `${phase} text`,
    topic: { id: "sync", name: "Sync" },
    occurrence: {
      key: "sync:20261130T0200Z",
      at: "2026-11-30T02:00:00Z",
      local: "2026-11-30T10:00+08:00",
      phase,
      late_min: 0,
      rt: "none",
      expires_at: new Date(expires).toISOString(),
    },
  };
}

function submit(r: Rig, id: string, action: Action, supersedes?: string[]): WriteRecord {
  return r.engine.submit(
    { channel: "auto", home: "main", task: null, topic: "sync", text: "t", action },
    supersedes === undefined ? { id } : { id, supersedes },
  );
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((done) => setTimeout(done, 2));
  expect(check()).toBe(true);
}

const PRE = "w-s-sync-20261130T0200Z-pre";
const START = "w-s-sync-20261130T0200Z-start";

describe("fixed ids", () => {
  it("hands a fixed id over once, however often it is handed in", async () => {
    const r = rig();
    const first = submit(r, PRE, notice(T0 + 900_000));
    await until(() => first.state === "delivered");
    const again = submit(r, PRE, notice(T0 + 900_000));
    expect(again).toBe(first);
    expect(r.calls).toEqual([PRE]);
    expect(r.audit().filter((line) => line["sending"] !== undefined)).toHaveLength(1);
  });

  it("a repeat while the first is still waiting does nothing either", () => {
    const r = rig("not bound");
    submit(r, PRE, notice(T0 + 900_000));
    submit(r, PRE, notice(T0 + 900_000));
    expect([...r.engine.records.keys()]).toEqual([PRE]);
    expect(r.audit()).toHaveLength(1);
  });
});

describe("expiry", () => {
  it("reads a notice's expires_at and nothing else", () => {
    expect(expiresAt(notice(T0))).toBe(T0);
    expect(expiresAt({ kind: "notice", event: "topic.kept", text: "x" })).toBeNull();
    expect(expiresAt({ kind: "message", topic: { id: "a", name: "A" }, text: "x" })).toBeNull();
  });

  it("records a notice already past its expiry as expired and never runs the deliverer", async () => {
    const r = rig();
    const record = submit(r, PRE, notice(T0));
    await new Promise((done) => setTimeout(done, 10));
    expect(record.state).toBe("expired");
    expect(record.error).toContain("沒送：已過期限 2026-11-30T01:45:00.000Z");
    expect(r.calls).toEqual([]);
    expect(r.expired.map((entry) => entry.id)).toEqual([PRE]);
    expect(r.audit().map((line) => line["state"])).toEqual(["waiting", "expired"]);
  });

  it("sends a notice up to the moment before its expiry", async () => {
    const r = rig();
    const record = submit(r, PRE, notice(T0 + 1));
    await until(() => record.state === "delivered");
    expect(r.calls).toEqual([PRE]);
  });

  it("stops retrying once the notice expires", async () => {
    const r = rig(null, [30, 30]);
    r.next(RETRY, RETRY);
    const record = submit(r, PRE, notice(T0 + 60_000));
    await until(() => record.state === "retrying");
    vi.setSystemTime(T0 + 60_000);
    await until(() => record.state === "expired");
    expect(r.calls).toEqual([PRE]);
    expect(r.expired).toHaveLength(1);
  });

  it("does not release a waiting notice that expired, nor name it in the release record", () => {
    const r = rig("not bound");
    const stale = submit(r, PRE, notice(T0 + 60_000));
    const live = submit(r, START, notice(T0 + 3_600_000, "start"));
    vi.setSystemTime(T0 + 120_000);
    r.block(null);
    expect(r.engine.releaseWaiting()).toBe(1);
    expect(r.released).toEqual([[START]]);
    expect(stale.state).toBe("expired");
    expect(live.state).toBe("sending");
  });

  it("expireOverdue ends a waiting notice past its expiry without a release", () => {
    const r = rig("not bound");
    const record = submit(r, PRE, notice(T0 + 60_000));
    r.engine.expireOverdue();
    expect(record.state).toBe("waiting");
    vi.setSystemTime(T0 + 60_000);
    r.engine.expireOverdue();
    expect(record.state).toBe("expired");
  });

  it("does not resume, after a restart, a notice that expired meanwhile", async () => {
    const first = rig(null, [50_000]);
    first.next(RETRY);
    const stale = submit(first, PRE, notice(T0 + 60_000));
    const live = submit(first, START, notice(T0 + 3_600_000, "start"));
    await until(() => stale.state === "retrying" && live.state === "delivered");
    first.engine.stop();
    vi.setSystemTime(T0 + 120_000);
    const second = rig();
    second.engine.resumeUnfinished();
    expect(second.engine.records.get(PRE)?.state).toBe("expired");
    await new Promise((done) => setTimeout(done, 10));
    expect(second.calls).toEqual([]);
    expect(second.expired.map((entry) => entry.id)).toEqual([PRE]);
  });

  it("keeps an expired notice expired across a restart", () => {
    const first = rig();
    submit(first, PRE, notice(T0));
    const second = rig();
    second.engine.resumeUnfinished();
    expect(second.engine.records.get(PRE)?.state).toBe("expired");
    expect(second.expired).toEqual([]);
  });

  it("refuses to resend a failed notice past its expiry", async () => {
    const r = rig();
    r.next(FAILED);
    const record = submit(r, PRE, notice(T0 + 60_000));
    await until(() => record.state === "failed");
    vi.setSystemTime(T0 + 60_000);
    expect(r.engine.resend(PRE, false)).toBe("這則通知已經過期，不再送。");
    expect(record.state).toBe("expired");
    expect(r.calls).toEqual([PRE]);
  });

  it("still resends a failed notice before its expiry", async () => {
    const r = rig();
    r.next(FAILED);
    const record = submit(r, PRE, notice(T0 + 60_000));
    await until(() => record.state === "failed");
    expect(r.engine.resend(PRE, false)).toBeNull();
    await until(() => record.state === "delivered");
    expect(r.calls).toEqual([PRE, PRE]);
  });
});

describe("supersession and voiding", () => {
  it("a due notice expires the coming-up notice of the same occurrence that was not handed over", async () => {
    const r = rig("not bound");
    const pre = submit(r, PRE, notice(T0 + 900_000));
    submit(r, START, notice(T0 + 3_600_000, "start"), [PRE]);
    expect(pre.state).toBe("expired");
    expect(pre.error).toBe("沒送：同一場的「到了」取代了它");
    r.block(null);
    r.engine.releaseWaiting();
    await until(() => r.engine.records.get(START)?.state === "delivered");
    expect(r.calls).toEqual([START]);
  });

  it("a due notice leaves a coming-up notice that was already delivered alone", async () => {
    const r = rig();
    const pre = submit(r, PRE, notice(T0 + 900_000));
    await until(() => pre.state === "delivered");
    submit(r, START, notice(T0 + 3_600_000, "start"), [PRE]);
    await until(() => r.engine.records.get(START)?.state === "delivered");
    expect(pre.state).toBe("delivered");
    expect(r.expired).toEqual([]);
  });

  it("cannot expire a notice while its deliverer runs", async () => {
    const r = rig();
    let release: (value: CommandResult) => void = () => undefined;
    const engine = new WriteEngine(
      path.join(dir, "slow.jsonl"),
      {
        run: () =>
          new Promise<CommandResult>((resolve) => {
            release = resolve;
          }),
        blocked: () => null,
        onRelease: () => true,
        readTags: async () => "",
        onChange: () => undefined,
        onFinished: () => undefined,
        onExpired: (record) => r.expired.push(record),
      },
      { retryDelaysMs: [5], resumeWindowMs: 60_000, commandTimeoutMs: 1000 },
    );
    engines.push(engine);
    const record = engine.submit(
      {
        channel: "auto",
        home: "main",
        task: null,
        topic: "sync",
        text: "t",
        action: notice(T0 + 9e5),
      },
      { id: PRE },
    );
    await new Promise((done) => setTimeout(done, 5));
    expect(engine.expire(PRE, "沒送：這一場已經結束")).toBe(false);
    release(DELIVERED);
    await until(() => record.state === "delivered");
    expect(r.expired).toEqual([]);
  });

  it("expire changes nothing for an unknown or finished write", async () => {
    const r = rig();
    const record = submit(r, PRE, notice(T0 + 900_000));
    await until(() => record.state === "delivered");
    expect(r.engine.expire(PRE, "x")).toBe(false);
    expect(r.engine.expire("w-none", "x")).toBe(false);
    expect(record.state).toBe("delivered");
  });
});
