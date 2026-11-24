import { describe, expect, it } from "vitest";
import type { JournalEvent, Summary } from "./journal.js";
import type { HomeReport, ReportHold, ReportQueued } from "./report.js";
import { emptyState } from "./topics.js";
import type { TopicState } from "./topics.js";
import { emptyTodos } from "./todos.js";
import type { TodoItem, TodoStore } from "./todos.js";
import { LEDGER_PER_TOPIC, buildView, parseOptions, parseTags, placeTask } from "./view.js";
import type { HomeSnapshot, ViewInput } from "./view.js";

const NOW = Date.parse("2026-07-10T00:00:00Z");
const T0 = Date.parse("2026-07-01T00:00:00Z") / 1000;

function topics(): TopicState {
  const state = emptyState();
  const topic = (name: string) => ({
    name,
    goal: `goal of ${name}`,
    status: "confirmed" as const,
    created_at: "",
  });
  state.doc.topics = {
    hi: topic("High"),
    n1: { ...topic("Normal one"), close_proposal: { at: "x", reason: "all done" } },
    n2: topic("Normal two"),
    lt: topic("Later"),
  };
  state.doc.queues = { high: ["hi"], normal: ["n1", "n2"], later: ["lt"] };
  state.doc.merged = { old: "n1" };
  state.archive.topics = { gone: { ...topic("Gone"), archived_at: "2026-06-01T00:00:00Z" } };
  return state;
}

