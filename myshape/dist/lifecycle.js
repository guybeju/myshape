// Every card's lifecycle (spec/lifecycle.markdown): the closed set of states
// of each kind of card, who owns each state and its deadline (LIFECYCLE), the
// state of every card the board knows, derived from what it shows, and the
// clocks that time the states the aggregator owns. Pure: board-server.ts
// commits what evaluate returns.
import { DATE_GRACE_MINUTES, TIMED_STATES, defaultSettings, durationWords, } from "./lifecycle-settings.js";
import { MAIN_HOME } from "./journal.js";
import { isNew } from "./schedules.js";
import { NO_TOPIC, cardName, idleStep, nudgeOf, stallKeyOf, stallState, stallStep, } from "./stalls.js";
const captain = { owner: "captain", deadline: null };
const board = { owner: "board", deadline: null };
const time = { owner: "time", deadline: null };
const end = { owner: "none", deadline: null };
const timed = (state) => ({ owner: "aggregator", deadline: state });
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
};
export function emptyLifecycle() {
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
function card(kind, parts, state, sig = "") {
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
function noTopic(found) {
    return found.topic === null ? [{ ...found, key: `${found.key}\tNT`, state: "NT", sig: "" }] : [];
}
// ---------------------------------------------------------------- decisions
const ANSWER_SENDING = new Set(["waiting", "sending", "retrying"]);
const ANSWER_FAILED = new Set(["failed", "undelivered", "unknown"]);
/** The board's latest answer to a decision, if it sent one for this question. */
function answerOf(context, hold) {
    const sha = context.questions.get(`${hold.home}\t${hold.task}`);
    const own = context.writes.filter((write) => write.kind === "answer" &&
        write.home === hold.home &&
        write.task === hold.task &&
        write.question_sha256 === sha);
    return own.at(-1);
}
/**
 * Whether a good read of the answer's home began after the answer reached
 * its state: only such a read can say the decision is still open once
 * answered. A read in flight when the answer arrived may predate it.
 */
function readSince(context, write) {
    if (write.settledAt === null)
        return true;
    const from = context.readFrom.get(write.home);
    return from !== undefined && from > write.settledAt;
}
/**
 * A blocker the board can see: an open card of the same home that does not,
 * by following its own blockers, come back to where it started.
 */
export function visibleWait(view, home, ids, seen = new Set()) {
    return ids.every((id) => {
        if (seen.has(id))
            return false;
        const queued = view.queued.find((item) => item.home === home && item.task === id);
        if (queued !== undefined)
            return visibleWait(view, home, queued.blockers, new Set([...seen, id]));
        const hold = view.holds.find((entry) => entry.home === home && entry.task === id);
        if (hold !== undefined)
            return visibleWait(view, home, hold.blockers, new Set([...seen, id]));
        return view.agents.some((agent) => agent.home === home && agent.task === id && !agent.finished);
    });
}
function firstState(rules, facts, fallback) {
    const found = rules.find(([, holds]) => holds(facts));
    return found === undefined ? fallback : found[0];
}
/** The state `table` names for `word`, or `fallback` for a word it does not name. */
function stateFor(table, word, fallback) {
    const found = table.get(word);
    return found === undefined ? fallback : found;
}
/** Groups `items` by `keyOf`, keeping each group's order. */
function groupBy(items, keyOf) {
    const groups = new Map();
    for (const item of items) {
        const key = keyOf(item);
        const group = groups.get(key);
        if (group === undefined)
            groups.set(key, [item]);
        else
            group.push(item);
    }
    return groups;
}
/** An answer still going, or one delivered that no read since could check: the board's to finish. */
function answerGoing(facts) {
    if (facts.sent === null)
        return false;
    return ANSWER_SENDING.has(facts.sent) || (facts.sent === "delivered" && !facts.readSince);
}
const HOLD_RULES = [
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
function holdState(view, context, hold) {
    const visible = () => visibleWait(view, hold.home, hold.blockers, new Set([hold.task]));
    const answer = answerOf(context, hold);
    const sent = answer === undefined ? null : answer.state;
    const since = answer !== undefined && readSince(context, answer);
    return firstState(HOLD_RULES, { hold, sent, readSince: since, visible }, "D1");
}
function holdCards(view, context) {
    return view.holds.map((hold) => card("hold", { home: hold.home, id: hold.task, topic: hold.topic, label: `${hold.home}/${hold.task}` }, holdState(view, context, hold)));
}
/** Whether a dated wait still explains the item: until one day past its date. */
function datedWait(item, nowMs) {
    if (item.hold_until === null)
        return false;
    return nowMs < Date.parse(item.hold_until) + DATE_GRACE_MINUTES * 60_000;
}
const QUEUED_RULES = [
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
function queuedState(view, item, stale, nowMs) {
    const topic = item.topic === null ? undefined : view.topics[item.topic];
    const visible = () => visibleWait(view, item.home, item.blockers, new Set([item.task]));
    return firstState(QUEUED_RULES, { item, topic, stale, visible, nowMs }, "Q1");
}
function queuedCards(view, context) {
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
const AGENT_STATES = new Map([
    ["working", "A1"],
    ["parked", "A2"],
    ["paused", "A2"],
    ["blocked", "A4"],
    ["failed", "A4"],
    ["done", "A5"],
]);
/** An agent's state, first match wins (spec/lifecycle.markdown, agent). */
function agentState(agent, deciding) {
    if (agent.finished)
        return "A9";
    if (agent.stale)
        return "A8";
    if (deciding)
        return "A7";
    if (agent.unstarted)
        return "A3";
    return stateFor(AGENT_STATES, agent.state, "A6");
}
function agentCards(view) {
    const deciding = new Set(view.holds.filter((hold) => hold.live).map((hold) => `${hold.home}\t${hold.task}`));
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
function questionCards(view, context) {
    return view.questions.flatMap((question) => context.fresh.has(question.home)
        ? [
            card("question", {
                home: question.home,
                id: `${question.task}\t${question.key}`,
                topic: question.topic,
                label: `${question.home}/${question.task}`,
            }, "W1"),
        ]
        : []);
}
const TODO_STATES = new Map([
    ["open", "O1"],
    ["rejected", "O2"],
    ["claimed", "O3"],
    ["obsolete", "O4"],
]);
function todoCards(view) {
    return view.todos.map((todo) => card("todo", { home: null, id: todo.task, topic: todo.topic, label: todo.title }, todoState(todo)));
}
/** A schedule's state, first match wins (spec/lifecycle.markdown, 排程). */
function scheduleState(context, line) {
    if (context.allPaused)
        return "S5";
    if (line.waitsEnable)
        return "S4";
    if (line.state === "paused")
        return line.pausedByAggregator ? "S3" : "S2";
    return line.unanswered >= context.store.settings.S6.remind ? "S6" : "S1";
}
function scheduleCards(view, context) {
    return context.schedules.flatMap((line) => {
        if (view.topics[line.topic]?.status === "archived")
            return [];
        const state = scheduleState(context, line);
        const parts = { home: null, id: line.id, topic: line.topic, label: line.title };
        return [card("schedule", parts, state, String(line.unanswered))];
    });
}
const UNSENT = new Set(["waiting", "sending", "retrying", "failed", "undelivered", "unknown"]);
/** Every topic with an open card under it (spec/lifecycle.markdown, 開著的工作). */
function busyTopics(view, context) {
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
function unclear(context, id) {
    // Before the root home's first good read, the board knows no work at all.
    if (!context.fresh.has(MAIN_HOME))
        return true;
    const homes = context.store.homes[id];
    return homes !== undefined && homes.some((home) => !context.fresh.has(home));
}
const TOPIC_RULES = [
    ["T8", ({ topic }) => topic === undefined || topic.status === "archived"],
    ["T10", ({ topic }) => topic?.queue === null],
    ["T3", ({ topic }) => topic?.close_reason !== null],
    ["T7", ({ topic, scheduled }) => topic?.queue === "later" && scheduled],
    ["T6", ({ topic }) => topic?.queue === "later"],
    ["T4", ({ kept }) => kept],
    ["T1", ({ busy }) => busy],
    ["T5", (facts) => facts.unclear()],
];
function topicState(view, context, id, busy) {
    const facts = {
        topic: view.topics[id],
        scheduled: context.schedules.some((line) => line.topic === id),
        kept: Object.hasOwn(context.store.kept, id) &&
            Date.parse(context.store.kept[id]) > context.nowMs,
        busy,
        unclear: () => unclear(context, id),
    };
    return firstState(TOPIC_RULES, facts, "T2");
}
function topicCards(view, context) {
    const busy = busyTopics(view, context);
    return Object.entries(view.topics).flatMap(([id, topic]) => topic.status === "archived"
        ? []
        : [
            card("topic", { home: null, id, topic: id, label: topic.name }, topicState(view, context, id, busy.has(id))),
        ]);
}
/** The state of every card the board knows. */
export function cardsOf(view, context) {
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
export function isTimed(state) {
    return TIMED_STATES.includes(state);
}
/**
 * The clocks after this look: a card in a timed state keeps its clock while
 * its state and sig stay the same, and gets a new one from now otherwise. A
 * clock whose card is gone stops only when a good read of the card's home
 * says it is gone (or the home is gone); a stored card's stops at once.
 */
export function nextClocks(previous, cards, context) {
    const now = new Date(context.nowMs).toISOString();
    const clocks = {};
    for (const found of cards) {
        if (!isTimed(found.state))
            continue;
        const old = previous[found.key];
        const same = old !== undefined && old.state === found.state && old.sig === found.sig;
        clocks[found.key] = same ? { ...old } : { state: found.state, since: now, sig: found.sig };
    }
    return { ...carriedClocks(previous, cards, context), ...clocks };
}
/** The clocks that outlast a look that cannot see their card: it is 看不清 now, or its home was not read well. */
function carriedClocks(previous, cards, context) {
    const unseen = new Set(cards.filter((found) => UNCLEAR.has(found.state)).map((found) => found.key));
    return Object.fromEntries(Object.entries(previous)
        .filter(([key]) => unseen.has(key) || unreadHome(homeOfKey(key), context))
        .map(([key, clock]) => [key, { ...clock }]));
}
/** The states that say the board cannot see now: a card in one keeps its clock as it was. */
const UNCLEAR = new Set(["T5", "D10", "Q10", "A8"]);
/** A home the board reads whose last read was not good: what it showed before still stands. */
function unreadHome(home, context) {
    return home !== null && context.present.has(home) && !context.fresh.has(home);
}
const READ_KINDS = new Set(["hold", "queued", "agent", "question"]);
/** The home a card key names, or null for a card the board stores. */
export function homeOfKey(key) {
    const [kind, home] = key.split("\t");
    return READ_KINDS.has(kind) && home !== undefined ? home : null;
}
/**
 * Whether a timed card is past its reminder (`remind`) or its escalation
 * (`raise`) deadline, by the captain's settings: time since its clock
 * started, or for S6 the run of occurrences nobody took (its sig).
 */
export function pastDeadline(clock, settings, nowMs, which) {
    const limit = settings[clock.state][which];
    if (clock.state === "S6")
        return Number(clock.sig) >= limit;
    return nowMs - Date.parse(clock.since) >= limit * 60_000;
}
/** Whether a timed card is past its escalation deadline. */
export function overdue(clock, settings, nowMs) {
    return pastDeadline(clock, settings, nowMs, "raise");
}
/**
 * Where an overdue card goes (spec/lifecycle.markdown section 2.13): a topic
 * with no work becomes the board's 沒人處理的議題 card, a decision waiting on
 * work the board cannot see goes into the queue itself, and every other card,
 * a claimed hands-on item never checked too, joins its topic's 沒人接 card.
 * The board never proposes closing anything, nor closes an item.
 */
export function destinationOf(state) {
    if (state === "T2")
        return "idle";
    return state === "D5" ? "queue" : "stall";
}
/** The topics each good read showed work under; a home not read well keeps what it had. */
export function nextHomes(previous, cards, context) {
    const kept = Object.entries(previous).flatMap(([topic, homes]) => homes.filter((home) => unreadHome(home, context)).map((home) => [topic, home]));
    const seen = cards
        .filter((found) => openHere(found, context.fresh))
        .map((found) => [found.topic, found.home]);
    const groups = groupBy([...kept, ...seen], ([topic]) => topic);
    return Object.fromEntries([...groups].map(([topic, pairs]) => [
        topic,
        [...new Set(pairs.map(([, home]) => home))].toSorted(),
    ]));
}
/** An open read card under a topic, from a home read well just now. */
function openHere(found, fresh) {
    if (found.home === null || found.topic === null)
        return false;
    return fresh.has(found.home) && found.state !== "A9";
}
/** The 沒人處理的議題 card's sentence (spec/lifecycle.markdown): a fact, not a proposal. */
export function idleText(settings, label) {
    return `這個議題 ${durationWords(settings.T2.raise)}沒有任何工作，${label} 也沒處理`;
}
function baseKey(key) {
    return key.endsWith("\tNT") ? key.slice(0, -3) : key;
}
function idOfKey(found) {
    const parts = baseKey(found.key).split("\t");
    return parts.slice(found.home === null ? 1 : 2).join("\t");
}
/** A member whose home's last read could not show it: named from its key, which is a read card's. */
function unreadCard(key, clock) {
    const [kind, home, task] = baseKey(key).split("\t");
    return { key, kind, state: clock.state, topic: null, home, label: `${home}/${task}`, sig: "" };
}
/** The member lines of a 沒人接 card: one per card, its overdue states together, from its earliest (X6). */
function memberLines(keys, cards, clocks) {
    const counted = keys.flatMap((key) => {
        const clock = clocks[key];
        return clock === undefined ? [] : [{ key, clock }];
    });
    return [...groupBy(counted, ({ key }) => baseKey(key))].map(([base, list]) => {
        const [first] = list;
        const found = cards.has(first.key)
            ? cards.get(first.key)
            : unreadCard(first.key, first.clock);
        return {
            key: base,
            kind: found.kind,
            home: found.home,
            id: idOfKey(found),
            label: found.label,
            states: list.map(({ clock }) => clock.state),
            since: list.map(({ clock }) => clock.since).toSorted()[0],
        };
    });
}
/**
 * One look at the board: every card's state, the clocks of the timed ones,
 * and what is overdue. A read card escalates only while its home's last read
 * is good, or once it already did; a stored card escalates on time alone.
 */
export function evaluate(view, context) {
    const { store, nowMs } = context;
    const cards = cardsOf(view, context);
    const clocks = nextClocks(store.clocks, cards, context);
    const raised = overdueCards(cards, clocks, context);
    const nameOf = (key) => {
        const topic = view.topics[key];
        return topic === undefined ? key : topic.name;
    };
    const step = stallStep(store.stalls, raised.members, nameOf, nowMs);
    const idle = idleStep(store.idle, raised.idle, nameOf, nowMs);
    const reminded = remindedNow(cards, clocks, context);
    for (const found of reminded)
        clocks[found.key] = { ...clocks[found.key], reminded: true };
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
function remindedNow(cards, clocks, context) {
    const { settings } = context.store;
    return cards.filter((found) => {
        const clock = isTimed(found.state) ? clocks[found.key] : undefined;
        if (clock === undefined || clock.reminded === true)
            return false;
        const due = pastDeadline(clock, settings, context.nowMs, "remind");
        if (!due || overdue(clock, settings, context.nowMs))
            return false;
        return found.home === null || context.fresh.has(found.home);
    });
}
/** The reminded cards as the reminder names them: one line a card, its late states together (X6). */
function nudgeLines(cards, clocks) {
    return [...groupBy(cards, (found) => baseKey(found.key))].map(([key, list]) => {
        const [first] = list;
        return {
            key,
            topic: first.topic,
            label: cardName({ kind: first.kind, id: idOfKey(first), label: first.label }),
            reasons: list.map((found) => ({
                state: found.state,
                since: clocks[found.key].since,
            })),
        };
    });
}
function overdueCards(cards, clocks, context) {
    const { stalls } = context.store;
    const already = new Set(Object.values(stalls).flatMap((stall) => stall.members));
    const late = cards.filter((found) => escalates(found, clocks, context, already));
    const going = (where) => late.filter((found) => destinationOf(found.state) === where);
    const pairs = going("stall").map((found) => [
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
function escalates(found, clocks, context, already) {
    if (!isTimed(found.state))
        return false;
    if (!overdue(clocks[found.key], context.store.settings, context.nowMs))
        return false;
    return found.home === null || context.fresh.has(found.home) || already.has(found.key);
}
/** Occurrences in a row, from the newest, that nobody took or that timed out; a missed one does not break the run. */
function unansweredRun(entries) {
    let count = 0;
    for (const entry of entries.toReversed()) {
        if (entry.outcome === "missed")
            continue;
        if (entry.outcome !== "untaken" && entry.outcome !== "timed_out")
            break;
        count += 1;
    }
    return count;
}
/** Whether each topic's schedule was last paused by the aggregator, from its pause records. */
function lastPausedBy(topicOf, records) {
    const pausedBy = new Map();
    // Only a paused schedule asks, and its last pause record says who paused it.
    for (const record of records)
        if (record.kind === "schedule.paused" && typeof record.topic === "string")
            pausedBy.set(topicOf(record.topic), record.by === "aggregator");
    return pausedBy;
}
/** Every schedule as the lifecycle reads it, with who paused it last from its records. */
export function scheduleLines(store, topicOf, records) {
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
export function todoState(item) {
    return stateFor(TODO_STATES, item.state, "O6");
}
const TODO_ANY = ["O1", "O2", "O3", "O4", "O6"];
/**
 * The states each operation on a hands-on item may start from
 * (spec/lifecycle.markdown, 要你動手); from any other it is refused and
 * changes nothing. 做完了 again on a claim changes nothing.
 */
export const TODO_TRANSITIONS = {
    "todo-add": TODO_ANY,
    "todo-claim": ["O1", "O2", "O3"],
    "todo-failed": ["O1", "O3"],
    "todo-done": TODO_ANY,
    "todo-obsolete": TODO_ANY,
    "todo-drop": ["O1", "O2", "O6"],
    "todo-takedown": ["O4"],
};
const TODO_WORDS = {
    O1: "還沒做",
    O2: "驗證沒過",
    O3: "等驗證",
    O4: "不再需要，等你撤下",
    O6: "狀態不明",
};
/** Why `op` may not run on an item in `state`, naming what may; null when it may. */
export function todoTransitionProblem(op, id, state) {
    const from = TODO_TRANSITIONS[op];
    if (from === undefined || from.includes(state))
        return null;
    const may = Object.entries(TODO_TRANSITIONS)
        .filter(([name, starts]) => name !== "todo-add" && starts.includes(state))
        .map(([name]) => name);
    return `${id} 現在是「${TODO_WORDS[state]}」，不能 ${op}；現在能做的：${may.join("、")}。`;
}
// ---------------------------------------------------------------- the captain's changes
/** The store with the captain's new deadline settings. */
export function withSettings(store, settings) {
    return { ...structuredClone(store), settings };
}
/** The store with one 沒人接 card replaced (the captain's 延到). */
export function withStall(store, key, stall) {
    const copy = structuredClone(store);
    return { ...copy, stalls: { ...copy.stalls, [key]: stall } };
}
/** The store with a topic kept until `until` (先不關), and its 沒人處理的議題 card gone. */
export function withKept(store, topic, until) {
    const copy = structuredClone(store);
    const idle = Object.fromEntries(Object.entries(copy.idle).filter(([id]) => id !== topic));
    return { ...copy, kept: { ...copy.kept, [topic]: until }, idle };
}
