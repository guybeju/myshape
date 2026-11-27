// Every card's lifecycle (spec/lifecycle.markdown): the closed set of states
// of each kind of card, who owns each state and its deadline (LIFECYCLE), the
// state of every card the board knows, derived from what it shows, and the
// clocks that time the states the aggregator owns. Pure: board-server.ts
// commits what evaluate returns.
import {
  DATE_GRACE_MINUTES,
  TIMED_STATES,
  defaultSettings,
  durationWords,
} from "./lifecycle-settings.js";
import type { LifecycleSettings, TimedState } from "./lifecycle-settings.js";
import type { Draft, Frozen } from "./records.js";
import { MAIN_HOME } from "./journal.js";
import { isNew } from "./schedules.js";
import type { ScheduleStore } from "./schedules.js";
import {
  NO_TOPIC,
  cardName,
  idleStep,
  nudgeOf,
  stallKeyOf,
  stallState,
  stallStep,
} from "./stalls.js";
import type { Nudge, NudgeLine } from "./stalls.js";
import type { AgentView, BoardView, HoldView, QueuedView, TodoView, TopicView } from "./view.js";

/** Who makes a state's next move (spec/lifecycle.markdown section 1). */
export type Owner = "captain" | "aggregator" | "board" | "time" | "none";

/**
 * One state's rule: its owner and, for a state the aggregator owns, the
 * setting that times it ("members" for a 沒人接 card, timed by its members;
 * "N3" for one the captain asked the aggregator to handle, timed by N3's setting).
 */
export interface Rule {
  owner: Owner;
  deadline: TimedState | "members" | "N3" | null;
}

const captain: Rule = { owner: "captain", deadline: null };
const board: Rule = { owner: "board", deadline: null };
const time: Rule = { owner: "time", deadline: null };
const end: Rule = { owner: "none", deadline: null };
const timed = (state: TimedState): Rule => ({ owner: "aggregator", deadline: state });

/** Every state of every kind of card. A state without a rule here does not compile. */
export const LIFECYCLE = {
  // topics (stored)
  T1: time,
  T2: timed("T2"),
  T3: captain,
  T4: time,
  T5: board,
  T6: captain,
  T7: time,
  T8: end,
  T10: board,
  // decisions (read)
  D1: captain,
  D2: board,
  D3: time,
  D4: time,
  D5: timed("D5"),
  D6: board,
  D7: captain,
  D8: timed("D8"),
  D9: timed("D9"),
  D10: board,
  // queued items (read)
  Q1: timed("Q1"),
  Q2: captain,
  Q3: captain,
  Q4: timed("Q4"),
  Q5: timed("Q5"),
  Q6: time,
  Q7: time,
  Q8: timed("Q8"),
  Q9: timed("Q9"),
  Q10: board,
  NT: timed("NT"),
  // agents (read)
  A1: timed("A1"),
  A2: timed("A2"),
  A3: timed("A3"),
  A4: timed("A4"),
  A5: timed("A5"),
  A6: timed("A6"),
  A7: captain,
  A8: board,
  A9: end,
  // worker questions (read)
  W1: timed("W1"),
  // hands-on items (stored)
  O1: captain,
  O2: captain,
  O3: timed("O3"),
  O4: captain,
  O6: captain,
  // schedules (stored)
  S1: time,
  S2: captain,
  S3: timed("S3"),
  S4: captain,
  S5: captain,
  S6: timed("S6"),
  // 沒人接 cards (stored)
  N1: { owner: "aggregator", deadline: "members" },
  N2: captain,
  N3: { owner: "aggregator", deadline: "N3" },
  N4: time,
} as const satisfies Record<string, Rule>;

export type CardState = keyof typeof LIFECYCLE;

export type CardKind = "topic" | "hold" | "queued" | "agent" | "question" | "todo" | "schedule";

/** One card and the state it is in now. */
export interface Card {
  /** Kind, home and id, tab-separated; a no-topic flag adds "\tNT". */
  key: string;
  kind: CardKind;
  state: CardState;
  topic: string | null;
  /** The home a read card comes from; null for a card the board stores. */
  home: string | null;
  /** How the card is named on the page: home/task, or the topic or item. */
  label: string;
  /**
   * What restarts the state's clock when it changes: an agent's state, detail
   * and last event; for S6, the run of occurrences nobody took, which also times it.
   */
  sig: string;
}

/** When the board first saw a card in the timed state it is in, and whether it reminded the aggregator of it since. */
export interface Clock {
  state: TimedState;
  since: string;
  sig: string;
  reminded?: true;
}

/**
 * A 沒人接 card in front of the captain, the members the captain put off, if
 * any, and when the captain asked the aggregator to handle the members listed
 * then (N3), which stays with the card so it is asked once only.
 */
export interface Stall {
  since: string;
  members: string[];
  deferred?: { until: string; members: string[] };
  asked?: { at: string; members: string[] };
}

