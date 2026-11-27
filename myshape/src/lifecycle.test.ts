import { describe, expect, it } from "vitest";
import {
  LIFECYCLE,
  TODO_TRANSITIONS,
  destinationOf,
  emptyLifecycle,
  isTimed,
  nextClocks,
  scheduleLines,
  todoState,
  todoTransitionProblem,
  visibleWait,
} from "./lifecycle.js";
import type { Card, CardState, Clock, LifecycleContext, LifecycleStore } from "./lifecycle.js";
import {
  DEFAULT_DEADLINES,
  TIMED_STATES,
  changeSettings,
  defaultSettings,
  durationWords,
  parseSettings,
} from "./lifecycle-settings.js";
import type { HomeReport, ReportHold, ReportQueued, ReportTask } from "./report.js";
import { emptySchedules } from "./schedules.js";
import type { Series } from "./schedules.js";
import { generator } from "./seeded-random.test-helper.js";
import { emptyState } from "./topics.js";
import type { TopicState } from "./topics.js";
import { emptyTodos } from "./todos.js";
import type { TodoItem, TodoStore } from "./todos.js";
import { evaluateBoard } from "./view.js";
import type { HomeSnapshot, ViewInput } from "./view.js";

const NOW = Date.parse("2026-11-27T00:00:00Z");
const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

function topics(): TopicState {
  const state = emptyState();
  const topic = (name: string) => ({
    name,
    goal: "g",
    status: "confirmed" as const,
    created_at: "",
  });
  state.doc.topics = { hi: topic("High"), idle: topic("Idle"), lt: topic("Later") };
  state.doc.queues = { high: ["hi"], normal: ["idle"], later: ["lt"] };
  state.archive.topics = { gone: { ...topic("Gone"), archived_at: "2026-06-01T00:00:00Z" } };
  return state;
}

function report(extra: Partial<HomeReport> = {}): HomeReport {
  return {
    queued: [],
    code_commit: "c",
    ledger_enabled: true,
    tasks: [],
    holds: [],
    status_decisions: [],
    topics: {},
    ledger: { status: "absent", to_offset: 0, to_prefix_sha256: "-", more: false, lines: [] },
    ledger_hint: null,
    aggregator: null,
    secondmates: [],
    closed_holds: [],
    closed_cursor: null,
    ...extra,
  };
}

function hold(id: string, extra: Partial<ReportHold> = {}): ReportHold {
  return {
    id,
    title: id,
    question: `q ${id}`,
    hold_bucket: "live",
    hold_until: null,
    unresolved_blocker_ids: [],
    hold_age_days: 1,
    origin: "",
    on_answer: null,
    hold_set: null,
    ...extra,
  };
}

function queued(id: string, extra: Partial<ReportQueued> = {}): ReportQueued {
  return {
    id,
    kind: "ship",
    title: id,
    hold: null,
    captain: false,
    blockers: [],
    topic_hint: "hi",
    ...extra,
  };
}

function task(id: string, state: string, extra: Partial<ReportTask> = {}): ReportTask {
  return { id, kind: "ship", state, source: "pane", detail: "", unstarted: false, ...extra };
}

function home(id: string, extra: Partial<HomeSnapshot> = {}): HomeSnapshot {
  return { id, report: report(), lastOkAt: NOW - 1000, error: null, version: "same", ...extra };
}

function item(state: TodoItem["state"]): TodoItem {
  return {
    title: `item ${state}`,
    topic: "hi",
    action: "do",
    guidance: "",
    commands: [],
    state,
    reason: null,
    at: "T",
    by: "plain",
    ref: "",
    captain_closes: false,
    created_at: "T",
  };
}

function context(store: LifecycleStore, extra: Partial<LifecycleContext> = {}): LifecycleContext {
  return {
    store,
    schedules: [],
    allPaused: false,
    writes: [],
    fresh: new Set(["main"]),
    present: new Set(["main"]),
    questions: new Map(),
    label: "plain",
    nowMs: NOW,
    ...extra,
  };
}