function hold(id: string, extra: Partial<ReportHold> = {}): ReportHold {
  return {
    id,
    title: `title ${id}`,
    question: "q",
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

function home(id: string, extra: Partial<HomeSnapshot> = {}): HomeSnapshot {
  return {
    id,
    report: report(),
    lastOkAt: NOW - 1000,
    error: null,
    version: "same",
    ...extra,
  };
}

function input(extra: Partial<ViewInput> = {}): ViewInput {
  return {
    topics: topics(),
    todos: emptyTodos(),
    homes: [home("main")],
    events: [],
    summaries: [],
    nowMs: NOW,
    staleMs: 180_000,
    label: "plain",
    ...extra,
  };
}

const tag = (topic: string, day = "01") => `${topic} 2026-07-${day}T00:00:00Z`;

describe("parseTags and parseOptions", () => {
  it("reads one tag per line and tolerates blanks and bad times", () => {
    expect(parseTags("a 2026-07-01T00:00:00Z\n\nb not-a-time\nc\n")).toEqual([
      { topic: "a", atMs: T0 * 1000 },
      { topic: "b", atMs: 0 },
      { topic: "c", atMs: 0 },
    ]);
    expect(parseTags("")).toEqual([]);
  });

  it("takes the options after the last marker of the last line", () => {
    expect(parseOptions("要合併嗎？\n選項：合併 | 先不要")).toEqual(["合併", "先不要"]);
    expect(parseOptions("要合併嗎？ 選項：A | B | C\n")).toEqual(["A", "B", "C"]);
    expect(parseOptions("選項：X | Y 再說 選項： A  |  B ")).toEqual(["A", "B"]);
    expect(parseOptions("選項：A | B\n後面還有一行")).toEqual([]);
    expect(parseOptions("x選項：A | B")).toEqual(["A", "B"]);
    expect(parseOptions("選項：只有一個")).toEqual([]);
    expect(parseOptions("選項：A | ")).toEqual([]);
    expect(parseOptions("選項：A|B")).toEqual([]);
    expect(parseOptions("沒有選項")).toEqual([]);
    expect(parseOptions("")).toEqual([]);
  });
});

describe("placement", () => {
  const homes = [
    home("main", {
      report: report({
        topics: {
          a: tag("hi"),
          b: tag("old"),
          d: tag("nope"),
          e: tag("gone"),
          f: `${tag("hi")}\n${tag("n2", "02")}`,
        },
      }),
    }),
  ];
  it("resolves a task's newest tag through merges to a usable topic", () => {
    const place = (task: string) => placeTask(topics(), homes, "main", task);
    expect(place("a")).toEqual({ topic: "hi", reason: null });
    expect(place("b")).toEqual({ topic: "n1", reason: null });
    expect(place("d")).toEqual({ topic: null, reason: "unknown-topic" });
    expect(place("e")).toEqual({ topic: "gone", reason: null });
    expect(place("f")).toEqual({ topic: "n2", reason: null });
    expect(place("untagged")).toEqual({ topic: null, reason: "no-tag" });
    const emptyFile = [home("main", { report: report({ topics: { g: "" } }) })];
    expect(placeTask(topics(), emptyFile, "main", "g")).toEqual({ topic: null, reason: "no-tag" });
    expect(placeTask(topics(), homes, "elsewhere", "a")).toEqual({ topic: null, reason: "no-tag" });
  });
});

describe("homes", () => {
  it("reports version, ledger flag, age, and staleness at the limit", () => {
    const view = buildView(
      input({
        homes: [
          home("main", { lastOkAt: NOW - 180_000 }),
          home("far", {
            lastOkAt: NOW - 180_001,
            error: "ssh failed",
            version: "different",
            report: report({ ledger_enabled: false, ledger_hint: "turn it on" }),
          }),
          home("never", { lastOkAt: null, report: null, version: "unreported", error: "gone" }),
        ],
      }),
    );
    expect(view.homes).toEqual([
      {
        id: "main",
        version: "same",
        ledger_enabled: true,
        ledger_hint: null,
        stale: false,
        last_ok_seconds_ago: 180,
        error: null,
      },
      {
        id: "far",
        version: "different",
        ledger_enabled: false,
        ledger_hint: "turn it on",
        stale: true,
        last_ok_seconds_ago: 180,
        error: "ssh failed",
      },
      {
        id: "never",
        version: "unreported",
        ledger_enabled: null,
        ledger_hint: null,
        stale: true,
        last_ok_seconds_ago: null,
        error: "gone",
      },
    ]);
  });
});

describe("queued", () => {
  const item = (id: string, extra: Partial<ReportQueued> = {}): ReportQueued => ({
    id,
    kind: "ship",
    title: `title ${id}`,
    hold: null,
    captain: false,
    blockers: [],
    topic_hint: null,
    ...extra,
  });

  it("places an untagged queued item by the topic its body names, until a tag says otherwise", () => {
    const view = buildView(
      input({
        homes: [
          home("main"),
          home("sm1", {
            report: report({
              queued: [
                item("handed", { topic_hint: "hi" }),
                item("merged-hint", { topic_hint: "old" }),
                item("tagged", { topic_hint: "hi" }),
                item("unknown-hint", { topic_hint: "nope" }),
                item("bare"),
              ],
              topics: { tagged: "n2 2026-07-01T00:00:00Z" },
            }),
          }),
        ],
      }),
    );
    expect(Object.fromEntries(view.queued.map((entry) => [entry.task, entry.topic]))).toEqual({
      handed: "hi",
      "merged-hint": "n1",
      tagged: "n2",
      "unknown-hint": null,
      bare: null,
    });
  });

  it("lists every home's queued items under their topics with what each waits for", () => {
    const view = buildView(
      input({
        homes: [
          home("main", {
            report: report({
              queued: [
                item("ready"),
                item("held", { hold: "waiting for a vendor" }),
                item("call", { kind: "captain", hold: "pick one", captain: true }),
                item("after", { blockers: ["ready", "held"] }),
                item("loose"),
                item("merged-away"),
              ],
              topics: {
                ready: "hi 2026-07-01T00:00:00Z",
                held: "hi 2026-07-01T00:00:00Z",
                call: "n1 2026-07-01T00:00:00Z",
                after: "lt 2026-07-01T00:00:00Z",
                "merged-away": "old 2026-07-01T00:00:00Z",
              },
            }),
          }),
          home("sm1", {
            report: report({ queued: [item("far")], topics: { far: "hi 2026-07-01T00:00:00Z" } }),
          }),
          home("down", { report: null }),
        ],
      }),
    );
    expect(view.queued).toEqual([
      {
        home: "main",
        task: "ready",
        kind: "ship",
        title: "title ready",
        topic: "hi",
        waiting: null,
      },
      {
        home: "main",
        task: "held",
        kind: "ship",
        title: "title held",
        topic: "hi",
        waiting: "停著：waiting for a vendor",
      },
      {
        home: "main",
        task: "call",
        kind: "captain",
        title: "title call",
        topic: "n1",
        waiting: "等你決定",
      },
      {
        home: "main",
        task: "after",
        kind: "ship",
        title: "title after",
        topic: "lt",
        waiting: "等 ready、held 完成",
      },
      {
        home: "main",
        task: "loose",
        kind: "ship",
        title: "title loose",
        topic: null,
        waiting: null,
      },
      {
        home: "main",
        task: "merged-away",
        kind: "ship",
        title: "title merged-away",
        topic: "n1",
        waiting: null,
      },
      { home: "sm1", task: "far", kind: "ship", title: "title far", topic: "hi", waiting: null },
    ]);
  });

  it("says a hold comes before blockers when an item has both", () => {
    const view = buildView(
      input({
        homes: [
          home("main", {
            report: report({ queued: [item("both", { hold: "later", blockers: ["x"] })] }),
          }),
        ],
      }),
    );
    expect(view.queued.map((entry) => entry.waiting)).toEqual(["停著：later"]);
  });
});

describe("agents", () => {
  const task = (id: string, state: string, kind = "ship") => ({
    id,
    kind,
    state,
    source: "s",
    detail: `detail ${id}`,
    unstarted: false,
  });
  const ledger = (taskId: string, event: string, ts: number, homeId = "main"): JournalEvent => ({
    src: "ledger",
    home: homeId,
    ts,
    event,
    task: taskId,
    fields: {},
  });

  it("maps each state to a light and puts a live hold first", () => {
    const states = ["blocked", "failed", "working", "parked", "paused", "done", "unknown", "odd"];
    const view = buildView(
      input({
        homes: [
          home("main", {
            report: report({
              tasks: [
                ...states.map((state) => task(`t-${state}`, state)),
                task("held", "working"),
                task("deferred", "working"),
                task("mate", "working", "secondmate"),
              ],
              holds: [hold("held"), hold("deferred", { hold_bucket: "aged" })],
              topics: { held: tag("hi") },
            }),
          }),
        ],
        events: [ledger("held", "task.status", T0 + 5), ledger("held", "task.status", T0 + 9)],
      }),
    );
    const lights = Object.fromEntries(view.agents.map((agent) => [agent.task, agent.light]));
    expect(lights).toEqual({
      "t-blocked": "stuck",
      "t-failed": "stuck",
      "t-working": "working",
      "t-parked": "working",
      "t-paused": "working",
      "t-done": "done",
      "t-unknown": "unknown",
      "t-odd": "unknown",
      held: "decide",
      deferred: "working",
    });
    expect(view.agents.find((agent) => agent.task === "held")).toEqual({
      home: "main",
      task: "held",
      kind: "ship",
      light: "decide",
      state: "working",
      detail: "detail held",
      topic: "hi",
      unsorted_reason: null,
      updated_at: T0 + 9,
      stale: false,
      unstarted: false,
      finished: false,
    });
    expect(view.agents.find((agent) => agent.task === "t-done")).toMatchObject({
      topic: null,
      unsorted_reason: "no-tag",
      updated_at: null,
    });
  });

  it("marks a task whose harness never took its first turn, and no ended one", () => {
    const view = buildView(
      input({
        homes: [
          home("main", {
            report: report({
              tasks: [{ ...task("quiet", "working"), unstarted: true }, task("spoke", "working")],
            }),
          }),
        ],
        events: [ledger("quiet", "task.dispatched", T0), ledger("gone", "task.merged", T0 + 1)],
      }),
    );
    expect(view.agents.map((agent) => `${agent.task}:${agent.unstarted}`).toSorted()).toEqual([
      "gone:false",
      "quiet:true",
      "spoke:false",
    ]);
  });

  it("lists a cleaned-up task from its last ledger event, per home", () => {
    const view = buildView(
      input({
        homes: [
          home("main", { report: report({ tasks: [task("alive", "working")] }) }),
          home("sm", { report: report() }),
          home("down", { report: null }),
        ],
        events: [
          ledger("alive", "task.merged", T0),
          ledger("merged", "task.dispatched", T0),
          ledger("merged", "task.merged", T0 + 1),
          ledger("cleaned", "task.cleaned_up", T0 + 2),
          ledger("lost", "task.status", T0 + 3),
          ledger("theirs", "task.cleaned_up", T0 + 4, "sm"),
          ledger("ghost", "task.cleaned_up", T0 + 5, "down"),
        ],
      }),
    );
    expect(
      view.agents.map(
        (agent) => `${agent.home}/${agent.task}=${agent.light}:${agent.state}:${agent.kind}`,
      ),
    ).toEqual([
      "main/alive=working:working:ship",
      "main/merged=done:done:",
      "main/cleaned=done:done:",
      "sm/theirs=done:done:",
    ]);
    expect(view.agents.map((agent) => `${agent.task}:${agent.finished}`)).toEqual([
      "alive:false",
      "merged:true",
      "cleaned:true",
      "theirs:true",
    ]);
  });

  it("lists only work items, never a mate's own record or a remote mate's reply channel", () => {
    const dispatched = (taskId: string, kind: string, ts: number, homeId = "main") => ({
      ...ledger(taskId, "task.dispatched", ts, homeId),
      fields: { kind },
    });
    const view = buildView(
      input({
        homes: [
          home("main", {
            report: report({
              tasks: [task("open", "working"), task("live-mate", "working", "secondmate")],
              status_decisions: [
                { id: "live-mate", key: "relay", summary: "a child's call" },
                { id: "open", key: "k", summary: "which API?" },
              ],
              topics: { "retired-mate": tag("hi"), "old-work": tag("n2") },
            }),
          }),
          home("far", { report: report() }),
        ],
        events: [
          dispatched("retired-mate", "secondmate", T0),
          ledger("retired-mate", "task.status", T0 + 1),
          ledger("retired-mate", "task.cleaned_up", T0 + 2),
          ledger("live-mate", "task.status", T0 + 3),
          ledger("parent-replies", "task.status", T0 + 4, "far"),
          ledger("parent-replies", "task.status", T0 + 5, "far"),
          dispatched("far-work", "scout", T0 + 6, "far"),
          ledger("far-work", "task.cleaned_up", T0 + 7, "far"),
          ledger("old-work", "task.status", T0 + 8),
          ledger("old-work", "task.cleaned_up", T0 + 9),
          ledger("old-pr", "task.pr_ready", T0 + 10),
          dispatched("reused", "secondmate", T0 + 11),
          ledger("reused", "task.cleaned_up", T0 + 12),
          dispatched("reused", "ship", T0 + 13),
          ledger("reused", "task.merged", T0 + 14),
        ],
      }),
    );
    expect(view.agents.map((agent) => `${agent.home}/${agent.task}:${agent.finished}`)).toEqual([
      "main/open:false",
      "main/old-work:true",
      "main/old-pr:true",
      "main/reused:true",
      "far/far-work:true",
    ]);
    expect(view.agents.find((agent) => agent.task === "old-work")?.topic).toBe("n2");
    expect(view.questions.map((question) => question.task)).toEqual(["open"]);
    const updates = view.updates.map((update) => `${update.home}/${update.task}:${update.topic}`);
    expect(updates).toContain("main/retired-mate:hi");
    expect(updates).toContain("far/parent-replies:null");
  });

  it("tells a ship task that was cleaned up without landing from one that landed", () => {
    const dispatched = (taskId: string, kind: string, ts: number): JournalEvent => ({
      src: "ledger",
      home: "main",
      ts,
      event: "task.dispatched",
      task: taskId,
      fields: { kind },
    });
    const view = buildView(
      input({
        homes: [home("main", { report: report() })],
        events: [
          dispatched("landed", "ship", T0),
          ledger("landed", "task.merged", T0 + 1),
          ledger("landed", "task.cleaned_up", T0 + 2),
          dispatched("dropped", "ship", T0 + 3),
          ledger("dropped", "task.status", T0 + 4),
          ledger("dropped", "task.cleaned_up", T0 + 5),
          dispatched("scouted", "scout", T0 + 6),
          ledger("scouted", "task.cleaned_up", T0 + 7),
          ledger("redone", "task.merged", T0 + 8),
          dispatched("redone", "ship", T0 + 9),
          ledger("redone", "task.cleaned_up", T0 + 10),
          ledger("undated", "task.cleaned_up", T0 + 11),
        ],
      }),
    );
    expect(
      view.agents.map((agent) => `${agent.task}=${agent.light}:${agent.state}:${agent.kind}`),
    ).toEqual([
      "landed=done:done:ship",
      "dropped=unknown:discarded:ship",
      "scouted=done:done:scout",
      "redone=unknown:discarded:ship",
      "undated=done:done:",
    ]);
    expect(view.agents.find((agent) => agent.task === "dropped")?.detail).toBe(
      "已收掉，帳本裡沒有落地紀錄",
    );
  });

  it("turns every light of a stale home to unknown but keeps the state text", () => {
    const view = buildView(
      input({
        homes: [
          home("main", {
            lastOkAt: NOW - 200_000,
            report: report({ tasks: [task("t", "working")], holds: [hold("t")] }),
          }),
        ],
      }),
    );
    expect(view.agents[0]).toMatchObject({ light: "unknown", state: "working", stale: true });
    expect(view.holds[0]?.stale).toBe(true);
  });
});

describe("holds and questions", () => {
  it("places a hold by its task, then its origin, and orders them", () => {
    const view = buildView(
      input({
        homes: [
          home("main", {
            report: report({
              holds: [
                hold("loose"),
                hold("loose-old", { hold_age_days: 5 }),
                hold("own-wins", { origin: "worker" }),
                hold("age-unknown", { hold_age_days: null }),
                hold("via-origin", { origin: "worker" }),
                hold("origin-unknown", { origin: "nobody" }),
                hold("later-old", { hold_age_days: 9 }),
                hold("later-new", { hold_age_days: 2 }),
                hold("normal-2"),
                hold("normal-1", { question: "行嗎？ 選項：行 | 不行" }),
                hold("high-deferred", { hold_bucket: "dated", hold_until: "2026-12-01" }),
                hold("aged", { hold_bucket: "aged" }),
                hold("blocked", { hold_bucket: "blocked", unresolved_blocker_ids: ["x", "y"] }),
                hold("undated", { hold_bucket: "dated" }),
                hold("archived"),
              ],
              status_decisions: [
                { id: "worker", key: "k", summary: "which API?" },
                { id: "stranger", key: "", summary: "?" },
              ],
              topics: {
                worker: tag("hi"),
                "later-old": tag("lt"),
                "later-new": tag("lt"),
                "normal-2": tag("n2"),
                "own-wins": tag("n2"),
                "age-unknown": tag("n2"),
                "normal-1": tag("n1"),
                "high-deferred": tag("hi"),
                archived: tag("gone"),
              },
            }),
          }),
        ],
      }),
    );
    expect(view.holds.map((entry) => entry.task)).toEqual([
      "via-origin",
      "normal-1",
      "normal-2",
      "own-wins",
      "age-unknown",
      "later-old",
      "later-new",
      "loose-old",
      "archived",
      "loose",
      "origin-unknown",
      "high-deferred",
      "aged",
      "blocked",
      "undated",
    ]);
    const byTask = Object.fromEntries(view.holds.map((entry) => [entry.task, entry]));
    expect(byTask["via-origin"]).toEqual({
      home: "main",
      task: "via-origin",
      title: "title via-origin",
      question: "q",
      options: [],
      on_answer: "release",
      on_answer_recorded: false,
      live: true,
      deferred_reason: null,
      topic: "hi",
      stale: false,
    });
    expect(byTask["normal-1"]?.options).toEqual(["行", "不行"]);
    expect(byTask["loose"]?.topic).toBeNull();
    expect(byTask["own-wins"]?.topic).toBe("n2");
    expect(byTask["origin-unknown"]?.topic).toBeNull();
    expect(byTask["archived"]?.topic).toBe("gone");
    expect(byTask["high-deferred"]).toMatchObject({
      live: false,
      deferred_reason: "延到 2026-12-01",
      topic: "hi",
    });
    expect(byTask["aged"]?.deferred_reason).toBe("已放超過 14 天");
    expect(byTask["blocked"]?.deferred_reason).toBe("等 x、y 完成");
    expect(byTask["undated"]?.deferred_reason).toBe("延到 之後");
    expect(view.questions).toEqual([
      { home: "main", task: "worker", key: "k", summary: "which API?", topic: "hi" },
      { home: "main", task: "stranger", key: "", summary: "?", topic: null },
    ]);
  });

  it("breaks ties between holds of one topic by task id", () => {
    const view = buildView(
      input({
        homes: [
          home("main", {
            report: report({
              holds: [hold("b"), hold("a")],
              topics: { a: tag("hi"), b: tag("hi") },
            }),
          }),
        ],
      }),
    );
    expect(view.holds.map((entry) => entry.task)).toEqual(["a", "b"]);
  });
});

describe("hands-on items", () => {
  const item = (topic: string | null, extra: Partial<TodoItem> = {}): TodoItem => ({
    title: "T",
    topic,
    action: "登入",
    guidance: "",
    commands: [],
    state: "open",
    reason: null,
    at: "t",
    by: "plain",
    ref: "",
    captain_closes: false,
    created_at: "2026-07-01T00:00:00Z",
    ...extra,
  });
  const store = (items: Record<string, TodoItem>): TodoStore => ({ ...emptyTodos(), items });

  it("shows the board's items in their topics' queue order, merges followed, no topic last", () => {
    const view = buildView(
      input({
        todos: store({
          none: item(null),
          normal: item("n2", { created_at: "2026-07-02T00:00:00Z" }),
          merged: item("old", { created_at: "2026-07-03T00:00:00Z" }),
          early: item("n1", { created_at: "2026-07-01T00:00:00Z" }),
          high: item("hi", { state: "rejected", reason: "沒起來" }),
          archived: item("gone"),
        }),
      }),
    );
    expect(view.todos.map((todo) => `${todo.task}:${todo.topic}`)).toEqual([
      "high:hi",
      "early:n1",
      "merged:n1",
      "normal:n2",
      "archived:gone",
      "none:null",
    ]);
    expect(view.todos[0]).toEqual({
      task: "high",
      title: "T",
      topic: "hi",
      what: "登入",
      guidance: "",
      commands: [],
      state: "rejected",
      reason: "沒起來",
    });
  });

  it("keeps guidance and each command exactly as stored", () => {
    const commands = ["sudo tee /etc/x <<'EOF'\n\tkey = 1\nEOF", "說明：只是指令"];
    const view = buildView(
      input({ todos: store({ x: item("hi", { guidance: "先關 VPN。\n  第二行", commands }) }) }),
    );
    expect(view.todos[0]).toMatchObject({ guidance: "先關 VPN。\n  第二行", commands });
  });

  it("reads a hold whose reason starts with 動手： as an ordinary decision, in every home", () => {
    const holds = buildView(
      input({
        homes: [
          home("main", {
            report: report({ holds: [hold("old", { question: "動手：選一個\n選項：甲 | 乙" })] }),
          }),
          home("sm1", { report: report({ holds: [hold("mate", { question: "動手：x" })] }) }),
        ],
      }),
    ).holds;
    const seen = holds.map(
      (entry) => `${entry.home}/${entry.task}:${entry.on_answer}/${entry.on_answer_recorded}`,
    );
    expect(seen.toSorted()).toEqual(["main/old:release/false", "sm1/mate:release/false"]);
    expect(holds.find((entry) => entry.task === "old")?.options).toEqual(["甲", "乙"]);
    expect(buildView(input()).todos).toEqual([]);
  });

  it("labels every queued captain item as waiting for a decision", () => {
    const queued: ReportQueued = {
      id: "mine",
      kind: "captain",
      title: "mine",
      hold: "動手：登入",
      captain: true,
      blockers: [],
      topic_hint: null,
    };
    const view = buildView(
      input({ homes: [home("main", { report: report({ queued: [queued] }) })] }),
    );
    expect(view.queued.map((entry) => entry.waiting)).toEqual(["等你決定"]);
  });
});

describe("updates and summaries", () => {
  const ledger = (
    taskId: string,
    event: string,
    ts: number,
    fields: Record<string, unknown> = {},
  ): JournalEvent => ({ src: "ledger", home: "main", ts, event, task: taskId, fields });
  const homes = [
    home("main", {
      report: report({
        topics: {
          t: `${tag("hi", "02")}\n${tag("n2", "04")}`,
          u: tag("old"),
          w: `${tag("hi", "02")}\n${tag("n2", "03")}\n${tag("lt", "04")}`,
        },
      }),
    }),
  ];
  const day = (n: number) => T0 + (n - 1) * 86_400;

  it("files each event under the topic tagged when it happened, newest first", () => {
    const events: JournalEvent[] = [
      ledger("t", "task.dispatched", day(1)),
      ledger("t", "task.status", day(2), { state: "working", text: " halfway " }),
      ledger("t", "task.status", day(3), { state: null, text: "no state" }),
      ledger("t", "task.pr_ready", day(4), { pr: "https://x/pull/1" }),
      ledger("t", "task.status", day(5), { state: "done" }),
      ledger("nobody", "task.cleaned_up", day(6), { pr: 7 }),
      ledger("w", "task.status", day(6) + 1),
      {
        src: "board",
        ts: day(7),
        kind: "topic.merged",
        topic: "old",
        home: null,
        task: null,
        text: "merged",
      },
      {
        src: "board",
        ts: day(8),
        kind: "hold.answered",
        topic: null,
        home: "main",
        task: "t",
        text: "answered",
      },
    ];
    const built = buildView(input({ homes, events }));
    const view = { ...built, updates: built.updates.filter((update) => update.source !== "tag") };
    expect(view.updates.map((update) => `${update.event}@${update.topic}`)).toEqual([
      "hold.answered@null",
      "topic.merged@n1",
      "task.status@lt",
      "task.cleaned_up@null",
      "task.status@n2",
      "task.pr_ready@n2",
      "task.status@hi",
      "task.status@hi",
      "task.dispatched@hi",
    ]);
    expect(view.updates[5]).toEqual({
      ts: day(4),
      source: "ledger",
      home: "main",
      task: "t",
      event: "task.pr_ready",
      text: "",
      pr: "https://x/pull/1",
      topic: "n2",
    });
    expect(view.updates[7]?.text).toBe("working：halfway");
    expect(view.updates[6]?.text).toBe("no state");
    expect(view.updates[4]?.text).toBe("done：");
    expect(view.updates[3]?.pr).toBeNull();
    expect(view.updates[1]).toEqual({
      ts: day(7),
      source: "board",
      home: null,
      task: null,
      event: "topic.merged",
      text: "merged",
      pr: null,
      topic: "n1",
    });
  });

  it("uses the one tag written by then even when it is not the file's first line", () => {
    const outOfOrder = [
      home("main", { report: report({ topics: { z: `${tag("n2", "04")}\n${tag("hi", "02")}` } }) }),
    ];
    const view = buildView(
      input({ homes: outOfOrder, events: [ledger("z", "task.status", day(3))] }),
    );
    expect(view.updates.find((update) => update.source === "ledger")?.topic).toBe("hi");
  });

  it("keeps every board record, and the newest ledger lines of each topic", () => {
    const busy = Array.from({ length: LEDGER_PER_TOPIC + 5 }, (_unused, index) =>
      ledger("t", "task.status", day(5) + index),
    );
    const quiet: JournalEvent[] = [
      ledger("u", "task.status", day(1)),
      {
        src: "board",
        ts: day(1) - 10,
        kind: "topic.created",
        topic: "old",
        home: null,
        task: null,
        text: "created long ago",
      },
    ];
    const view = buildView(input({ homes, events: [...quiet, ...busy] }));
    const ledgerOf = (topic: string) =>
      view.updates.filter((update) => update.source === "ledger" && update.topic === topic);
    expect(ledgerOf("n2")).toHaveLength(LEDGER_PER_TOPIC);
    expect(ledgerOf("n2")[0]?.ts).toBe(day(5) + LEDGER_PER_TOPIC + 4);
    expect(ledgerOf("n2").at(-1)?.ts).toBe(day(5) + 5);
    expect(ledgerOf("n1")).toHaveLength(1);
    expect(view.updates.at(-1)).toMatchObject({ source: "board", text: "created long ago" });
  });

  it("shows a tag made by command, and a page tag once, through its record", () => {
    const tagged = [
      home("main", {
        report: report({
          topics: {
            page: tag("hi", "02"),
            cmd: `${tag("hi", "02")}\n${tag("n2", "03")}`,
            bad: "hi",
          },
        }),
      }),
    ];
    const record: JournalEvent = {
      src: "board",
      ts: day(2) + 30,
      kind: "agent.tagged",
      topic: "hi",
      home: "main",
      task: "page",
      text: "main/page 歸到「Hi」",
    };
    const view = buildView(input({ homes: tagged, events: [record] }));
    const lines = view.updates.map((update) => `${update.source} ${update.task} ${update.text}`);
    expect(lines.toSorted()).toEqual([
      "board page main/page 歸到「Hi」",
      "tag cmd 歸到「High」（plain 用指令）",
      "tag cmd 歸到「Normal two」（plain 用指令）",
    ]);
    expect(view.updates.find((update) => update.text.includes("Normal two"))).toEqual({
      ts: day(3),
      source: "tag",
      home: "main",
      task: "cmd",
      event: "agent.tagged",
      text: "歸到「Normal two」（plain 用指令）",
      pr: null,
      topic: "n2",
    });
  });

  it("links a ready or landed summary to the task's latest PR at that time", () => {
    const events: JournalEvent[] = [
      ledger("t", "task.pr_ready", day(2), { pr: "https://x/pull/1" }),
      ledger("other", "task.pr_ready", day(3), { pr: "https://x/pull/9" }),
      ledger("t", "task.status", day(3), { pr: "https://x/not-a-pr-event" }),
      ledger("t", "task.merged", day(5), { pr: "https://x/pull/2" }),
      {
        src: "ledger",
        home: "sm",
        ts: day(2),
        event: "task.pr_ready",
        task: "t",
        fields: { pr: "https://x/pull/8" },
      },
    ];
    const summary = (kind: Summary["kind"], ts: number, taskId = "t"): Summary => ({
      ts,
      home: "main",
      task: taskId,
      kind,
      text: `${kind} text`,
    });
    const view = buildView(
      input({
        homes,
        events,
        summaries: [
          summary("ready", day(1)),
          summary("ready", day(2)),
          summary("ready", day(4)),
          summary("landed", day(6)),
          summary("report", day(6)),
          summary("failed", day(6), "u"),
        ],
      }),
    );
    expect(
      view.summaries.map((entry) => `${entry.kind}@${entry.ts - T0}:${entry.pr}:${entry.topic}`),
    ).toEqual([
      `landed@${5 * 86_400}:https://x/pull/2:n2`,
      `report@${5 * 86_400}:null:n2`,
      `failed@${5 * 86_400}:null:n1`,
      `ready@${3 * 86_400}:https://x/pull/1:n2`,
      `ready@${86_400}:https://x/pull/1:n2`,
      "ready@0:null:n2",
    ]);
    expect(view.summaries[0]).toEqual({
      ts: day(6),
      home: "main",
      task: "t",
      kind: "landed",
      text: "landed text",
      pr: "https://x/pull/2",
      topic: "n2",
    });
  });
});

describe("topics", () => {
  it("carries queues and every topic with its status", () => {
    const view = buildView(input());
    expect(view.queues).toEqual({ high: ["hi"], normal: ["n1", "n2"], later: ["lt"] });
    expect(view.topics["n1"]).toEqual({
      name: "Normal one",
      goal: "goal of Normal one",
      status: "confirmed",
      queue: "normal",
      close_reason: "all done",
      archived_at: null,
    });
    expect(view.topics["hi"]).toMatchObject({ queue: "high", close_reason: null });
    expect(view.topics["lt"]?.queue).toBe("later");
    expect(view.topics["gone"]).toEqual({
      name: "Gone",
      goal: "goal of Gone",
      status: "archived",
      queue: null,
      close_reason: null,
      archived_at: "2026-06-01T00:00:00Z",
    });
  });

  it("does not share its queues with the topic state", () => {
    const state = topics();
    const view = buildView(input({ topics: state }));
    view.queues.high.push("x");
    expect(state.doc.queues.high).toEqual(["hi"]);
  });
});

describe("closed hands-on items", () => {
  const rec = (item: string, kind: string, ts: number, topic = "hi", extra = {}): JournalEvent => ({
    src: "board",
    rid: `r-${ts}`,
    ts,
    kind,
    topic,
    home: null,
    task: null,
    item,
    by: "aggregator",
    label: "plain",
    text: `${item} ${kind}`,
    ...extra,
  });

  it("lists each life that closed, newest first, with its records, and leaves out a live one", () => {
    const events = [
      rec("vpn", "todo.opened", T0 + 1),
      rec("vpn", "todo.claimed", T0 + 2),
      rec("vpn", "todo.rejected", T0 + 3),
      rec("other", "todo.opened", T0 + 4, "old"),
      rec("vpn", "todo.done", T0 + 5, "hi", { outcome: "done" }),
      rec("other", "todo.dropped", T0 + 6, "old", { outcome: "dropped" }),
      rec("vpn", "todo.opened", T0 + 7),
    ];
    const view = buildView(input({ events }));
    expect(view.closed_todos.map((entry) => [entry.item, entry.topic, entry.outcome])).toEqual([
      ["other", "n1", "dropped"],
      ["vpn", "hi", "done"],
    ]);
    expect(view.closed_todos[1]).toMatchObject({ ts: T0 + 5, text: "vpn todo.done" });
    expect(view.closed_todos[1]?.records.map((update) => update.event)).toEqual([
      "todo.done",
      "todo.rejected",
      "todo.claimed",
      "todo.opened",
    ]);
    expect(buildView(input()).closed_todos).toEqual([]);
  });
});

describe("closed decisions", () => {
  const rec = (task: string, kind: string, ts: number, extra = {}): JournalEvent => ({
    src: "board",
    rid: `r-${task}-${kind}-${ts}`,
    ts,
    kind,
    topic: "hi",
    home: "main",
    task,
    by: "board",
    label: "plain",
    text: `${task} ${kind}`,
    ...extra,
  });
  const closed = (events: JournalEvent[]) =>
    buildView(input({ events })).closed_decisions.map((entry) => [
      entry.task,
      entry.topic,
      entry.text,
      entry.records.map((update) => update.event).join(" "),
    ]);

  it("lists each decision with a closing record, newest first, and leaves out an open one", () => {
    expect(
      closed([
        rec("page", "hold.opened", T0 + 1),
        rec("chat", "hold.opened", T0 + 2),
        rec("open", "hold.opened", T0 + 3),
        rec("page", "hold.answered", T0 + 4, { by: "captain", outcome: "要" }),
        rec("chat", "hold.closed", T0 + 5, { topic: "old", outcome: "answered" }),
      ]),
    ).toEqual([
      ["chat", "n1", "chat hold.closed", "hold.closed hold.opened"],
      ["page", "hi", "page hold.answered", "hold.answered hold.opened"],
    ]);
  });

  it("counts a decision with two closing records once, in either order", () => {
    const elsewhere = rec("x", "hold.closed", T0 + 3, { outcome: "elsewhere" });
    const real = rec("x", "hold.closed", T0 + 2, { outcome: "answered" });
    const opened = rec("x", "hold.opened", T0 + 1);
    expect(closed([opened, elsewhere, real])).toEqual([
      ["x", "hi", "x hold.closed", "hold.closed hold.closed hold.opened"],
    ]);
    expect(closed([opened, real, elsewhere])).toHaveLength(1);
  });

  it("starts a new life at an opening after a close; a close with no opening is a life", () => {
    const view = buildView(
      input({
        events: [
          rec("x", "hold.closed", T0 + 1),
          rec("x", "hold.opened", T0 + 2),
          rec("x", "hold.closed", T0 + 3),
          rec("x", "hold.opened", T0 + 4),
        ],
      }),
    );
    expect(view.closed_decisions.map((entry) => [entry.ts, entry.records.length])).toEqual([
      [T0 + 3, 2],
      [T0 + 1, 1],
    ]);
  });

  it("keeps homes apart, and leaves out records of no home or task and other kinds", () => {
    expect(
      closed([
        rec("x", "hold.opened", T0 + 1),
        rec("x", "hold.closed", T0 + 2, { home: "sm1" }),
        rec("x", "hold.closed", T0 + 3, { home: null }),
        rec("x", "agent.tagged", T0 + 4),
      ]).map((entry) => entry[3]),
    ).toEqual(["hold.closed"]);
    expect(buildView(input()).closed_decisions).toEqual([]);
  });

  it("keeps a task's other records and ledger lines out of its decision's life", () => {
    const ledger: JournalEvent = {
      src: "ledger",
      home: "main",
      ts: T0 + 4,
      event: "task.status",
      task: "x",
      fields: {},
    };
    expect(
      closed([
        rec("x", "hold.opened", T0 + 1),
        rec("x", "agent.tagged", T0 + 2),
        rec("x", "hold.closed", T0 + 3),
        ledger,
      ]).map((entry) => entry[3]),
    ).toEqual(["hold.closed hold.opened"]);
  });
});