/** What the board saw: first-seen times, where topics had work, and its 沒人接 cards. */
export interface LifecycleMemory {
  clocks: Record<string, Clock>;
  /** Topic id to the homes whose last good read had work under it. */
  homes: Record<string, string[]>;
  /** Topic id, or "-" for work with no topic, to its 沒人接 card. */
  stalls: Record<string, Stall>;
  /** Topic id to its 沒人處理的議題 card: when the board raised it. */
  idle: Record<string, string>;
}

/** data/myshape/lifecycle.json. */
export interface LifecycleStore extends LifecycleMemory {
  v: 1;
  settings: LifecycleSettings;
  /** Topic id to when 先不關 ends. */
  kept: Record<string, string>;
}

export function emptyLifecycle(): LifecycleStore {
  return {
    v: 1,
    settings: defaultSettings(),
    kept: {},
    clocks: {},
    homes: {},
    stalls: {},
    idle: {},
  };
}

/** A write as the lifecycle reads it: whose answer, and how sending it went. */
export interface WriteLine {
  kind: string;
  home: string;
  task: string | null;
  topic: string | null;
  state: string;
  question_sha256: string | null;
  /** When the write reached its state, epoch ms, or null when the board does not know. */
  settledAt: number | null;
}

/** A schedule as the lifecycle reads it. */
export interface ScheduleLine {
  id: string;
  topic: string;
  title: string;
  state: "on" | "paused";
  /** Whether its last pause, by its records, was the aggregator's. */
  pausedByAggregator: boolean;
  waitsEnable: boolean;
  /** Occurrences in a row, newest first, that nobody took or that timed out. */
  unanswered: number;
  open: boolean;
}

/** Everything a card's state is read from besides the board's view. */
export interface LifecycleContext {
  store: Frozen<LifecycleStore>;
  schedules: readonly ScheduleLine[];
  allPaused: boolean;
  writes: readonly WriteLine[];
  /** Homes whose last read was good and is not stale. */
  fresh: ReadonlySet<string>;
  /** Every home the board reads. */
  present: ReadonlySet<string>;
  /** SHA-256 of each hold's question, by "home\ttask". */
  questions: ReadonlyMap<string, string>;
  /** When the last good read of each home began, epoch ms. */
  readFrom: ReadonlyMap<string, number>;
  /** What the board's sentences call the aggregator. */
  label: string;
  nowMs: number;
}

function card(
  kind: CardKind,
  parts: { home: string | null; id: string; topic: string | null; label: string },
  state: CardState,
  sig = "",
): Card {
  const key = [kind, ...(parts.home === null ? [] : [parts.home]), parts.id].join("\t");
  return {
    key,
    kind,
    state,
    topic: parts.topic,
    home: parts.home,
    label: parts.label,
    sig,
  };
}

/** The no-topic flag of a read card: the aggregator owes it a topic (NT). */
function noTopic(found: Card): Card[] {
  return found.topic === null ? [{ ...found, key: `${found.key}\tNT`, state: "NT", sig: "" }] : [];
}

// ---------------------------------------------------------------- decisions

const ANSWER_SENDING = new Set(["waiting", "sending", "retrying"]);
const ANSWER_FAILED = new Set(["failed", "undelivered", "unknown"]);

/** The board's latest answer to a decision, if it sent one for this question. */
function answerOf(context: LifecycleContext, hold: HoldView): WriteLine | undefined {
  const sha = context.questions.get(`${hold.home}\t${hold.task}`);
  const own = context.writes.filter(
    (write) =>
      write.kind === "answer" &&
      write.home === hold.home &&
      write.task === hold.task &&
      write.question_sha256 === sha,
  );
  return own.at(-1);
}

/**
 * Whether a good read of the answer's home began after the answer reached
 * its state: only such a read can say the decision is still open once
 * answered. A read in flight when the answer arrived may predate it.
 */
function readSince(context: LifecycleContext, write: WriteLine): boolean {
  if (write.settledAt === null) return true;
  const from = context.readFrom.get(write.home);
  return from !== undefined && from > write.settledAt;
}

/**
 * A blocker the board can see: an open card of the same home that does not,
 * by following its own blockers, come back to where it started.
 */
export function visibleWait(
  view: BoardView,
  home: string,
  ids: readonly string[],
  seen: ReadonlySet<string> = new Set(),
): boolean {
  return ids.every((id) => {
    if (seen.has(id)) return false;
    const queued = view.queued.find((item) => item.home === home && item.task === id);
    if (queued !== undefined)
      return visibleWait(view, home, queued.blockers, new Set([...seen, id]));
    const hold = view.holds.find((entry) => entry.home === home && entry.task === id);
    if (hold !== undefined) return visibleWait(view, home, hold.blockers, new Set([...seen, id]));
    return view.agents.some((agent) => agent.home === home && agent.task === id && !agent.finished);
  });
}

/** A kind of card's rules in order: the first whose test holds names the state. */
type Rules<F> = readonly (readonly [CardState, (facts: F) => boolean])[];