function look(
  homes: HomeSnapshot[],
  store: LifecycleStore = emptyLifecycle(),
  extra: { todos?: TodoStore; context?: Partial<LifecycleContext>; cap?: number | null } = {},
) {
  const input: ViewInput = {
    topics: topics(),
    todos: extra.todos ?? emptyTodos(),
    homes,
    events: [],
    summaries: [],
    nowMs: NOW,
    staleMs: 180_000,
    label: "plain",
    decisionsAtOnce: extra.cap ?? null,
    lifecycle: context(store, extra.context),
  };
  return evaluateBoard(input);
}

const stateOf = (cards: Card[], key: string): CardState | undefined =>
  cards.find((card) => card.key === key)?.state;

/** A store whose clocks say each key was first seen in its state `ms` ago. */
function seen(entries: [string, Clock["state"], number][]): LifecycleStore {
  const store = emptyLifecycle();
  for (const [key, state, ms] of entries) store.clocks[key] = { state, since: ago(ms), sig: "" };
  return store;
}

describe("the rule table", () => {
  it("gives every state an owner, and every state the aggregator owns a deadline", () => {
    for (const [state, rule] of Object.entries(LIFECYCLE)) {
      if (rule.owner === "aggregator") expect(rule.deadline, state).not.toBeNull();
      else expect(rule.deadline, state).toBeNull();
    }
  });

  it("times each timed state by its own setting, and every setting times a state", () => {
    for (const state of TIMED_STATES) {
      expect(LIFECYCLE[state]).toEqual({ owner: "aggregator", deadline: state });
      expect(isTimed(state)).toBe(true);
    }
    expect(isTimed("T1")).toBe(false);
    expect(isTimed("N2")).toBe(false);
  });

  it("sends a topic with no work to 沒人處理的議題, D5 to the queue, every other card to 沒人接", () => {
    expect(destinationOf("T2")).toBe("idle");
    expect(destinationOf("D5")).toBe("queue");
    for (const state of TIMED_STATES.filter((name) => !["T2", "D5"].includes(name)))
      expect(destinationOf(state)).toBe("stall");
  });
});

