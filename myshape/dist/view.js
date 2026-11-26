import { orNull } from "./files.js";
import { QUEUES, resolveTopicId } from "./topics.js";
import { itemTopic } from "./todos.js";
/**
 * How many ledger lines the view keeps per topic, and for lines with no topic.
 * Board records and lines derived from tags are never cut: they are the
 * topic's history, however busy the rest of the fleet is.
 */
export const LEDGER_PER_TOPIC = 500;
/** How long after a tag line its agent.tagged record may be saved and still be its record. */
const TAG_RECORD_SKEW_S = 300;
const CLOSING_KINDS = new Set(["todo.done", "todo.dropped", "todo.taken_down"]);
const DECISION_CLOSING_KINDS = new Set(["hold.answered", "hold.closed"]);
// Upstream keeps a hold reason on the backlog item's title line, so a reason
// written as several lines may reach the board as one. The marker is therefore
// accepted anywhere in the last line, not only at its start.
const OPTION_MARKER = "選項：";
/**
 * What answering `hold` does: what whoever opened it recorded, else a default
 * that cannot finish unfinished work. A decision without a record is released,
 * so an item that still gates work (a merge approval) goes back to the queue
 * instead of being marked done.
 */
export function answerOutcome(hold) {
    if (hold.on_answer !== null)
        return { on_answer: hold.on_answer, recorded: true };
    return { on_answer: "release", recorded: false };
}
/** Parses a tag file: one "<topic-id> <UTC time>" per line, oldest first. */
export function parseTags(text) {
    const tags = [];
    for (const line of text.split("\n")) {
        const [topic, time] = line.trim().split(" ");
        if (topic === undefined || topic === "")
            continue;
        const atMs = time === undefined ? Number.NaN : Date.parse(time);
        tags.push({ topic, atMs: Number.isNaN(atMs) ? 0 : atMs });
    }
    return tags;
}
/** The option buttons a hold asks for: what follows "選項：" at the end of its last line, split on " | ". */
export function parseOptions(question) {
    const lines = question.trimEnd().split("\n");
    const lastLine = lines[lines.length - 1];
    const at = lastLine.lastIndexOf(OPTION_MARKER);
    if (at === -1)
        return [];
    const options = lastLine
        .slice(at + OPTION_MARKER.length)
        .split(" | ")
        .map((option) => option.trim());
    return options.length >= 2 && options.every((option) => option !== "") ? options : [];
}
function lightFor(state) {
    switch (state) {
        case "blocked":
        case "failed":
            return "stuck";
        case "working":
        case "parked":
        case "paused":
            return "working";
        case "done":
            return "done";
        default:
            return "unknown";
    }
}
function deferredReason(hold) {
    switch (hold.hold_bucket) {
        case "live":
            return null;
        case "aged":
            return "已放超過 14 天";
        case "dated":
            return `延到 ${hold.hold_until === null ? "之後" : hold.hold_until}`;
        case "blocked":
            return `等 ${hold.unresolved_blocker_ids.join("、")} 完成`;
    }
}
function waitingFor(item) {
    if (item.captain)
        return "等你決定";
    if (item.hold !== null)
        return `停著：${item.hold}`;
    if (item.blockers.length > 0)
        return `等 ${item.blockers.join("、")} 完成`;
    return null;
}
/** Looks up topics for tasks across every home's tag files. */
class Placer {
    topics;
    tags = new Map();
    constructor(topics, homes) {
        this.topics = topics;
        for (const home of homes) {
            if (home.report === null)
                continue;
            for (const [task, text] of Object.entries(home.report.topics)) {
                this.tags.set(`${home.id}\n${task}`, parseTags(text));
            }
        }
    }
    tagsOf(home, task) {
        const tags = this.tags.get(`${home}\n${task}`);
        return tags === undefined ? [] : tags;
    }
    classify(tagged) {
        if (tagged === undefined)
            return { topic: null, reason: "no-tag" };
        const id = resolveTopicId(this.topics.doc, tagged);
        if (this.topics.archive.topics[id] !== undefined)
            return { topic: id, reason: null };
        if (this.topics.doc.topics[id] === undefined)
            return { topic: null, reason: "unknown-topic" };
        return { topic: id, reason: null };
    }
    /**
     * The topic of a queued item: its tag when it has one, else the topic its
     * body names. A handed-off item waits in the secondmate's home untagged.
     */
    queued(home, item) {
        const tags = this.tagsOf(home, item.id);
        return this.classify(tags[tags.length - 1]?.topic ?? item.topic_hint ?? undefined);
    }
    /** The topic a task belongs to now. */
    current(home, task) {
        return this.latest(this.tagsOf(home, task));
    }
    /** The topic the last of these tags names. */
    latest(tags) {
        return this.classify(tags[tags.length - 1]?.topic);
    }
    /** The topic a task belonged to at `atMs`: the last tag written by then, else its first tag. */
    at(home, task, atMs) {
        const tags = this.tagsOf(home, task);
        const written = tags.filter((tag) => tag.atMs <= atMs);
        const inEffect = written.length > 0 ? written[written.length - 1] : tags[0];
        return this.classify(inEffect?.topic);
    }
}
/** Where one task belongs right now, given what the homes last reported. */
export function placeTask(topics, homes, home, task) {
    return new Placer(topics, homes).current(home, task);
}
/** Where a task with this tag file text belongs right now ("" for a task with none). */
export function placeTagText(topics, text) {
    return new Placer(topics, []).latest(parseTags(text));
}
function homeView(home, input) {
    const age = home.lastOkAt === null ? null : input.nowMs - home.lastOkAt;
    return {
        id: home.id,
        version: home.version,
        ledger_enabled: home.report?.ledger_enabled ?? null,
        ledger_hint: home.report?.ledger_hint ?? null,
        stale: age === null || age > input.staleMs,
        last_ok_seconds_ago: age === null ? null : Math.floor(age / 1000),
        error: home.error,
    };
}
function ledgerEvents(input) {
    return input.events.filter((event) => event.src === "ledger");
}
/** The last ledger event of every (home, task). */
function lastEvents(events) {
    const last = new Map();
    for (const event of events)
        last.set(`${event.home}\n${event.task}`, event);
    return last;
}
/** Ledger events only a worker's lifecycle writes: spawn, PR registration, merge, and teardown. */
const LIFECYCLE = new Set(["task.dispatched", "task.pr_ready", "task.merged", "task.cleaned_up"]);
/**
 * The run each (home, task) is on: everything since its latest dispatch. Only
 * a (home, task) with a lifecycle event has a run; a status log that no spawn
 * or teardown ever touched, such as a remote mate's reply channel, has none.
 */