function firstState<F>(rules: Rules<F>, facts: F, fallback: CardState): CardState {
  const found = rules.find(([, holds]) => holds(facts));
  return found === undefined ? fallback : found[0];
}

/** The state `table` names for `word`, or `fallback` for a word it does not name. */
function stateFor<W extends string, S extends CardState>(
  table: ReadonlyMap<string, S>,
  word: W,
  fallback: S,
): S {
  const found = table.get(word);
  return found === undefined ? fallback : found;
}

/** Groups `items` by `keyOf`, keeping each group's order. */
function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return groups;
}

interface HoldFacts {
  hold: HoldView;
  /** The state of the board's own answer to it, if it sent one. */
  sent: string | null;
  /** Whether a good read began after that answer reached its state. */
  readSince: boolean;
  visible: () => boolean;
}

/** An answer still going, or one delivered that no read since could check: the board's to finish. */
function answerGoing(facts: HoldFacts): boolean {
  if (facts.sent === null) return false;
  return ANSWER_SENDING.has(facts.sent) || (facts.sent === "delivered" && !facts.readSince);
}

const HOLD_RULES: Rules<HoldFacts> = [
  ["D10", ({ hold }) => hold.stale],
  ["D6", answerGoing],
  ["D7", ({ sent }) => sent !== null && ANSWER_FAILED.has(sent)],
  ["D8", ({ sent }) => sent === "delivered"],
  ["D9", ({ hold }) => hold.bucket === "unknown"],
  ["D4", ({ hold, visible }) => hold.bucket === "blocked" && visible()],
  ["D5", ({ hold }) => hold.bucket === "blocked"],
  ["D3", ({ hold }) => !hold.live],
  ["D2", ({ hold }) => hold.waits_turn],
];

/** A decision's state, first match wins (spec/lifecycle.markdown, 待決事項). */
function holdState(view: BoardView, context: LifecycleContext, hold: HoldView): CardState {
  const visible = (): boolean => visibleWait(view, hold.home, hold.blockers, new Set([hold.task]));
  const answer = answerOf(context, hold);
  const sent = answer === undefined ? null : answer.state;
  const since = answer !== undefined && readSince(context, answer);
  return firstState(HOLD_RULES, { hold, sent, readSince: since, visible }, "D1");
}

function holdCards(view: BoardView, context: LifecycleContext): Card[] {
  return view.holds.map((hold) =>
    card(
      "hold",
      { home: hold.home, id: hold.task, topic: hold.topic, label: `${hold.home}/${hold.task}` },
      holdState(view, context, hold),
    ),
  );
}

// ---------------------------------------------------------------- queued items

/** A queued item's state, first match wins (spec/lifecycle.markdown, 排隊中的項目). */
interface QueuedFacts {
  item: QueuedView;
  topic: TopicView | undefined;
  stale: boolean;
  visible: () => boolean;
  nowMs: number;
}

/** Whether a dated wait still explains the item: until one day past its date. */
function datedWait(item: QueuedView, nowMs: number): boolean {
  if (item.hold_until === null) return false;
  return nowMs < Date.parse(item.hold_until) + DATE_GRACE_MINUTES * 60_000;
}

const QUEUED_RULES: Rules<QueuedFacts> = [
  ["Q10", ({ stale }) => stale],
  ["Q9", ({ item }) => item.unreadable !== null],
  ["Q2", ({ item }) => item.captain],
  ["Q4", ({ topic }) => topic?.status === "archived"],
  ["Q3", ({ topic }) => topic?.queue === "later"],
  ["Q7", ({ item, visible }) => item.blockers.length > 0 && visible()],
  ["Q8", ({ item }) => item.blockers.length > 0],
  ["Q6", ({ item, nowMs }) => datedWait(item, nowMs)],
  ["Q1", ({ item }) => item.turn],
  ["Q5", ({ item }) => item.held],
];

function queuedState(view: BoardView, item: QueuedView, stale: boolean, nowMs: number): CardState {
  const topic = item.topic === null ? undefined : view.topics[item.topic];
  const visible = (): boolean => visibleWait(view, item.home, item.blockers, new Set([item.task]));
  return firstState(QUEUED_RULES, { item, topic, stale, visible, nowMs }, "Q1");
}

function queuedCards(view: BoardView, context: LifecycleContext): Card[] {
  return view.queued.flatMap((item) => {
    const stale = !context.fresh.has(item.home);
    const parts = {
      home: item.home,
      id: item.task,
      topic: item.topic,
      label: `${item.home}/${item.task}`,
    };
    const found = card("queued", parts, queuedState(view, item, stale, context.nowMs));
    return [found, ...(stale ? [] : noTopic(found))];
  });
}

// ---------------------------------------------------------------- agents

const AGENT_STATES = new Map<string, CardState>([
  ["working", "A1"],
  ["parked", "A2"],
  ["paused", "A2"],
  ["blocked", "A4"],
  ["failed", "A4"],
  ["done", "A5"],
]);