describe("the state of every card", () => {
  it("classifies decisions, first rule that matches", () => {
    const { evaluation } = look([
      home("main", {
        report: report({
          holds: [
            hold("live"),
            hold("dated", { hold_bucket: "dated", hold_until: "2026-12-30" }),
            hold("due", { hold_bucket: "dated", hold_until: "2026-11-01" }),
            hold("waits", { hold_bucket: "blocked", unresolved_blocker_ids: ["q"] }),
            hold("lost", { hold_bucket: "blocked", unresolved_blocker_ids: ["nowhere"] }),
            hold("weird", { hold_bucket: "unknown", unreadable: '"snoozed"' }),
          ],
          queued: [queued("q")],
        }),
      }),
    ]);
    const states = ["live", "dated", "due", "waits", "lost", "weird"].map((id) =>
      stateOf(evaluation.cards, `hold\tmain\t${id}`),
    );
    expect(states).toEqual(["D1", "D3", "D1", "D4", "D5", "D9"]);
  });

  it("puts a decision whose answer is being sent, failed, or delivered but still open in D6, D7, D8", () => {
    const write = (taskId: string, state: string) => ({
      kind: "answer",
      home: "main",
      task: taskId,
      topic: null,
      state,
      question_sha256: "sha",
    });
    const { evaluation } = look(
      [home("main", { report: report({ holds: [hold("a"), hold("b"), hold("c"), hold("d")] }) })],
      emptyLifecycle(),
      {
        context: {
          writes: [
            write("a", "retrying"),
            write("b", "unknown"),
            write("c", "delivered"),
            {
              ...write("d", "delivered"),
              question_sha256: "an older question",
            },
          ],
          questions: new Map(["a", "b", "c", "d"].map((id) => [`main\t${id}`, "sha"])),
        },
      },
    );
    expect(
      ["a", "b", "c", "d"].map((id) => stateOf(evaluation.cards, `hold\tmain\t${id}`)),
    ).toEqual(["D6", "D7", "D8", "D1"]);
  });

  it("classifies queued items, and flags one with no topic", () => {
    const { evaluation } = look([
      home("main", {
        report: report({
          queued: [
            queued("ready"),
            queued("parked", { hold: "waiting for a vendor" }),
            queued("ask", { captain: true, hold: "pick" }),
            queued("later", { topic_hint: "lt" }),
            queued("archived", { topic_hint: "gone" }),
            queued("after", { blockers: ["ready"] }),
            queued("lost", { blockers: ["nowhere"] }),
            queued("loop-a", { blockers: ["loop-b"] }),
            queued("loop-b", { blockers: ["loop-a"] }),
            queued("loose", { topic_hint: null }),
          ],
        }),
      }),
    ]);
    const ids = ["ready", "parked", "ask", "later", "archived", "after", "lost", "loop-a", "loose"];
    expect(ids.map((id) => stateOf(evaluation.cards, `queued\tmain\t${id}`))).toEqual([
      "Q1",
      "Q5",
      "Q2",
      "Q3",
      "Q4",
      "Q7",
      "Q8",
      "Q8",
      "Q1",
    ]);
    expect(stateOf(evaluation.cards, "queued\tmain\tloose\tNT")).toBe("NT");
    expect(stateOf(evaluation.cards, "queued\tmain\tready\tNT")).toBeUndefined();
  });

  it("classifies agents, and a stale home's as waiting for a read", () => {
    const tasks = [
      task("w", "working"),
      task("p", "parked"),
      task("u", "working", { unstarted: true }),
      task("b", "failed"),
      task("d", "done"),
      task("x", "weird"),
      task("ask", "working"),
    ];
    const topicsOf = Object.fromEntries(
      tasks.map((entry) => [entry.id, "hi 2026-11-01T00:00:00Z"]),
    );
    const fresh = look([
      home("main", { report: report({ tasks, topics: topicsOf, holds: [hold("ask")] }) }),
    ]).evaluation.cards;
    expect(tasks.map((entry) => stateOf(fresh, `agent\tmain\t${entry.id}`))).toEqual([
      "A1",
      "A2",
      "A3",
      "A4",
      "A5",
      "A6",
      "A7",
    ]);
    const stale = look([
      home("main", { lastOkAt: NOW - 200_000, report: report({ tasks: [task("w", "working")] }) }),
    ]).evaluation.cards;
    expect(stateOf(stale, "agent\tmain\tw")).toBe("A8");
    expect(stateOf(stale, "agent\tmain\tw\tNT")).toBeUndefined();
  });

  it("classifies topics: work, none, 待辦, kept, and unclear when a home with its work cannot be read", () => {
    const store = emptyLifecycle();
    const busy = look([home("main", { report: report({ queued: [queued("q")] }) })], store);
    expect(stateOf(busy.evaluation.cards, "topic\thi")).toBe("T1");
    expect(stateOf(busy.evaluation.cards, "topic\tidle")).toBe("T2");
    expect(stateOf(busy.evaluation.cards, "topic\tlt")).toBe("T6");
    expect(busy.evaluation.memory.homes).toEqual({ hi: ["main"] });
    const kept = { ...store, kept: { idle: ago(-DAY) } };
    expect(stateOf(look([home("main")], kept).evaluation.cards, "topic\tidle")).toBe("T4");
    const dropped = { ...store, homes: { hi: ["sm1"] } };
    const unclear = look([home("main"), home("sm1", { report: null })], dropped, {
      context: { present: new Set(["main", "sm1"]) },
    });
    expect(stateOf(unclear.evaluation.cards, "topic\thi")).toBe("T5");
    expect(unclear.evaluation.memory.homes).toEqual({ hi: ["sm1"] });
  });

  it("classifies hands-on items, keeping an unknown state as its own", () => {
    const todos: TodoStore = {
      ...emptyTodos(),
      items: {
        open: item("open"),
        rejected: item("rejected"),
        claimed: item("claimed"),
        obsolete: item("obsolete"),
        odd: { ...item("unknown"), unknown_state: "parked" },
      },
    };
    const { evaluation } = look([home("main")], emptyLifecycle(), { todos });
    expect(
      ["open", "rejected", "claimed", "obsolete", "odd"].map((id) =>
        stateOf(evaluation.cards, `todo\t${id}`),
      ),
    ).toEqual(["O1", "O2", "O3", "O4", "O6"]);
  });
});

