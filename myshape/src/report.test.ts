import { describe, expect, it } from "vitest";
import { parseReport } from "./report.js";

const FULL = {
  schema: 1,
  code_commit: "abc",
  ledger_enabled: true,
  tasks: [
    { id: "t1", kind: "ship", state: "working", source: "pane", detail: "busy" },
    { kind: "no id" },
    "junk",
  ],
  holds: [
    {
      id: "h1",
      title: "T",
      question: "Q",
      hold_bucket: "dated",
      hold_until: "2026-12-01",
      unresolved_blocker_ids: ["b", 3],
      hold_age_days: 4,
      origin: "t1",
      on_answer: "close",
      hold_set: "2026-11-20T06:10:00Z",
    },
    { id: "h2", hold_bucket: "weird" },
    { hold_bucket: "live" },
  ],
  status_decisions: [{ id: "t1", key: "default", summary: "which?" }, { key: "no id" }],
  topics: { t1: "billing 2026-07-01T00:00:00Z", bad: 3 },
  ledger: {
    status: "delta",
    to_offset: 10,
    to_prefix_sha256: "s",
    more: true,
    lines: ["a", 1, "b"],
  },
  secondmates: [
    { id: "sm1", remote: true, home: "/h", read_every_s: 60, read_timeout_s: 400 },
    { id: "sm2" },
    { home: "no id" },
    { id: "main" },
    { id: "bad id" },
    { id: "edge", read_every_s: 0.2, read_timeout_s: 99_999 },
    { id: "word", read_every_s: "10" },
  ],
  closed_holds: [
    {
      id: "c1",
      title: "NAS",
      origin: "t1",
      mode: "answered",
      answer: "要",
      label: "",
      source: "",
      digest: "d1",
      occurrence: 1,
      opened_at: 100,
      closed_at: "soon",
    },
    { id: "no digest", occurrence: 1 },
    { id: "no occurrence", digest: "d" },
  ],
  closed_cursor: { status: "delta", to_offset: 7, to_prefix_sha256: "s2", more: true },
};

function ok(raw: unknown) {
  const parsed = parseReport(JSON.stringify(raw));
  if (parsed.kind !== "ok") throw new Error(`not ok: ${parsed.kind}`);
  return parsed.report;
}