/** An agent's state, first match wins (spec/lifecycle.markdown, agent). */
function agentState(agent: AgentView, deciding: boolean): CardState {
  if (agent.finished) return "A9";
  if (agent.stale) return "A8";
  if (deciding) return "A7";
  if (agent.unstarted) return "A3";
  return stateFor(AGENT_STATES, agent.state, "A6");
}

function agentCards(view: BoardView): Card[] {
  const deciding = new Set(
    view.holds.filter((hold) => hold.live).map((hold) => `${hold.home}\t${hold.task}`),
  );
  return view.agents.flatMap((agent) => {
    const state = agentState(agent, deciding.has(`${agent.home}\t${agent.task}`));
    const sig = JSON.stringify([agent.state, agent.detail, agent.updated_at]);
    const parts = {
      home: agent.home,
      id: agent.task,
      topic: agent.topic,
      label: `${agent.home}/${agent.task}`,
    };
    const found = card("agent", parts, state, sig);
    const open = state !== "A9" && state !== "A8";
    return [found, ...(open ? noTopic(found) : [])];
  });
}

function questionCards(view: BoardView, context: LifecycleContext): Card[] {
  return view.questions.flatMap((question) =>
    context.fresh.has(question.home)
      ? [
          card(
            "question",
            {
              home: question.home,
              id: `${question.task}\t${question.key}`,
              topic: question.topic,
              label: `${question.home}/${question.task}`,
            },
            "W1",
          ),
        ]
      : [],
  );
}

// ---------------------------------------------------------------- stored cards

/** The states of a hands-on item. */
export type TodoCardState = "O1" | "O2" | "O3" | "O4" | "O6";

const TODO_STATES = new Map<string, TodoCardState>([
  ["open", "O1"],
  ["rejected", "O2"],
  ["claimed", "O3"],
  ["obsolete", "O4"],
]);

function todoCards(view: BoardView): Card[] {
  return view.todos.map((todo: TodoView) =>
    card(
      "todo",
      { home: null, id: todo.task, topic: todo.topic, label: todo.title },
      todoState(todo),
    ),
  );
}

/** A schedule's state, first match wins (spec/lifecycle.markdown, 排程). */
function scheduleState(context: LifecycleContext, line: ScheduleLine): CardState {
  if (context.allPaused) return "S5";
  if (line.waitsEnable) return "S4";
  if (line.state === "paused") return line.pausedByAggregator ? "S3" : "S2";
  return line.unanswered >= context.store.settings.S6.remind ? "S6" : "S1";
}

function scheduleCards(view: BoardView, context: LifecycleContext): Card[] {
  return context.schedules.flatMap((line) => {
    if (view.topics[line.topic]?.status === "archived") return [];
    const state = scheduleState(context, line);
    const parts = { home: null, id: line.id, topic: line.topic, label: line.title };
    return [card("schedule", parts, state, String(line.unanswered))];
  });
}

const UNSENT = new Set(["waiting", "sending", "retrying", "failed", "undelivered", "unknown"]);

/** Every topic with an open card under it (spec/lifecycle.markdown, 開著的工作). */
function busyTopics(view: BoardView, context: LifecycleContext): Set<string> {
  const under = [
    ...view.agents.filter((agent) => !agent.finished),
    ...view.queued,
    ...view.holds,
    ...view.questions,
    ...view.todos,
    ...context.schedules,
    ...context.writes.filter((write) => UNSENT.has(write.state)),
  ];
  return new Set(under.flatMap((entry) => (entry.topic === null ? [] : [entry.topic])));
}

/** Whether a topic with nothing open had work, at its last good read, in a home not read well since. */
function unclear(context: LifecycleContext, id: string): boolean {
  // Before the root home's first good read, the board knows no work at all.
  if (!context.fresh.has(MAIN_HOME)) return true;
  const homes = context.store.homes[id];
  return homes !== undefined && homes.some((home) => !context.fresh.has(home));
}

/** A topic's state, first match wins (spec/lifecycle.markdown, 議題). */
interface TopicFacts {
  topic: TopicView | undefined;
  scheduled: boolean;
  kept: boolean;
  busy: boolean;
  unclear: () => boolean;
}

const TOPIC_RULES: Rules<TopicFacts> = [
  ["T8", ({ topic }) => topic === undefined || topic.status === "archived"],
  ["T10", ({ topic }) => topic?.queue === null],
  ["T3", ({ topic }) => topic?.close_reason !== null],
  ["T7", ({ topic, scheduled }) => topic?.queue === "later" && scheduled],
  ["T6", ({ topic }) => topic?.queue === "later"],
  ["T4", ({ kept }) => kept],
  ["T1", ({ busy }) => busy],
  ["T5", (facts) => facts.unclear()],
];