function currentRuns(events) {
    const runs = new Map();
    for (const event of events) {
        if (!LIFECYCLE.has(event.event))
            continue;
        const key = `${event.home}\n${event.task}`;
        if (event.event === "task.dispatched") {
            const kind = event.fields["kind"];
            runs.set(key, { kind: typeof kind === "string" ? kind : "", merged: false });
            continue;
        }
        const run = runs.get(key);
        const merged = event.event === "task.merged";
        runs.set(key, run === undefined ? { kind: "", merged } : { ...run, merged: run.merged || merged });
    }
    return runs;
}
/**
 * Whether a task the home no longer has was work: the ledger saw it in a
 * worker's lifecycle and its latest dispatch was not a secondmate's. A retired
 * mate's own record and a reply channel are not; neither is shown as an agent.
 */
function wasWork(run) {
    return run !== undefined && run.kind !== "secondmate";
}
const DISCARDED = { state: "discarded", detail: "已收掉，帳本裡沒有落地紀錄" };
/**
 * How a task that is gone from the snapshot ended, from its last ledger event.
 * Teardown records the same event whether the work landed or was thrown away,
 * so a ship task cleaned up with no merge in its run is not shown as done.
 */
function endedTask(event, run) {
    const base = { id: event.task, kind: run.kind, source: "", detail: "", unstarted: false };
    const cleaned = event.event === "task.cleaned_up";
    if (cleaned && run.kind === "ship" && !run.merged)
        return { task: { ...base, ...DISCARDED }, light: "unknown" };
    const light = cleaned || event.event === "task.merged" ? "done" : "unknown";
    return { task: { ...base, state: light }, light };
}
/** Builds agent entries for one home; everything that does not vary per task is bound here. */
function agentMaker(home, stale, placer, last) {
    return (task, light, finished) => {
        const placement = placer.current(home.id, task.id);
        const lastEvent = last.get(`${home.id}\n${task.id}`);
        return {
            home: home.id,
            task: task.id,
            kind: task.kind,
            light: stale ? "unknown" : light,
            state: task.state,
            detail: task.detail,
            topic: placement.topic,
            unsorted_reason: placement.reason,
            updated_at: lastEvent === undefined ? null : lastEvent.ts,
            stale,
            unstarted: task.unstarted,
            finished,
        };
    };
}
function agentsOf(home, stale, placer, last, runs) {
    const report = home.report;
    if (report === null)
        return [];
    const agent = agentMaker(home, stale, placer, last);
    const deciding = new Set(report.holds.filter((hold) => hold.hold_bucket === "live").map((hold) => hold.id));
    const running = report.tasks
        .filter((task) => task.kind !== "secondmate")
        .map((task) => agent(task, deciding.has(task.id) ? "decide" : lightFor(task.state), false));
    // A cleaned-up task is gone from the snapshot; its last ledger event says how it ended.
    const known = new Set(report.tasks.map((task) => task.id));
    const ended = [...last.values()]
        .filter((event) => event.home === home.id && !known.has(event.task))
        .flatMap((event) => {
        const run = runs.get(`${event.home}\n${event.task}`);
        if (!wasWork(run))
            return [];
        const gone = endedTask(event, run);
        return [agent(gone.task, gone.light, true)];
    });
    return [...running, ...ended];
}
/** Whether a hold is due now, and if not, why it waits. */
function holdTiming(hold) {
    return { live: hold.hold_bucket === "live", deferred_reason: deferredReason(hold) };
}
function holdsOf(home, stale, placer) {
    if (home.report === null)
        return [];
    return home.report.holds.map((hold) => {
        const outcome = answerOutcome(hold);
        const own = placer.current(home.id, hold.id);
        const placement = own.topic === null && hold.origin !== "" ? placer.current(home.id, hold.origin) : own;
        return {
            ageDays: hold.hold_age_days === null ? 0 : hold.hold_age_days,
            view: {
                home: home.id,
                task: hold.id,
                title: hold.title,
                question: hold.question,
                options: parseOptions(hold.question),
                on_answer: outcome.on_answer,
                on_answer_recorded: outcome.recorded,
                ...holdTiming(hold),
                topic: placement.topic,
                stale,
            },
        };
    });
}
/** Sort key for a hold: live first, then the topic's queue order, then oldest first. */
function holdRank(view, { view: hold, ageDays }) {
    const live = hold.live ? 0 : 1;
    const queue = hold.topic === null ? null : view.topics[hold.topic].queue;
    // A hold with no topic, or whose topic is archived, sorts after every queue.
    if (hold.topic === null || queue === null)
        return [live, QUEUES.length, QUEUES.length, -ageDays];
    return [live, QUEUES.indexOf(queue), view.queues[queue].indexOf(hold.topic), -ageDays];
}
function compareRanks(left, right) {
    for (const [index, value] of left.entries()) {
        const difference = value - right[index];
        if (difference !== 0)
            return difference;
    }
    return 0;
}
function holdOrder(view) {
    return (a, b) => compareRanks(holdRank(view, a), holdRank(view, b)) || a.view.task.localeCompare(b.view.task);
}
/**
 * The worker questions of one home. A mate's own needs-decision line is its
 * report to first mate, not a worker's question.
 */