describe("visibleWait", () => {
  it("follows blockers to a running agent, and refuses a loop or an id the board cannot see", () => {
    const { view } = look([
      home("main", {
        report: report({
          tasks: [task("run", "working")],
          queued: [
            queued("a", { blockers: ["b"] }),
            queued("b", { blockers: ["run"] }),
            queued("c", { blockers: ["c"] }),
          ],
        }),
      }),
    ]);
    expect(visibleWait(view, "main", ["a"])).toBe(true);
    expect(visibleWait(view, "main", ["c"], new Set(["c"]))).toBe(false);
    expect(visibleWait(view, "main", ["ghost"])).toBe(false);
    expect(visibleWait(view, "sm1", ["b"])).toBe(false);
  });
});

describe("clocks", () => {
  const card = (key: string, state: CardState, sig = ""): Card => ({
    key,
    kind: "queued",
    state,
    topic: "hi",
    home: key.split("\t")[1] ?? null,
    label: key,
    sig,
    count: 0,
  });
  const where = { fresh: new Set(["main"]), present: new Set(["main", "sm1"]), nowMs: NOW };

  it("keeps a clock while the state and sig stay, and starts one again when either changes", () => {
    const previous = {
      a: { state: "Q5" as const, since: ago(DAY), sig: "" },
      b: { state: "Q5" as const, since: ago(DAY), sig: "" },
    };
    const next = nextClocks(previous, [card("a", "Q5"), card("b", "Q1")], where);
    expect(next["a"]?.since).toBe(ago(DAY));
    expect(next["b"]).toEqual({ state: "Q1", since: ago(0), sig: "" });
    const moved = nextClocks(previous, [card("a", "Q5", "changed")], where);
    expect(moved["a"]?.since).toBe(ago(0));
  });

  it("stops a clock only once a good read says its card is gone, never for a home not read well", () => {
    const previous = {
      "queued\tmain\tgone": { state: "Q5" as const, since: ago(DAY), sig: "" },
      "queued\tsm1\tunseen": { state: "Q5" as const, since: ago(DAY), sig: "" },
      "queued\tsm9\tretired": { state: "Q5" as const, since: ago(DAY), sig: "" },
      "todo\tclosed": { state: "O3" as const, since: ago(DAY), sig: "" },
    };
    expect(Object.keys(nextClocks(previous, [], where))).toEqual(["queued\tsm1\tunseen"]);
  });

  it("does not count a state with no deadline", () => {
    expect(nextClocks({}, [card("a", "Q2"), card("b", "Q7")], where)).toEqual({});
  });
});