function topicState(
  view: BoardView,
  context: LifecycleContext,
  id: string,
  busy: boolean,
): CardState {
  const facts: TopicFacts = {
    topic: view.topics[id],
    scheduled: context.schedules.some((line) => line.topic === id),
    kept:
      Object.hasOwn(context.store.kept, id) &&
      Date.parse(context.store.kept[id] as string) > context.nowMs,
    busy,
    unclear: () => unclear(context, id),
  };
  return firstState(TOPIC_RULES, facts, "T2");
}

function topicCards(view: BoardView, context: LifecycleContext): Card[] {
  const busy = busyTopics(view, context);
  return Object.entries(view.topics).flatMap(([id, topic]) =>
    topic.status === "archived"
      ? []
      : [
          card(
            "topic",
            { home: null, id, topic: id, label: topic.name },
            topicState(view, context, id, busy.has(id)),
          ),
        ],
  );
}

/** The state of every card the board knows. */
export function cardsOf(view: BoardView, context: LifecycleContext): Card[] {
  return [
    ...topicCards(view, context),
    ...holdCards(view, context),
    ...queuedCards(view, context),
    ...agentCards(view),
    ...questionCards(view, context),
    ...todoCards(view),
    ...scheduleCards(view, context),
  ];
}

// ---------------------------------------------------------------- clocks

export function isTimed(state: CardState): state is TimedState {
  return (TIMED_STATES as readonly string[]).includes(state);
}

/**
 * The clocks after this look: a card in a timed state keeps its clock while
 * its state and sig stay the same, and gets a new one from now otherwise. A
 * clock whose card is gone stops only when a good read of the card's home
 * says it is gone (or the home is gone); a stored card's stops at once.
 */
export function nextClocks(
  previous: Frozen<Record<string, Clock>>,
  cards: readonly Card[],
  context: Pick<LifecycleContext, "fresh" | "present" | "nowMs">,
): Record<string, Clock> {
  const now = new Date(context.nowMs).toISOString();
  const clocks: Record<string, Clock> = {};
  for (const found of cards) {
    if (!isTimed(found.state)) continue;
    const old = previous[found.key];
    const same = old !== undefined && old.state === found.state && old.sig === found.sig;
    clocks[found.key] = same ? { ...old } : { state: found.state, since: now, sig: found.sig };
  }
  return { ...carriedClocks(previous, cards, context), ...clocks };
}

/** The clocks that outlast a look that cannot see their card: it is 看不清 now, or its home was not read well. */
function carriedClocks(
  previous: Frozen<Record<string, Clock>>,
  cards: readonly Card[],
  context: Pick<LifecycleContext, "fresh" | "present">,
): Record<string, Clock> {
  const unseen = new Set(
    cards.filter((found) => UNCLEAR.has(found.state)).map((found) => found.key),
  );
  return Object.fromEntries(
    Object.entries(previous)
      .filter(([key]) => unseen.has(key) || unreadHome(homeOfKey(key), context))
      .map(([key, clock]) => [key, { ...clock }]),
  );
}

/** The states that say the board cannot see now: a card in one keeps its clock as it was. */
const UNCLEAR = new Set<CardState>(["T5", "D10", "Q10", "A8"]);

/** A home the board reads whose last read was not good: what it showed before still stands. */
function unreadHome(
  home: string | null,
  context: Pick<LifecycleContext, "fresh" | "present">,
): boolean {
  return home !== null && context.present.has(home) && !context.fresh.has(home);
}

const READ_KINDS = new Set<string>(["hold", "queued", "agent", "question"]);

/** The home a card key names, or null for a card the board stores. */
export function homeOfKey(key: string): string | null {
  const [kind, home] = key.split("\t") as [string, string | undefined];
  return READ_KINDS.has(kind) && home !== undefined ? home : null;
}

/**
 * Whether a timed card is past its reminder (`remind`) or its escalation
 * (`raise`) deadline, by the captain's settings: time since its clock
 * started, or for S6 the run of occurrences nobody took (its sig).
 */
export function pastDeadline(
  clock: Frozen<Clock>,
  settings: Frozen<LifecycleSettings>,
  nowMs: number,
  which: "remind" | "raise",
): boolean {
  const limit = settings[clock.state][which];
  if (clock.state === "S6") return Number(clock.sig) >= limit;
  return nowMs - Date.parse(clock.since) >= limit * 60_000;
}

/** Whether a timed card is past its escalation deadline. */
export function overdue(
  clock: Frozen<Clock>,
  settings: Frozen<LifecycleSettings>,
  nowMs: number,
): boolean {
  return pastDeadline(clock, settings, nowMs, "raise");
}

/**
 * Where an overdue card goes (spec/lifecycle.markdown section 2.13): a topic
 * with no work becomes the board's 沒人處理的議題 card, a decision waiting on
 * work the board cannot see goes into the queue itself, and every other card,
 * a claimed hands-on item never checked too, joins its topic's 沒人接 card.
 * The board never proposes closing anything, nor closes an item.
 */