function questionsOf(home, report, placer) {
    const mates = new Set(report.tasks.filter((task) => task.kind === "secondmate").map((task) => task.id));
    return report.status_decisions
        .filter((question) => !mates.has(question.id))
        .map((question) => ({
        home,
        task: question.id,
        key: question.key,
        summary: question.summary,
        topic: placer.current(home, question.id).topic,
    }));
}
function prOf(event) {
    const pr = event.fields["pr"];
    return typeof pr === "string" ? pr : null;
}
function ledgerText(event) {
    const text = event.fields["text"];
    const state = event.fields["state"];
    if (event.event === "task.status") {
        return `${typeof state === "string" ? `${state}：` : ""}${typeof text === "string" ? text.trim() : ""}`;
    }
    return "";
}
function boardUpdate(event, input) {
    return {
        ts: event.ts,
        source: "board",
        home: event.home,
        task: event.task,
        event: event.kind,
        text: event.text,
        pr: null,
        topic: event.topic === null ? null : resolveTopicId(input.topics.doc, event.topic),
    };
}
/** Each ledger line with the topic its task had then, the newest LEDGER_PER_TOPIC per topic. */
function ledgerUpdates(input, placer) {
    const lines = ledgerEvents(input)
        .map((event) => ({
        ts: event.ts,
        source: "ledger",
        home: event.home,
        task: event.task,
        event: event.event,
        text: ledgerText(event),
        pr: prOf(event),
        topic: placer.at(event.home, event.task, event.ts * 1000).topic,
    }))
        .toSorted((a, b) => b.ts - a.ts);
    const kept = new Map();
    return lines.filter((line) => {
        const count = kept.get(line.topic) ?? 0;
        kept.set(line.topic, count + 1);
        return count < LEDGER_PER_TOPIC;
    });
}
/**
 * The tag lines of one task that no agent.tagged record accounts for. A page
 * tag writes its line first and its record once delivered, so each record
 * takes the latest earlier line of the same topic.
 */