describe("escalation", () => {
  it("does nothing before the deadline, and nothing at go-live: every clock starts then", () => {
    const first = look([
      home("main", { report: report({ queued: [queued("parked", { hold: "x" })] }) }),
    ]);
    expect(first.evaluation.records).toEqual([]);
    expect(first.evaluation.memory.clocks["queued\tmain\tparked"]?.since).toBe(ago(0));
    expect(first.evaluation.memory.clocks["topic\tidle"]?.since).toBe(ago(0));
    expect(first.view.stalls).toEqual([]);
    expect(first.view.idle).toEqual([]);
  });

  it("puts overdue work under its topic's 沒人接 card, once, with every overdue reason on one line", () => {
    const store = seen([
      ["queued\tmain\tparked", "Q5", 3 * DAY],
      ["queued\tmain\tloose", "Q1", 3 * DAY],
      ["queued\tmain\tloose\tNT", "NT", 3 * DAY],
      ["topic\thi", "T2", DAY],
    ]);
    const homes = [
      home("main", {
        report: report({
          queued: [queued("parked", { hold: "x" }), queued("loose", { topic_hint: null })],
        }),
      }),
    ];
    const { evaluation, view } = look(homes, store);
    expect(
      view.stalls.map((stall) => [
        stall.key,
        stall.state,
        stall.members.map((m) => `${m.label}:${m.states.join("+")}`),
      ]),
    ).toEqual([
      ["hi", "N2", ["main/parked:Q5"]],
      ["-", "N2", ["main/loose:NT"]],
    ]);
    expect(evaluation.records.map((record) => [record.kind, record.topic, record.outcome])).toEqual(
      [
        ["stall.raised", "hi", "stall"],
        ["stall.raised", null, "stall"],
      ],
    );
    const again = look(homes, { ...store, ...evaluation.memory });
    expect(again.evaluation.records).toEqual([]);
  });

  it("does not escalate a stale home's card, but keeps one it already put in front", () => {
    const store = seen([["queued\tmain\tparked", "Q5", 3 * DAY]]);
    const stale = [
      home("main", {
        lastOkAt: NOW - 200_000,
        report: report({ queued: [queued("parked", { hold: "x" })] }),
      }),
    ];
    const quiet = look(stale, store, { context: { fresh: new Set() } });
    expect(quiet.view.stalls).toEqual([]);
    const raised = {
      ...store,
      stalls: { hi: { since: ago(DAY), members: ["queued\tmain\tparked"] } },
    };
    const kept = look(stale, raised, { context: { fresh: new Set() } });
    expect(kept.view.stalls.map((stall) => stall.key)).toEqual(["hi"]);
    expect(kept.evaluation.records).toEqual([]);
    // A home that cannot report at all still names the member from what the board kept.
    const dropped = look([home("main", { report: null })], raised, {
      context: { fresh: new Set() },
    });
    expect(
      dropped.view.stalls[0]?.members.map((member) => `${member.label}:${member.states}`),
    ).toEqual(["main/parked:Q5"]);
  });

  it("settles a 沒人接 card once its members leave the overdue state", () => {
    const store = {
      ...emptyLifecycle(),
      stalls: { hi: { since: ago(DAY), members: ["queued\tmain\tparked"] } },
    };
    const { evaluation, view } = look([home("main")], store);
    expect(view.stalls).toEqual([]);
    expect(evaluation.records.map((record) => [record.kind, record.topic])).toEqual([
      ["stall.settled", "hi"],
    ]);
  });

  it("raises 沒人處理的議題 for a topic with no work past its deadline, and never a close proposal", () => {
    const store = seen([["topic\tidle", "T2", 3 * DAY]]);
    const { evaluation, view } = look(
      [home("main", { report: report({ queued: [queued("q")] }) })],
      store,
    );
    expect(view.idle).toEqual([
      { topic: "idle", since: ago(0), text: "這個議題 3 天沒有任何工作，plain 也沒處理" },
    ]);
    expect(view.topics["idle"]?.close_reason).toBeNull();
    expect(evaluation.records.map((record) => [record.kind, record.topic, record.outcome])).toEqual(
      [["stall.raised", "idle", "idle"]],
    );
    const settled = look(
      [home("main", { report: report({ queued: [queued("q", { topic_hint: "idle" })] }) })],
      {
        ...store,
        ...evaluation.memory,
      },
    );
    expect(settled.view.idle).toEqual([]);
    expect(settled.evaluation.records.map((record) => record.kind)).toEqual(["stall.settled"]);
  });

  it("puts a decision waiting on work it cannot see into the queue once overdue", () => {
    const blocked = hold("lost", { hold_bucket: "blocked", unresolved_blocker_ids: ["nowhere"] });
    const store = seen([["hold\tmain\tlost", "D5", 3 * DAY]]);
    const { view } = look([home("main", { report: report({ holds: [blocked] }) })], store);
    expect(view.holds[0]).toMatchObject({
      live: true,
      deferred_reason: null,
      note: "它等的 nowhere 看板找不到",
    });
    expect(view.turns.map((turn) => turn.key)).toEqual(["main\tlost"]);
  });

  it("puts a claim never checked under its topic's 沒人接 card, never closing it (decision 5)", () => {
    const todos: TodoStore = { ...emptyTodos(), items: { vpn: item("claimed") } };
    const store = seen([["todo\tvpn", "O3", 3 * DAY]]);
    const { evaluation, view } = look([home("main")], store, { todos });
    expect(
      view.stalls.map((stall) => [
        stall.key,
        stall.members.map((member) => `${member.id}:${member.states}`),
      ]),
    ).toEqual([["hi", ["vpn:O3"]]]);
    expect(view.todos[0]?.state).toBe("claimed");
    expect(evaluation.records.map((record) => record.kind)).toEqual(["stall.raised"]);
  });
});