export function destinationOf(state: TimedState): "idle" | "queue" | "stall" {
  if (state === "T2") return "idle";
  return state === "D5" ? "queue" : "stall";
}

// ---------------------------------------------------------------- one look at the board

/** One member line of a 沒人接 card: a card, with every overdue state it is in (X6). */
export interface StallMember {
  key: string;
  kind: CardKind;
  home: string | null;
  /** The task, item or schedule id. */
  id: string;
  label: string;
  states: TimedState[];
  since: string;
}

/** A 沒人處理的議題 card as the page shows it: the board's fact, with its one fixed sentence. */
export interface IdleView {
  topic: string;
  since: string;
  text: string;
}

/** A 沒人接 card as the page shows it. */
export interface StallView {
  key: string;
  topic: string | null;
  state: "N2" | "N3" | "N4";
  since: string;
  deferred_until: string | null;
  /** When the captain asked the aggregator to handle it, or null: then it may still ask, once. */
  asked_at: string | null;
  members: StallMember[];
}

/** What one look at the board found, and what the board should save and do. */
export interface Evaluation {
  cards: Card[];
  memory: LifecycleMemory;
  /** The board's own transitions this look made: stall.raised and stall.settled. */
  records: Draft[];
  /** The 沒人處理的議題 cards: topics with no work past their deadline. */
  idle: IdleView[];
  /** Keys of decisions waiting on work the board cannot see, now in the queue (D5). */
  queued: Set<string>;
  stalls: StallView[];
  /** The reminder to hand the aggregator once this look is saved, or null. */
  nudge: Nudge | null;
}

/** The topics each good read showed work under; a home not read well keeps what it had. */
export function nextHomes(
  previous: Frozen<Record<string, string[]>>,
  cards: readonly Card[],
  context: Pick<LifecycleContext, "fresh" | "present">,
): Record<string, string[]> {
  const kept = Object.entries(previous).flatMap(([topic, homes]) =>
    homes.filter((home) => unreadHome(home, context)).map((home) => [topic, home] as const),
  );
  const seen = cards
    .filter((found) => openHere(found, context.fresh))
    .map((found) => [found.topic as string, found.home as string] as const);
  const groups = groupBy([...kept, ...seen], ([topic]) => topic);
  return Object.fromEntries(
    [...groups].map(([topic, pairs]) => [
      topic,
      [...new Set(pairs.map(([, home]) => home))].toSorted(),
    ]),
  );
}

/** An open read card under a topic, from a home read well just now. */
function openHere(found: Card, fresh: ReadonlySet<string>): boolean {
  if (found.home === null || found.topic === null) return false;
  return fresh.has(found.home) && found.state !== "A9";
}

/** The 沒人處理的議題 card's sentence (spec/lifecycle.markdown): a fact, not a proposal. */
export function idleText(settings: Frozen<LifecycleSettings>, label: string): string {
  return `這個議題 ${durationWords(settings.T2.raise)}沒有任何工作，${label} 也沒處理`;
}

function baseKey(key: string): string {
  return key.endsWith("\tNT") ? key.slice(0, -3) : key;
}

function idOfKey(found: Card): string {
  const parts = baseKey(found.key).split("\t");
  return parts.slice(found.home === null ? 1 : 2).join("\t");
}

/** A member whose home's last read could not show it: named from its key, which is a read card's. */
function unreadCard(key: string, clock: Frozen<Clock>): Card {
  const [kind, home, task] = baseKey(key).split("\t") as [CardKind, string, string];
  return { key, kind, state: clock.state, topic: null, home, label: `${home}/${task}`, sig: "" };
}

/** The member lines of a 沒人接 card: one per card, its overdue states together, from its earliest (X6). */
function memberLines(
  keys: readonly string[],
  cards: ReadonlyMap<string, Card>,
  clocks: Frozen<Record<string, Clock>>,
): StallMember[] {
  const counted = keys.flatMap((key) => {
    const clock = clocks[key];
    return clock === undefined ? [] : [{ key, clock }];
  });
  return [...groupBy(counted, ({ key }) => baseKey(key))].map(([base, list]) => {
    const [first] = list as [{ key: string; clock: Frozen<Clock> }];
    const found = cards.has(first.key)
      ? (cards.get(first.key) as Card)
      : unreadCard(first.key, first.clock);
    return {
      key: base,
      kind: found.kind,
      home: found.home,
      id: idOfKey(found),
      label: found.label,
      states: list.map(({ clock }) => clock.state),
      since: list.map(({ clock }) => clock.since).toSorted()[0] as string,
    };
  });
}

/**
 * One look at the board: every card's state, the clocks of the timed ones,
 * and what is overdue. A read card escalates only while its home's last read
 * is good, or once it already did; a stored card escalates on time alone.
 */