function unmatchedTags(tags, records) {
    const unmatched = [...tags];
    for (const record of records) {
        const limitMs = (record.ts + TAG_RECORD_SKEW_S) * 1000;
        const match = unmatched.findLastIndex((tag) => tag.topic === record.topic && tag.atMs <= limitMs);
        if (match !== -1)
            unmatched.splice(match, 1);
    }
    return unmatched;
}
/** The line a tag made by command shows, or null when its topic is not one the board knows. */
function tagLine(input, home, task, tag) {
    const topic = resolveTopicId(input.topics.doc, tag.topic);
    const name = input.topics.doc.topics[topic]?.name ?? input.topics.archive.topics[topic]?.name;
    if (name === undefined)
        return null;
    return {
        ts: Math.floor(tag.atMs / 1000),
        source: "tag",
        home,
        task,
        event: "agent.tagged",
        text: `歸到「${name}」（${input.label} 用指令）`,
        pr: null,
        topic,
    };
}
/** The tags made by command: every tag line with a time that no agent.tagged record accounts for. */
function tagUpdates(input) {
    const records = input.events.filter((event) => event.src === "board" && event.kind === "agent.tagged");
    return input.homes.flatMap((home) => Object.entries(home.report?.topics ?? {}).flatMap(([task, text]) => {
        const own = records.filter((record) => record.home === home.id && record.task === task);
        const timed = parseTags(text).filter((tag) => tag.atMs > 0);
        return unmatchedTags(timed, own).flatMap((tag) => tagLine(input, home.id, task, tag) ?? []);
    }));
}
function updatesOf(input, placer) {
    const board = input.events
        .filter((event) => event.src === "board")
        .map((event) => boardUpdate(event, input));
    return [...board, ...tagUpdates(input), ...ledgerUpdates(input, placer)].toSorted((a, b) => b.ts - a.ts);
}
/**
 * The hands-on items that closed, from their records: each closing record
 * ends one life of its item, with every record of the item since its last
 * close. An id put on the board again starts a new life.
 */
function closedTodos(input) {
    const lives = new Map();
    const closed = [];
    for (const event of input.events) {
        if (event.src !== "board" || event.item === undefined)
            continue;
        const update = boardUpdate(event, input);
        const life = [...(lives.get(event.item) ?? []), update];
        if (!CLOSING_KINDS.has(event.kind)) {
            lives.set(event.item, life);
            continue;
        }
        lives.delete(event.item);
        closed.push({
            item: event.item,
            topic: update.topic,
            ts: event.ts,
            text: event.text,
            outcome: event.outcome ?? null,
            records: life.toReversed(),
        });
    }
    return closed.toReversed();
}
function isDecisionRecord(event) {
    if (event.src !== "board" || !event.kind.startsWith("hold."))
        return false;
    return event.home !== null && event.task !== null;
}
function closedDecisionOf(life, input) {
    const { closing } = life;
    if (closing === null)
        return null;
    return {
        home: closing.home,
        task: closing.task,
        topic: boardUpdate(closing, input).topic,
        ts: closing.ts,
        text: closing.text,
        outcome: closing.outcome ?? null,
        records: life.records.toSorted((a, b) => b.ts - a.ts),
    };
}
/** The life a decision's record belongs to: the last one, or a new one at an opening after a close. */
function lifeOf(all, event) {
    const last = all.at(-1);
    if (last !== undefined && (event.kind !== "hold.opened" || last.closing === null))
        return last;
    const life = { records: [], closing: null };
    all.push(life);
    return life;
}
/**
 * The decisions that closed, from their records: a life of one home's task
 * holds every decision record of it, and is closed once a hold.answered or
 * hold.closed record is in it. One decision may have two closing records (the
 * page's answer that found it ended elsewhere, and the real close the home
 * reports), so a later closing record joins the same life; only a new
 * hold.opened after a close starts the next one. A decision with no closing
 * record is not closed, whatever a home's read shows.
 */