describe("the one queue", () => {
  const store = (): LifecycleStore => {
    const base = seen([
      ["topic\tidle", "T2", 3 * DAY],
      ["queued\tmain\tparked", "Q5", 3 * DAY],
    ]);
    return base;
  };
  const homes = () => [
    home("main", {
      report: report({
        holds: [hold("ask")],
        queued: [queued("parked", { hold: "x" })],
        topics: { ask: "hi 2026-11-01T00:00:00Z" },
      }),
    }),
  ];

  it("orders the aggregator's decisions, its close proposals, then 沒人處理的議題, then 沒人接", () => {
    const input = look(homes(), store(), { cap: 10 });
    expect(input.view.turns.map((turn) => `${turn.kind}:${turn.key}`)).toEqual([
      "hold:main\task",
      "idle:idle",
      "stall:hi",
    ]);
  });

  it("shows every decision with no cap from the aggregator, and the board's own cards one at a time", () => {
    const { view } = look(homes(), store(), { cap: null });
    expect(view.turns.map((turn) => `${turn.kind}:${turn.waits_turn}`)).toEqual([
      "hold:false",
      "idle:false",
      "stall:true",
    ]);
  });

  it("counts every kind toward the aggregator's cap", () => {
    const { view } = look(homes(), store(), { cap: 1 });
    expect(view.turns.map((turn) => turn.waits_turn)).toEqual([false, true, true]);
  });
});

describe("the hands-on transitions", () => {
  it("keeps a claim in O3, owned by the aggregator, however long it waits", () => {
    expect(todoState({ state: "claimed" })).toBe("O3");
    expect(todoState({ state: "unknown" })).toBe("O6");
  });

  it("refuses every operation from a state the table does not list, naming what may run", () => {
    const states: CardState[] = ["O1", "O2", "O3", "O4", "O6"];
    for (const [op, from] of Object.entries(TODO_TRANSITIONS))
      for (const state of states) {
        const problem = todoTransitionProblem(op, "it", state);
        if (from.includes(state)) expect(problem, `${op} from ${state}`).toBeNull();
        else
          expect(problem, `${op} from ${state}`).toMatch(
            /^it 現在是「.+」，不能 .+；現在能做的：.*。$/,
          );
      }
    expect(todoTransitionProblem("todo-failed", "it", "O2")).toBe(
      "it 現在是「驗證沒過」，不能 todo-failed；現在能做的：todo-claim、todo-done、todo-obsolete、todo-drop。",
    );
    expect(todoTransitionProblem("rename", "it", "O1")).toBeNull();
  });
});

describe("the deadline settings", () => {
  it("reads a missing or invalid pair as its default", () => {
    const settings = parseSettings({
      T2: { remind: 5, raise: 9 },
      A3: { remind: 9, raise: 5 },
      S6: { remind: 1, raise: 11 },
    });
    expect(settings.T2).toEqual({ remind: 5, raise: 9 });
    expect(settings.A3).toEqual(DEFAULT_DEADLINES.A3);
    expect(settings.S6).toEqual(DEFAULT_DEADLINES.S6);
    expect(parseSettings("junk")).toEqual(defaultSettings());
  });

  it("refuses a reminder after the escalation, an unbounded or broken value, or an unknown name", () => {
    const current = defaultSettings();
    for (const changes of [
      { T2: { remind: 10, raise: 5 } },
      { T2: { remind: 1, raise: 130_000 } },
      { T2: { remind: 1.5, raise: 5 } },
      { T2: { remind: 0, raise: 0 } },
      { T2: 5 },
      { S6: { remind: 3, raise: 11 } },
      { nope: { remind: 1, raise: 2 } },
    ])
      expect(changeSettings(current, changes).ok, JSON.stringify(changes)).toBe(false);
    expect(changeSettings(current, { T2: DEFAULT_DEADLINES.T2 })).toEqual({
      ok: true,
      changed: false,
      line: "ok 期限設定沒有變",
    });
  });

  it("records what changed, from and to", () => {
    const result = changeSettings(defaultSettings(), { A3: { remind: 30, raise: 240 } });
    expect(result).toMatchObject({ ok: true, changed: true, line: "ok 期限設定已改" });
    if (!result.ok || !result.changed) throw new Error("expected a change");
    expect(result.records[0].text).toBe(
      "期限設定（提醒 aggregator／交給你）：還沒開始的 agent 15 分鐘／2 小時 → 30 分鐘／4 小時",
    );
    expect(durationWords(0)).toBe("立刻");
    expect(durationWords(4320)).toBe("3 天");
  });
});