export function evaluate(view: BoardView, context: LifecycleContext): Evaluation {
  const { store, nowMs } = context;
  const cards = cardsOf(view, context);
  const clocks = nextClocks(store.clocks, cards, context);
  const raised = overdueCards(cards, clocks, context);
  const nameOf = (key: string): string => {
    const topic = view.topics[key];
    return topic === undefined ? key : topic.name;
  };
  const step = stallStep(store.stalls, raised.members, nameOf, nowMs);
  const idle = idleStep(store.idle, raised.idle, nameOf, nowMs);
  const reminded = remindedNow(cards, clocks, context);
  for (const found of reminded)
    clocks[found.key] = { ...(clocks[found.key] as Clock), reminded: true };
  const text = idleText(store.settings, context.label);
  const byKey = new Map(cards.map((found) => [found.key, found]));
  return {
    cards,
    memory: {
      clocks,
      homes: nextHomes(store.homes, cards, context),
      stalls: step.stalls,
      idle: idle.idle,
    },
    records: [...step.records, ...idle.records],
    queued: raised.queued,
    idle: Object.entries(idle.idle).map(([topic, since]) => ({ topic, since, text })),
    stalls: Object.entries(step.stalls).map(([key, stall]) => ({
      key,
      topic: key === NO_TOPIC ? null : key,
      state: stallState(stall, nowMs, store.settings.N3.raise),
      since: stall.since,
      deferred_until: stall.deferred === undefined ? null : stall.deferred.until,
      asked_at: stall.asked === undefined ? null : stall.asked.at,
      members: memberLines(stall.members, byKey, clocks),
    })),
    nudge: nudgeOf(nudgeLines(reminded, clocks), store.settings, nameOf),
  };
}

/**
 * The cards this look reminds the aggregator of: past the reminder deadline,
 * not yet past the escalation one (those go to the captain instead), not
 * reminded since their clock started, and, for a read card, of a home read well.
 */
function remindedNow(
  cards: readonly Card[],
  clocks: Frozen<Record<string, Clock>>,
  context: LifecycleContext,
): Card[] {
  const { settings } = context.store;
  return cards.filter((found) => {
    const clock = isTimed(found.state) ? clocks[found.key] : undefined;
    if (clock === undefined || clock.reminded === true) return false;
    const due = pastDeadline(clock, settings, context.nowMs, "remind");
    if (!due || overdue(clock, settings, context.nowMs)) return false;
    return found.home === null || context.fresh.has(found.home);
  });
}

/** The reminded cards as the reminder names them: one line a card, its late states together (X6). */
function nudgeLines(cards: readonly Card[], clocks: Frozen<Record<string, Clock>>): NudgeLine[] {
  return [...groupBy(cards, (found) => baseKey(found.key))].map(([key, list]) => {
    const [first] = list as [Card];
    return {
      key,
      topic: first.topic,
      label: cardName({ kind: first.kind, id: idOfKey(first), label: first.label }),
      reasons: list.map((found) => ({
        state: found.state as TimedState,
        since: (clocks[found.key] as Clock).since,
      })),
    };
  });
}

/** Where this look sends the overdue cards: 沒人接 members by stall key, topics with no work, decisions. */
interface Raised {
  members: Map<string, string[]>;
  idle: string[];
  queued: Set<string>;
}

function overdueCards(
  cards: readonly Card[],
  clocks: Frozen<Record<string, Clock>>,
  context: LifecycleContext,
): Raised {
  const { stalls } = context.store;
  const already = new Set(Object.values(stalls).flatMap((stall) => stall.members));
  const late = cards.filter((found) => escalates(found, clocks, context, already));
  const going = (where: ReturnType<typeof destinationOf>): Card[] =>
    late.filter((found) => destinationOf(found.state as TimedState) === where);
  const pairs = going("stall").map((found): readonly [string, string] => [
    stallKeyOf(found.topic),
    found.key,
  ]);
  // A member whose home has not been read well since stays one: only a good read can say it left (L5).
  const raisedKeys = new Set(pairs.map(([, key]) => key));
  for (const [stallKey, stall] of Object.entries(stalls))
    for (const key of stall.members)
      if (!raisedKeys.has(key) && clocks[key] !== undefined && unreadHome(homeOfKey(key), context))
        pairs.push([stallKey, key]);
  const groups = groupBy(pairs, ([stallKey]) => stallKey);
  return {
    members: new Map([...groups].map(([stallKey, list]) => [stallKey, list.map(([, key]) => key)])),
    idle: going("idle").map(idOfKey),
    queued: new Set(going("queue").map((found) => found.key)),
  };
}

/** Whether a card is past its escalation deadline and its home's last read was good (or it already escalated). */
function escalates(
  found: Card,
  clocks: Frozen<Record<string, Clock>>,
  context: LifecycleContext,
  already: ReadonlySet<string>,
): boolean {
  if (!isTimed(found.state)) return false;
  if (!overdue(clocks[found.key] as Clock, context.store.settings, context.nowMs)) return false;
  return found.home === null || context.fresh.has(found.home) || already.has(found.key);
}