function closedDecisions(input) {
    const lives = new Map();
    for (const event of input.events.filter(isDecisionRecord)) {
        const key = `${event.home}\t${event.task}`;
        const all = lives.get(key) ?? [];
        const life = lifeOf(all, event);
        life.records.push(boardUpdate(event, input));
        if (DECISION_CLOSING_KINDS.has(event.kind))
            life.closing = event;
        lives.set(key, all);
    }
    return [...lives.values()]
        .flat()
        .flatMap((life) => closedDecisionOf(life, input) ?? [])
        .toSorted((a, b) => b.ts - a.ts);
}
/** The PR a `ready` or `landed` summary refers to: the task's latest PR event at or before it. */
function prForSummary(summary, events) {
    if (summary.kind !== "ready" && summary.kind !== "landed")
        return null;
    const candidates = events.filter((event) => event.home === summary.home &&
        event.task === summary.task &&
        event.ts <= summary.ts &&
        (event.event === "task.pr_ready" || event.event === "task.merged"));
    const latest = candidates.at(-1);
    return latest === undefined ? null : prOf(latest);
}
function topicViews(topics) {
    const views = {};
    for (const [id, topic] of Object.entries(topics.doc.topics)) {
        views[id] = {
            name: topic.name,
            goal: topic.goal,
            status: topic.status,
            queue: orNull(QUEUES.find((queue) => topics.doc.queues[queue].includes(id))),
            close_reason: topic.close_proposal === undefined ? null : topic.close_proposal.reason,
            archived_at: null,
        };
    }
    for (const [id, topic] of Object.entries(topics.archive.topics)) {
        views[id] = {
            name: topic.name,
            goal: topic.goal,
            status: "archived",
            queue: null,
            close_reason: null,
            archived_at: topic.archived_at,
        };
    }
    return views;
}
export function buildView(input) {
    const placer = new Placer(input.topics, input.homes);
    const ledger = ledgerEvents(input);
    const last = lastEvents(ledger);
    const runs = currentRuns(ledger);
    const homes = input.homes.map((home) => homeView(home, input));
    const view = {
        homes,
        queues: structuredClone(input.topics.doc.queues),
        topics: topicViews(input.topics),
        agents: [],
        queued: [],
        holds: [],
        todos: [],
        closed_todos: closedTodos(input),
        closed_decisions: closedDecisions(input),
        questions: [],
        updates: updatesOf(input, placer),
        summaries: input.summaries
            .map((summary) => ({
            ...summary,
            pr: prForSummary(summary, ledger),
            topic: placer.current(summary.home, summary.task).topic,
        }))
            .toSorted((a, b) => b.ts - a.ts),
    };
    const ranked = [];
    input.homes.forEach((home, index) => {
        const stale = homes[index].stale;
        view.agents.push(...agentsOf(home, stale, placer, last, runs));
        ranked.push(...holdsOf(home, stale, placer));
        if (home.report === null)
            return;
        for (const item of home.report.queued) {
            view.queued.push({
                home: home.id,
                task: item.id,
                kind: item.kind,
                title: item.title,
                topic: placer.queued(home.id, item).topic,
                waiting: waitingFor(item),
            });
        }
        view.questions.push(...questionsOf(home.id, home.report, placer));
    });
    view.holds = ranked.toSorted(holdOrder(view)).map((entry) => entry.view);
    view.todos = todoViews(input, view);
    return view;
}
/** Sort key for an item: its topic's queue and place (no topic and archived last), then age. */
function itemRank(view, item) {
    const queue = item.topic === null ? null : (view.topics[item.topic]?.queue ?? null);
    if (item.topic === null || queue === null)
        return [QUEUES.length, QUEUES.length];
    return [QUEUES.indexOf(queue), view.queues[queue].indexOf(item.topic)];
}
function todoViews(input, view) {
    const entries = Object.entries(input.todos.items).map(([task, item]) => ({
        created: item.created_at,
        view: {
            task,
            title: item.title,
            topic: itemTopic(input.topics, item),
            what: item.action,
            guidance: item.guidance,
            commands: [...item.commands],
            state: item.state,
            reason: item.reason,
        },
    }));
    return entries
        .toSorted((a, b) => compareRanks(itemRank(view, a.view), itemRank(view, b.view)) ||
        a.created.localeCompare(b.created) ||
        a.view.task.localeCompare(b.view.task))
        .map((entry) => entry.view);
}