describe("parseReport", () => {
  it("reads queued backlog items and tolerates a home that does not report them", () => {
    const queued = ok({
      ...FULL,
      queued: [
        { id: "plain", kind: "ship", title: "Plain", topic_hint: "billing" },
        { id: "held", kind: "ship", title: "Held", hold: "waiting", captain: false, blockers: [] },
        { id: "call", kind: "captain", title: "Call", hold: "pick", captain: true },
        { id: "after", kind: "ship", title: "After", hold: null, blockers: ["plain", 7] },
        { title: "no id" },
        "junk",
      ],
    }).queued;
    expect(queued).toEqual([
      {
        id: "plain",
        kind: "ship",
        title: "Plain",
        hold: null,
        captain: false,
        blockers: [],
        topic_hint: "billing",
      },
      {
        id: "held",
        kind: "ship",
        title: "Held",
        hold: "waiting",
        captain: false,
        blockers: [],
        topic_hint: null,
      },
      {
        id: "call",
        kind: "captain",
        title: "Call",
        hold: "pick",
        captain: true,
        blockers: [],
        topic_hint: null,
      },
      {
        id: "after",
        kind: "ship",
        title: "After",
        hold: null,
        captain: false,
        blockers: ["plain"],
        topic_hint: null,
      },
    ]);
    expect(ok(FULL).queued).toEqual([]);
  });

  it("takes a task as unstarted only when the report says so", () => {
    const tasks = ok({
      ...FULL,
      tasks: [
        { id: "quiet", unstarted: true },
        { id: "spoke", unstarted: false },
        { id: "old-script" },
        { id: "odd", unstarted: "yes" },
      ],
    }).tasks.map((task) => `${task.id}:${task.unstarted}`);
    expect(tasks).toEqual(["quiet:true", "spoke:false", "old-script:false", "odd:false"]);
  });

  it("keeps well-formed entries and drops the rest", () => {
    expect(ok(FULL)).toEqual({
      code_commit: "abc",
      ledger_enabled: true,
      queued: [],
      tasks: [
        {
          id: "t1",
          kind: "ship",
          state: "working",
          source: "pane",
          detail: "busy",
          unstarted: false,
        },
      ],
      holds: [
        {
          id: "h1",
          title: "T",
          question: "Q",
          hold_bucket: "dated",
          hold_until: "2026-12-01",
          unresolved_blocker_ids: ["b"],
          hold_age_days: 4,
          origin: "t1",
          on_answer: "close",
          hold_set: "2026-11-20T06:10:00Z",
        },
      ],
      status_decisions: [{ id: "t1", key: "default", summary: "which?" }],
      topics: { t1: "billing 2026-07-01T00:00:00Z" },
      ledger: {
        status: "delta",
        to_offset: 10,
        to_prefix_sha256: "s",
        more: true,
        lines: ["a", "b"],
      },
      ledger_hint: null,
      aggregator: null,
      secondmates: [
        { id: "sm1", read_every_s: 60, read_timeout_s: 400 },
        { id: "sm2", read_every_s: null, read_timeout_s: null },
        { id: "edge", read_every_s: 1, read_timeout_s: 3600 },
        { id: "word", read_every_s: null, read_timeout_s: null },
      ],
      closed_holds: [
        {
          id: "c1",
          title: "NAS",
          origin: "t1",
          mode: "answered",
          answer: "要",
          label: "",
          source: "",
          digest: "d1",
          occurrence: 1,
          opened_at: 100,
          closed_at: null,
        },
      ],
      closed_cursor: { status: "delta", to_offset: 7, to_prefix_sha256: "s2", more: true },
    });
  });

  it("drops a closed decisions' cursor it cannot read", () => {
    for (const cursor of [
      { status: "later", to_offset: 0, to_prefix_sha256: "-" },
      { status: "start" },
      3,
    ])
      expect(ok({ ...FULL, closed_cursor: cursor }).closed_cursor).toBeNull();
    for (const status of ["start", "delta", "continuity-broken", "absent"])
      expect(
        ok({ ...FULL, closed_cursor: { status, to_offset: 0, to_prefix_sha256: "-" } })
          .closed_cursor,
      ).toEqual({ status, to_offset: 0, to_prefix_sha256: "-", more: false });
  });

  it("reads a hold with no bucket as due now, and drops one with a word it does not know", () => {
    const holds = ok({
      ...FULL,
      holds: [{ id: "a" }, { id: "b", hold_bucket: null }, { id: "c", hold_bucket: "weird" }],
    }).holds;
    expect(holds.map((hold) => `${hold.id}:${hold.hold_bucket}`)).toEqual(["a:live", "b:live"]);
  });

  it("reads the optional aggregator block and ledger hint", () => {
    const report = ok({
      ...FULL,
      ledger_hint: "turn the ledger on",
      aggregator: { name: "plain", label: "Plain", update_hint: 5 },
    });
    expect(report.ledger_hint).toBe("turn the ledger on");
    expect(report.aggregator).toEqual({ name: "plain", label: "Plain", update_hint: null });
    expect(ok({ ...FULL, aggregator: "plain" }).aggregator).toBeNull();
  });

  it("fills defaults for everything optional", () => {
    const report = ok({
      schema: 1,
      tasks: [{ id: "t" }],
      holds: [{ id: "h", hold_bucket: "live", on_answer: "finish" }],
      status_decisions: [{ id: "q" }],
      ledger: { status: "absent", to_offset: 0, to_prefix_sha256: "-" },
    });
    expect(report).toEqual({
      code_commit: "",
      ledger_enabled: false,
      queued: [],
      tasks: [{ id: "t", kind: "", state: "unknown", source: "", detail: "", unstarted: false }],
      holds: [
        {
          id: "h",
          title: "",
          question: "",
          hold_bucket: "live",
          hold_until: null,
          unresolved_blocker_ids: [],
          hold_age_days: null,
          origin: "",
          on_answer: null,
          hold_set: null,
        },
      ],
      status_decisions: [{ id: "q", key: "", summary: "" }],
      topics: {},
      ledger: { status: "absent", to_offset: 0, to_prefix_sha256: "-", more: false, lines: [] },
      ledger_hint: null,
      aggregator: null,
      secondmates: [],
      closed_holds: [],
      closed_cursor: null,
    });
  });

  it("accepts each hold bucket and ledger status", () => {
    for (const bucket of ["live", "aged", "dated", "blocked"]) {
      expect(ok({ ...FULL, holds: [{ id: "h", hold_bucket: bucket }] }).holds[0]?.hold_bucket).toBe(
        bucket,
      );
    }
    for (const status of ["delta", "continuity-broken", "absent"]) {
      expect(ok({ ...FULL, ledger: { ...FULL.ledger, status } }).ledger.status).toBe(status);
    }
    expect(ok({ ...FULL, ledger_enabled: "yes" }).ledger_enabled).toBe(false);
    expect(ok({ ...FULL, tasks: [{ id: "t", state: "" }] }).tasks[0]?.state).toBe("");
    expect(ok({ ...FULL, ledger: { ...FULL.ledger, more: 1 } }).ledger.more).toBe(false);
    expect(ok({ ...FULL, secondmates: [{ id: "s", remote: true }] }).secondmates[0]).toEqual({
      id: "s",
      read_every_s: null,
      read_timeout_s: null,
    });
  });

  it("distinguishes another schema from garbage", () => {
    expect(parseReport(JSON.stringify({ ...FULL, schema: 2 }))).toEqual({ kind: "incompatible" });
    expect(parseReport(JSON.stringify({ ...FULL, schema: "1" }))).toEqual({ kind: "incompatible" });
    expect(parseReport("not json")).toEqual({ kind: "invalid" });
    expect(parseReport("[1]")).toEqual({ kind: "invalid" });
    expect(parseReport("null")).toEqual({ kind: "invalid" });
    for (const ledger of [
      undefined,
      "x",
      { ...FULL.ledger, status: "odd" },
      { ...FULL.ledger, to_offset: "1" },
      { ...FULL.ledger, to_prefix_sha256: 5 },
    ]) {
      expect(parseReport(JSON.stringify({ ...FULL, ledger }))).toEqual({ kind: "invalid" });
    }
  });
});