/** A board record as the lifecycle reads it: which schedule's pause, and who made it. */
export interface PauseRecord {
  kind: string;
  topic?: string | null;
  by?: string;
}

/** Occurrences in a row, from the newest, that nobody took or that timed out; a missed one does not break the run. */
function unansweredRun(entries: readonly { outcome: string }[]): number {
  let count = 0;
  for (const entry of entries.toReversed()) {
    if (entry.outcome === "missed") continue;
    if (entry.outcome !== "untaken" && entry.outcome !== "timed_out") break;
    count += 1;
  }
  return count;
}

/** Whether each topic's schedule was last paused by the aggregator, from its pause records. */
function lastPausedBy(
  topicOf: (id: string) => string,
  records: readonly PauseRecord[],
): Map<string, boolean> {
  const pausedBy = new Map<string, boolean>();
  // Only a paused schedule asks, and its last pause record says who paused it.
  for (const record of records)
    if (record.kind === "schedule.paused" && typeof record.topic === "string")
      pausedBy.set(topicOf(record.topic), record.by === "aggregator");
  return pausedBy;
}

/** Every schedule as the lifecycle reads it, with who paused it last from its records. */
export function scheduleLines(
  store: Frozen<ScheduleStore>,
  topicOf: (id: string) => string,
  records: readonly PauseRecord[],
): ScheduleLine[] {
  const pausedBy = lastPausedBy(topicOf, records);
  const open = new Set(Object.values(store.occurrences).map((occurrence) => occurrence.series));
  return Object.entries(store.series).map(([id, series]) => {
    const topic = topicOf(series.topic);
    const recent = Object.hasOwn(store.recent, id) ? store.recent[id] : undefined;
    return {
      id,
      topic,
      title: series.title,
      state: series.state,
      pausedByAggregator: pausedBy.get(topic) === true,
      waitsEnable: store.settings.aggregator_needs_enable && isNew(series),
      unanswered: recent === undefined ? 0 : unansweredRun(recent),
      open: open.has(id),
    };
  });
}

// ---------------------------------------------------------------- the stored cards' transitions

/** A hands-on item's state: a claim stays O3, owned by the aggregator, past its deadline too. */
export function todoState(item: { state: string }): TodoCardState {
  return stateFor(TODO_STATES, item.state, "O6");
}

const TODO_ANY: readonly TodoCardState[] = ["O1", "O2", "O3", "O4", "O6"];

/**
 * The states each operation on a hands-on item may start from
 * (spec/lifecycle.markdown, 要你動手); from any other it is refused and
 * changes nothing. 做完了 again on a claim changes nothing.
 */
export const TODO_TRANSITIONS: Readonly<Record<string, readonly TodoCardState[]>> = {
  "todo-add": TODO_ANY,
  "todo-claim": ["O1", "O2", "O3"],
  "todo-failed": ["O1", "O3"],
  "todo-done": TODO_ANY,
  "todo-obsolete": TODO_ANY,
  "todo-drop": ["O1", "O2", "O6"],
  "todo-takedown": ["O4"],
};

const TODO_WORDS: Record<TodoCardState, string> = {
  O1: "還沒做",
  O2: "驗證沒過",
  O3: "等驗證",
  O4: "不再需要，等你撤下",
  O6: "狀態不明",
};

/** Why `op` may not run on an item in `state`, naming what may; null when it may. */
export function todoTransitionProblem(op: string, id: string, state: TodoCardState): string | null {
  const from = TODO_TRANSITIONS[op];
  if (from === undefined || from.includes(state)) return null;
  const may = Object.entries(TODO_TRANSITIONS)
    .filter(([name, starts]) => name !== "todo-add" && starts.includes(state))
    .map(([name]) => name);
  return `${id} 現在是「${TODO_WORDS[state]}」，不能 ${op}；現在能做的：${may.join("、")}。`;
}

// ---------------------------------------------------------------- the captain's changes

/** The store with the captain's new deadline settings. */
export function withSettings(
  store: Frozen<LifecycleStore>,
  settings: LifecycleSettings,
): LifecycleStore {
  return { ...(structuredClone(store) as LifecycleStore), settings };
}

/** The store with one 沒人接 card replaced (the captain's 延到). */
export function withStall(
  store: Frozen<LifecycleStore>,
  key: string,
  stall: Stall,
): LifecycleStore {
  const copy = structuredClone(store) as LifecycleStore;
  return { ...copy, stalls: { ...copy.stalls, [key]: stall } };
}

/** The store with a topic kept until `until` (先不關), and its 沒人處理的議題 card gone. */
export function withKept(
  store: Frozen<LifecycleStore>,
  topic: string,
  until: string,
): LifecycleStore {
  const copy = structuredClone(store) as LifecycleStore;
  const idle = Object.fromEntries(Object.entries(copy.idle).filter(([id]) => id !== topic));
  return { ...copy, kept: { ...copy.kept, [topic]: until }, idle };
}