describe("scheduleLines", () => {
  const series = (topic: string, extra: Partial<Series> = {}): Series => ({
    topic,
    title: topic,
    rule: "daily 10:00",
    tz: "UTC",
    duration_min: null,
    lead_min: null,
    rt: "none",
    rt_locked: false,
    state: "on",
    locked: false,
    by: "aggregator",
    seen: true,
    created_at: "T",
    ...extra,
  });

  it("counts the occurrences in a row nobody took, and says who paused it last", () => {
    const store = emptySchedules();
    store.series = { a: series("a", { state: "paused" }), b: series("b") };
    const end = (outcome: string) => ({ key: `k-${outcome}`, outcome, by: "board" });
    store.recent = {
      b: [end("done"), end("untaken"), end("missed"), end("timed_out"), end("untaken")],
    };
    const lines = scheduleLines(store, (id) => id, [
      { kind: "schedule.paused", topic: "a", by: "captain" },
      { kind: "schedule.resumed", topic: "a", by: "captain" },
      { kind: "schedule.paused", topic: "a", by: "aggregator" },
    ]);
    expect(lines.map((line) => [line.id, line.pausedBy, line.unanswered])).toEqual([
      ["a", "aggregator", 0],
      ["b", null, 3],
    ]);
    const { evaluation } = look([home("main")], emptyLifecycle(), {
      context: { schedules: lines },
    });
    expect(stateOf(evaluation.cards, "schedule\ta")).toBe("S3");
    expect(stateOf(evaluation.cards, "schedule\tb")).toBe("S6");
  });
});

describe("invariant I, over random reads and time", () => {
  it("keeps every card in a state with a rule, and no fresh card past its deadline unescalated", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const random = generator(seed);
      const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
      let store = emptyLifecycle();
      let now = NOW;
      for (let step = 0; step < 40; step += 1) {
        now += pick([MINUTE, 3_600_000, DAY]);
        const items = ["a", "b", "c"].map((id) =>
          queued(
            id,
            pick([
              {},
              { hold: "x" },
              { blockers: ["ghost"] },
              { topic_hint: null },
              { captain: true },
            ]),
          ),
        );
        const tasks = ["w", "x"].map((id) =>
          task(id, pick(["working", "parked", "failed", "done", "?"])),
        );
        const homes = [
          home("main", { lastOkAt: now - 1000, report: report({ queued: items, tasks }) }),
        ];
        const input: ViewInput = {
          topics: topics(),
          todos: emptyTodos(),
          homes,
          events: [],
          summaries: [],
          nowMs: now,
          staleMs: 180_000,
          label: "plain",
          decisionsAtOnce: null,
          lifecycle: context(store, { nowMs: now }),
        };
        const { evaluation } = evaluateBoard(input);
        const members = new Set(
          Object.values(evaluation.memory.stalls).flatMap((stall) => stall.members),
        );
        for (const card of evaluation.cards) {
          expect(LIFECYCLE[card.state], `${seed} ${card.key}`).toBeDefined();
          if (!isTimed(card.state) || destinationOf(card.state) !== "stall") continue;
          const clock = evaluation.memory.clocks[card.key];
          expect(clock, `${seed} ${card.key}`).toBeDefined();
          const late =
            now - Date.parse(clock?.since ?? "") >= store.settings[card.state].raise * MINUTE;
          expect(members.has(card.key), `${seed} ${card.key} ${card.state}`).toBe(late);
        }
        store = { ...store, ...evaluation.memory };
      }
    }
  });
});
