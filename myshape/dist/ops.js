// Every operation that changes the board, in one table: which channel may run
// it, which file commits it, and how its arguments become a change. The
// socket and the page both run operations only through applyOperation, which
// saves each change with its records through store.ts commitChange.
import * as confirmations from "./confirmations.js";
import { stringField } from "./files.js";
import { commitChange } from "./store.js";
import * as topics from "./topics.js";
import * as todos from "./todos.js";
import * as hashtags from "./hashtags.js";
import * as schedules from "./schedules.js";
import { scheduleEnv, scheduleOperations } from "./schedule-ops.js";
import { closedNotice } from "./schedule-notices.js";
import { todoState, todoTransitionProblem, withKept, withSettings, withStall, } from "./lifecycle.js";
import { KEEP_DEFAULT_DAYS, KEEP_MAX_DAYS, changeSettings } from "./lifecycle-settings.js";
import { askStall, deferStall, localDay } from "./stalls.js";
/** The schedule on `id`, if any. */
function scheduled(ctx, id) {
    return schedules.scheduleOfTopic(ctx.schedules, ctx.topics, id) !== null;
}
function optionalQueue(args) {
    const value = args["queue"];
    if (value === undefined)
        return undefined;
    return topics.isQueue(value) ? value : null;
}
function movePosition(args) {
    const before = args["before"];
    if (args["first"] === true)
        return before === undefined ? { first: true } : null;
    if (args["last"] === true)
        return before === undefined ? { last: true } : null;
    if (before === undefined)
        return undefined;
    return typeof before === "string" ? { before } : null;
}
/**
 * The page's drop under a filter: directly after the card shown above it
 * (spec/drag-under-filter.markdown), with no other position beside it.
 */
function afterPosition(args) {
    const after = args["after"];
    const alone = args["before"] === undefined && args["first"] === undefined;
    return alone && args["last"] === undefined && typeof after === "string" ? { after } : null;
}
/** Where a move puts the topic. Only the page may send `after`; the socket's move never reads it. */
function positionOf(ctx, args) {
    const fromPage = ctx.by === "captain";
    return fromPage && args["after"] !== undefined ? afterPosition(args) : movePosition(args);
}
/** Why a hands-on operation may not start from its item's state now (lifecycle.ts TODO_TRANSITIONS). */
function transitionProblem(op, ctx, args) {
    const id = stringField(args, "task");
    const item = id === null || !Object.hasOwn(ctx.todos.items, id) ? undefined : ctx.todos.items[id];
    if (id === null || item === undefined)
        return null;
    // The same verdict again changes nothing, and a redo is not refused (contracts section 9).
    const reason = topics.oneLine(stringField(args, "reason") ?? "", topics.GOAL_MAX);
    if (op === "todo-failed" && item.state === "rejected" && item.reason === reason)
        return null;
    return todoTransitionProblem(op, id, todoState(item));
}
/** The `reason` argument: absent, a string, or null when it is something else. */
function optionalReason(args) {
    const reason = args["reason"];
    if (reason === undefined)
        return undefined;
    return typeof reason === "string" ? reason : null;
}
/** The optional `id` argument, spread into an input; null when it is not a string. */
function optionalId(args) {
    const id = args["id"];
    if (id === undefined)
        return {};
    return typeof id === "string" ? { id } : null;
}
/** Archiving a scheduled topic pauses its schedule and ends an open occurrence, each with a record. */
function archiveSchedules(ctx, result) {
    if (!result.changed)
        return null;
    const [record] = result.records;
    const paused = schedules.pauseForArchive(ctx.schedules, scheduleEnv(ctx), record.topic);
    return paused === null ? null : { next: paused.store, records: paused.records };
}
function create(ctx, args) {
    const name = stringField(args, "name");
    const goal = stringField(args, "goal");
    const queue = optionalQueue(args);
    const id = optionalId(args);
    if (name === null || goal === null)
        return { usage: "create 需要名稱與 --goal。" };
    if (queue === null)
        return { usage: "--queue 只能是 high、normal、later。" };
    if (id === null)
        return { usage: "--id 要是字串。" };
    if (stringList(args["hashtags"]) === null)
        return { usage: "--hashtag 要是 hashtag 名稱。" };
    if (stringList(args["new_hashtags"]) === null)
        return { usage: "--new-hashtag 要是 hashtag 名稱。" };
    const input = { name, goal, ...id, ...(queue === undefined ? {} : { queue }) };
    return topics.create(ctx.topics, input, ctx.now);
}
function hashtagContext(ctx, topicState = ctx.topics) {
    return {
        store: ctx.hashtags,
        topics: topicState,
        by: ctx.by,
        records: ctx.records,
        now: ctx.now,
    };
}
/** A hashtag result as a topic change's follow-up. */
function asFollow(result) {
    if (!result.ok)
        return { refused: result.line };
    if (!result.changed)
        return { follow: null, line: "" };
    return {
        follow: { store: result.store, records: result.records },
        line: result.line.replace(/^ok \S+ /, ""),
    };
}
/** A new topic gets the hashtags its create names, under the same rails as any other. */
function createHashtags(ctx, args, result) {
    const opening = stringList(args["new_hashtags"]) ?? [];
    const names = [...(stringList(args["hashtags"]) ?? []), ...opening];
    if (names.length === 0 || result.subject === undefined)
        return { follow: null, line: "" };
    const context = hashtagContext(ctx, result.state);
    return asFollow(hashtags.addHashtags(context, result.subject, names, { names: opening, via: "create" }));
}
/** A merged topic brings its hashtags along: the topic it went into gets the union. */
function mergeHashtags(ctx, args, result) {
    if (!result.changed)
        return { follow: null, line: "" };
    const from = topics.resolveTopicId(ctx.topics.doc, stringField(args, "from") ?? "");
    const into = topics.resolveTopicId(ctx.topics.doc, stringField(args, "into") ?? "");
    const name = result.state.doc.topics[into]?.name ?? into;
    const follow = hashtags.carryMerge(ctx.hashtags, from, { id: into, name });
    return { follow, line: follow === null ? "" : "hashtag 取聯集" };
}
/** A topic split off starts with its source's hashtags. */
function splitHashtags(ctx, args, result) {
    if (!result.changed || result.subject === undefined)
        return { follow: null, line: "" };
    const from = topics.resolveTopicId(ctx.topics.doc, stringField(args, "from") ?? "");
    const name = result.state.doc.topics[result.subject]?.name ?? result.subject;
    const follow = hashtags.carrySplit(ctx.hashtags, from, { id: result.subject, name });
    const copied = ctx.hashtags.topics[from] ?? [];
    return {
        follow,
        line: follow === null ? "" : `帶上 ${copied.map((tag) => `#${tag}`).join("、")}`,
    };
}
function merge(ctx, args) {
    const from = stringField(args, "from");
    const into = stringField(args, "into");
    const reason = optionalReason(args);
    if (from === null || into === null)
        return { usage: "merge 需要兩個議題 id。" };
    if (reason === null)
        return { usage: "--reason 要是一行文字。" };
    return mergeScheduled(ctx, from, into, () => topics.merge(ctx.topics, from, into, ctx.now, reason));
}
/**
 * A merge under the one-schedule-per-topic rule: two scheduled topics are
 * refused, and a single schedule follows its topic (followMerge).
 */
function mergeScheduled(ctx, from, into, apply) {
    const moving = schedules.scheduleOfTopic(ctx.schedules, ctx.topics, from);
    const staying = schedules.scheduleOfTopic(ctx.schedules, ctx.topics, into);
    if (moving !== null && staying !== null && moving.id !== staying.id)
        return refusedTopic("兩個議題都有排程，一個議題最多一筆排程：先刪掉其中一筆排程。");
    const result = apply();
    if (moving === null || staying !== null || !result.ok || !result.changed)
        return result;
    return followMerge(ctx, result, moving.series.title);
}
/**
 * A schedule follows its topic into the one it was merged into, which goes to
 * 待辦 so the schedule decides when it comes up. The schedule keeps the old
 * topic id; every reader follows `merged` from it.
 */
function followMerge(ctx, merged, title) {
    const [record] = merged.records;
    const into = record.topic;
    const name = merged.state.doc.topics[into]?.name ?? into;
    const follow = {
        kind: "schedule.merged",
        topic: into,
        text: `排程「${title}」跟著議題併到「${name}」，議題放在「待辦」`,
    };
    if (merged.state.doc.queues.later.includes(into))
        return { ...merged, records: [...merged.records, follow] };
    const moved = topics.move(merged.state, into, "later", { last: true }, ctx.now);
    if (!moved.ok || !moved.changed)
        return moved;
    return {
        ...moved,
        line: `${merged.line}，排程跟著過來，議題放進「待辦」`,
        records: [...merged.records, ...moved.records, follow],
    };
}
function move(ctx, args) {
    const id = stringField(args, "id");
    const queue = optionalQueue(args);
    const position = positionOf(ctx, args);
    if (id === null || queue === null || queue === undefined || position === null) {
        return { usage: "move 需要議題 id 與佇列（high、normal、later）。" };
    }
    if (queue !== "later" && scheduled(ctx, id))
        return refusedTopic("這個議題有排程，位置由時間決定；要移出「待辦」，先刪掉排程。");
    return topics.move(ctx.topics, id, queue, position, ctx.now);
}
function refusedTopic(line) {
    return { ok: false, code: "refused", line };
}
/** What a split asks for, or why it is malformed. */
function splitInput(args) {
    const from = stringField(args, "from");
    const name = stringField(args, "name");
    const goal = stringField(args, "goal");
    const id = optionalId(args);
    const reason = optionalReason(args);
    if (from === null || name === null || goal === null)
        return { usage: "split 需要來源議題、新名稱與 --goal。" };
    if (id === null)
        return { usage: "--id 要是字串。" };
    if (reason === null)
        return { usage: "--reason 要是一行文字。" };
    return { from, name, goal, ...id, ...(reason === undefined ? {} : { reason }) };
}
function split(ctx, args) {
    const input = splitInput(args);
    if ("usage" in input)
        return input;
    const result = topics.split(ctx.topics, input, ctx.now);
    // --dry answers what the split would do, so the caller can check its tasks first.
    if (args["dry"] !== true || !result.ok)
        return result;
    return { ok: true, changed: false, state: ctx.topics, line: result.line };
}
/** An operation that takes a topic id and one line of text (rename, goal). */
function textOp(apply, problem) {
    return (ctx, args) => {
        const id = stringField(args, "id");
        const value = stringField(args, "value");
        if (id === null || value === null)
            return { usage: problem };
        return apply(ctx.topics, id, value, ctx.now);
    };
}
/** How many days 先不關 or 延到 asks for: the default when absent, null when it is not 1 to KEEP_MAX_DAYS. */
function daysOf(args) {
    const days = args["days"] ?? KEEP_DEFAULT_DAYS;
    return typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= KEEP_MAX_DAYS
        ? days
        : null;
}
/**
 * The captain's 先不關 on a close proposal: until a date (`days`, 14 by
 * default, at most 90), or moved to 待辦 (`later: true`); never with no choice.
 */
function keep(ctx, args) {
    const id = stringField(args, "id");
    if (id === null)
        return { usage: "keep 需要議題 id。" };
    if (args["later"] !== true && daysOf(args) === null)
        return { usage: `先不關要選幾天（1 到 ${KEEP_MAX_DAYS}），或移到待辦。` };
    const kept = topics.keepOpen(ctx.topics, id);
    if (!kept.ok || !kept.changed || args["later"] !== true)
        return kept;
    const target = topics.resolveTopicId(ctx.topics.doc, id);
    const moved = topics.move(kept.state, target, "later", { last: true }, ctx.now);
    if (!moved.ok || !moved.changed)
        return kept;
    return {
        ...moved,
        line: `${kept.line}，移到「待辦」`,
        records: [...kept.records, ...moved.records],
    };
}
/** 先不關 until a date keeps that date in lifecycle.json; moving to 待辦 needs none. */
function keptUntil(ctx, args, result) {
    const days = daysOf(args);
    if (!result.changed || args["later"] === true || days === null)
        return null;
    const id = topics.resolveTopicId(ctx.topics.doc, stringField(args, "id") ?? "");
    const until = new Date(Date.parse(ctx.now) + days * 86_400_000).toISOString();
    return withKept(ctx.lifecycle, id, until);
}
/**
 * The captain's answer on one of the board's own cards: 先不關，到某天 on a
 * 沒人處理的議題 card (`card: "idle"`, `key` its topic id), or on a 沒人接 card
 * (`card: "stall"`, `key` its topic id or "-") 延到 <日期>, or with `ask: true`
 * 請 <aggregator> 處理. The other buttons of both are operations the board
 * already has (archive, move).
 */
function deferAnswer(ctx, args) {
    const key = stringField(args, "key");
    if (key === null)
        return { ok: false, code: "usage", line: "需要卡的 key。" };
    if (args["card"] === "idle")
        return keepIdle(ctx, key, daysOf(args));
    if (args["card"] !== "stall")
        return { ok: false, code: "usage", line: "card 要是 idle 或 stall。" };
    if (args["ask"] === true)
        return askAnswer(ctx, key);
    const nameOf = (id) => ctx.topics.doc.topics[id]?.name ?? id;
    const nowMs = Date.parse(ctx.now);
    const result = deferStall(ctx.lifecycle.stalls, key, args["days"] ?? KEEP_DEFAULT_DAYS, {
        nameOf,
        nowMs,
        askMinutes: ctx.lifecycle.settings.N3.raise,
    });
    if (!result.ok)
        return result;
    const store = withStall(ctx.lifecycle, key, result.stall);
    return { ok: true, changed: true, store, line: result.line, records: result.records };
}
/** A topic's name, an archived one's too, or its id for one the board does not know. */
function topicNameOf(state, id) {
    const live = state.doc.topics[id];
    if (live !== undefined)
        return live.name;
    const archived = state.archive.topics[id];
    return archived === undefined ? id : archived.name;
}
/** 請 <aggregator> 處理 on a 沒人接 card, naming its members as the page lists them now. */
function askAnswer(ctx, key) {
    const nameOf = (id) => topicNameOf(ctx.topics, id);
    const shown = ctx.stalls().find((stall) => stall.key === key);
    const members = shown === undefined ? [] : shown.members;
    const context = {
        nameOf,
        nowMs: Date.parse(ctx.now),
        label: ctx.label,
        members,
        askMinutes: ctx.lifecycle.settings.N3.raise,
    };
    const asked = askStall(ctx.lifecycle.stalls, key, context);
    if (!asked.ok)
        return asked;
    const store = withStall(ctx.lifecycle, key, asked.stall);
    const { line, records, message } = asked;
    return { ok: true, changed: true, store, line, records, message };
}
/** 先不關，到某天 on a 沒人處理的議題 card: the topic waits until then (T4), and the card goes. */
function keepIdle(ctx, topic, days) {
    if (ctx.lifecycle.idle[topic] === undefined)
        return { ok: false, code: "refused", line: `${topic} 現在不是「沒人處理的議題」。` };
    if (days === null)
        return { ok: false, code: "usage", line: `先不關要選幾天（1 到 ${KEEP_MAX_DAYS}）。` };
    const until = new Date(Date.parse(ctx.now) + days * 86_400_000).toISOString();
    const store = withKept(ctx.lifecycle, topic, until);
    const name = ctx.topics.doc.topics[topic]?.name ?? topic;
    const day = localDay(until);
    return {
        ok: true,
        changed: true,
        store,
        line: `ok ${topic} 先不關，到 ${day}`,
        records: [
            {
                kind: "lifecycle.answered",
                topic,
                outcome: "kept",
                text: `「沒人處理的議題」議題「${name}」：先不關，到 ${day}`,
            },
        ],
    };
}
function todoUsage(line) {
    return { ok: false, code: "usage", line };
}
/** The optional parts of a `todo-add` request. */
function todoOptions(args) {
    return {
        guidance: typeof args["guidance"] === "string" ? args["guidance"] : "",
        ref: typeof args["ref"] === "string" ? args["ref"] : "",
        captainCloses: args["captain_closes"] === true,
    };
}
/** What a `todo-add` request asks for, or why it is malformed. */
function todoInput(args) {
    const commands = args["commands"];
    const topic = args["topic"];
    const id = stringField(args, "id");
    const title = stringField(args, "title");
    const action = stringField(args, "action");
    if (id === null || title === null || action === null)
        return "todo add 需要 task id、標題與 --do。";
    if (!Array.isArray(commands) || !commands.every((command) => typeof command === "string"))
        return "--cmd 要是文字。";
    if (topic !== null && typeof topic !== "string")
        return "--topic 要是議題 id。";
    return { id, title, topic, action, commands, ...todoOptions(args) };
}
/** The item id and one-line reason of a verdict, or why they are missing. */
function verdictArgs(args) {
    const task = stringField(args, "task");
    const reason = stringField(args, "reason");
    if (task === null)
        return todoUsage("需要 task id。");
    if (reason === null)
        return todoUsage("需要 --reason <一行>。");
    return { task, reason };
}
/** An operation on one item named by `task`. */
function onItem(apply) {
    return (ctx, args) => {
        const task = stringField(args, "task");
        return task === null ? todoUsage("需要 task id。") : apply(ctx, task);
    };
}
/** The aggregator's verdict on an item, with its one-line reason. */
function verdict(apply) {
    return (ctx, args) => {
        const given = verdictArgs(args);
        if (!("task" in given))
            return given;
        return apply(ctx.todos, given.task, given.reason, ctx.now, ctx.label);
    };
}
function closeByCaptain(words) {
    return onItem((ctx, task) => todos.closeByCaptain(ctx.todos, task, words, ctx.label));
}
function hashtagUsage(line) {
    return { ok: false, code: "usage", line };
}
/** A hashtag operation that takes two string arguments, `first` and `second`. */
function onPair([first, second], apply) {
    return (ctx, args) => {
        const one = stringField(args, first);
        const two = stringField(args, second);
        if (one === null || two === null)
            return hashtagUsage(`需要 ${first} 與 ${second}。`);
        return apply(hashtagContext(ctx), one, two);
    };
}
/** A hashtag operation on one topic: its id and a hashtag name. */
function onTopicTag(apply) {
    return onPair(["id", "name"], apply);
}
/** `hashtag-add`: one name on one topic; `new: true` says the name is new. */
function addTag(ctx, args) {
    const id = stringField(args, "id");
    const name = stringField(args, "name");
    const said = args["new"];
    if (id === null || name === null)
        return hashtagUsage("需要 id 與 name。");
    if (said !== undefined && typeof said !== "boolean")
        return hashtagUsage("new 要是 true 或 false。");
    const opening = { names: said === true ? [name] : [], via: "hashtag" };
    return hashtags.addHashtags(hashtagContext(ctx), id, [name], opening);
}
/** A hashtag operation on one hashtag and one more string argument. */
function onTag(second, apply) {
    return onPair(["name", second], apply);
}
/** A list of strings: none when absent, null when it is something else. */
function stringList(value) {
    if (value === undefined)
        return [];
    return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}
/** The order a view-save request lists cards in: 照優先順序 when absent, null when unknown. */
function orderArg(args) {
    const order = args["order"] ?? "priority";
    return hashtags.isCardOrder(order) ? order : null;
}
/** What a view-save request asks for, or why it is malformed. */
function viewInput(args) {
    const name = stringField(args, "name");
    const text = args["text"] ?? "";
    const any = stringList(args["any"]);
    const none = stringList(args["none"]);
    const id = optionalId(args);
    if (name === null || typeof text !== "string" || any === null || none === null)
        return "視圖需要名稱，any 與 none 是 hashtag 名稱的清單，text 是文字。";
    if (id === null)
        return "視圖 id 要是字串。";
    const order = orderArg(args);
    if (order === null)
        return "order 要是 priority、newest 或 oldest。";
    return {
        ...id,
        name,
        any,
        none,
        text,
        untagged: args["untagged"] === true,
        order,
    };
}
const HASHTAG_OPERATIONS = {
    "hashtag-add": {
        channel: "both",
        commitFile: "hashtags",
        run: addTag,
    },
    "hashtag-remove": {
        channel: "both",
        commitFile: "hashtags",
        run: onTopicTag(hashtags.removeHashtag),
    },
    "hashtag-rename": {
        channel: "page",
        commitFile: "hashtags",
        run: onTag("to", hashtags.renameHashtag),
    },
    "hashtag-merge": {
        channel: "page",
        commitFile: "hashtags",
        run: onTag("into", hashtags.mergeHashtags),
    },
    "hashtag-delete": {
        channel: "page",
        commitFile: "hashtags",
        run: (ctx, args) => {
            const name = stringField(args, "name");
            return name === null
                ? hashtagUsage("需要 hashtag 名稱。")
                : hashtags.deleteHashtag(hashtagContext(ctx), name);
        },
    },
    "hashtag-lock": {
        channel: "page",
        commitFile: "hashtags",
        run: (ctx, args) => {
            const name = stringField(args, "name");
            const locked = args["locked"];
            if (name === null || typeof locked !== "boolean")
                return hashtagUsage("需要 hashtag 名稱與 locked（true 或 false）。");
            return hashtags.lockHashtag(hashtagContext(ctx), name, locked);
        },
    },
    "hashtag-color": {
        channel: "page",
        commitFile: "hashtags",
        run: onTag("color", hashtags.colorHashtag),
    },
    "hashtag-settings": {
        channel: "page",
        commitFile: "hashtags",
        run: (ctx, args) => hashtags.changeSettings(hashtagContext(ctx), args),
    },
    "hashtag-revert": {
        channel: "page",
        commitFile: "hashtags",
        run: (ctx, args) => {
            const rid = stringField(args, "rid");
            return rid === null
                ? hashtagUsage("需要紀錄 id。")
                : hashtags.revertChange(hashtagContext(ctx), rid);
        },
    },
    "hashtag-seen": {
        channel: "page",
        commitFile: "hashtags",
        run: (ctx) => hashtags.markSeen(hashtagContext(ctx)),
    },
    "view-save": {
        channel: "page",
        commitFile: "hashtags",
        run: (ctx, args) => {
            const input = viewInput(args);
            return typeof input === "string"
                ? hashtagUsage(input)
                : hashtags.saveView(hashtagContext(ctx), input);
        },
    },
    "view-delete": {
        channel: "page",
        commitFile: "hashtags",
        run: (ctx, args) => {
            const id = stringField(args, "id");
            return id === null
                ? hashtagUsage("需要視圖 id。")
                : hashtags.deleteView(hashtagContext(ctx), id);
        },
    },
};
/**
 * Every operation that changes the board. A hands-on operation commits
 * through todos.json, a hashtag operation through hashtags.json, a program
 * confirmation through confirmations.json, every other one through
 * topics.json (store.ts); create, merge and split also save their hashtags'
 * follow-up in hashtags.json right after.
 */
export const OPERATIONS = {
    create: { channel: "socket", commitFile: "topics", run: create, hashtags: createHashtags },
    merge: { channel: "both", commitFile: "topics", run: merge, hashtags: mergeHashtags },
    "close-propose": {
        channel: "socket",
        commitFile: "topics",
        run: (ctx, args) => {
            const id = stringField(args, "id");
            const reason = stringField(args, "reason");
            if (id === null || reason === null)
                return { usage: "close-propose 需要議題 id 與 --reason。" };
            return topics.closePropose(ctx.topics, id, reason, ctx.now);
        },
    },
    move: { channel: "both", commitFile: "topics", run: move },
    split: { channel: "socket", commitFile: "topics", run: split, hashtags: splitHashtags },
    rename: {
        channel: "both",
        commitFile: "topics",
        run: textOp(topics.rename, "rename 需要議題 id 與名稱。"),
    },
    goal: {
        channel: "both",
        commitFile: "topics",
        run: textOp(topics.setGoal, "goal 需要議題 id 與一行目標。"),
    },
    archive: {
        channel: "both",
        commitFile: "topics",
        run: (ctx, args) => {
            const id = stringField(args, "id");
            return id === null
                ? { usage: "archive 需要議題 id。" }
                : topics.archive(ctx.topics, id, ctx.now);
        },
        schedules: archiveSchedules,
    },
    keep: { channel: "page", commitFile: "topics", run: keep, lifecycle: keptUntil },
    reopen: {
        channel: "both",
        commitFile: "topics",
        run: (ctx, args) => {
            const id = stringField(args, "id");
            const queue = optionalQueue(args);
            if (id === null || queue === null)
                return { usage: "reopen 需要議題 id。" };
            // A scheduled topic always comes back to 待辦: its schedule decides when it comes up.
            if (!scheduled(ctx, id))
                return topics.reopen(ctx.topics, id, queue, ctx.now);
            const result = topics.reopen(ctx.topics, id, "later", ctx.now);
            if (!result.ok || !result.changed)
                return result;
            return { ...result, line: `${result.line}（有排程，排程議題放在「待辦」）` };
        },
    },
    "todo-add": {
        channel: "socket",
        commitFile: "todos",
        run: (ctx, args) => {
            const input = todoInput(args);
            if (typeof input === "string")
                return todoUsage(input);
            const agent = { name: ctx.agent, label: ctx.label };
            return todos.addItem(ctx.todos, ctx.topics, input, ctx.now, agent);
        },
    },
    "todo-done": {
        channel: "socket",
        commitFile: "todos",
        run: onItem((ctx, task) => todos.doneItem(ctx.todos, task, ctx.label)),
    },
    "todo-failed": { channel: "socket", commitFile: "todos", run: verdict(todos.rejectItem) },
    "todo-obsolete": { channel: "socket", commitFile: "todos", run: verdict(todos.obsoleteItem) },
    "todo-claim": {
        channel: "page",
        commitFile: "todos",
        run: onItem((ctx, task) => todos.claimItem(ctx.todos, task, ctx.now, ctx.label)),
    },
    "todo-drop": { channel: "page", commitFile: "todos", run: closeByCaptain("不做了") },
    "todo-takedown": { channel: "page", commitFile: "todos", run: closeByCaptain("撤下") },
    "lifecycle-settings": {
        channel: "page",
        commitFile: "lifecycle",
        run: (ctx, args) => {
            const result = changeSettings(ctx.lifecycle.settings, args);
            if (!result.ok || !result.changed)
                return result;
            const store = withSettings(ctx.lifecycle, result.settings);
            return { ok: true, changed: true, store, line: result.line, records: result.records };
        },
    },
    "lifecycle-answer": { channel: "page", commitFile: "lifecycle", run: deferAnswer },
    // The page's route computes every argument itself (api.ts); a page request never names them.
    "program-confirm": {
        channel: "page",
        commitFile: "confirmations",
        run: (ctx, args) => {
            const roles = args["roles"];
            const input = {
                path: stringField(args, "path") ?? "",
                sha256: stringField(args, "sha256") ?? "",
                binding_sha256: stringField(args, "binding_sha256") ?? "",
                roles: Array.isArray(roles) ? roles.filter((role) => typeof role === "string") : [],
            };
            return confirmations.confirmProgram(ctx.confirmations, input, ctx.now);
        },
    },
    ...HASHTAG_OPERATIONS,
    ...scheduleOperations,
};
/** The operation called `name`, or undefined for anything else. */
export function operationOf(name) {
    return Object.hasOwn(OPERATIONS, name) ? OPERATIONS[name] : undefined;
}
// Decisions the agent side is waiting on or has to act on. A reopening is
// left out: the dispatchable notice already covers it.
const DECISION_EVENTS = {
    "topic.merged": "topic.merged",
    "topic.archived": "topic.archived",
    "topic.kept": "topic.kept",
};
/** What the captain just decided on the page, from the change's records; empty when none. */
function decisionNotices(records) {
    return records.flatMap((record) => {
        const event = DECISION_EVENTS[record.kind];
        if (event === undefined || record.topic === null)
            return [];
        return [{ event, topic: record.topic, line: `${record.text}（id：${record.topic}）` }];
    });
}
function answer(board, response) {
    return {
        response,
        board,
        committed: null,
        records: [],
        appendError: null,
        dispatchable: [],
        notices: [],
        decisions: [],
        scheduleNotices: [],
        messages: [],
    };
}
function refused(line) {
    return { ok: false, code: "refused", line };
}
function serialize(value) {
    return JSON.stringify(value);
}
/** A result that says it changed nothing must hand back the state it was given. */
export function assertUnchanged(op, before, after) {
    if (serialize(before) !== serialize(after))
        throw new Error(`${op} 說沒有改任何東西，卻回了不同的狀態`);
}
/** Each record of a change, saying whether it came from the page or a command. */
function withSuffix(records, actor) {
    const [first, ...rest] = records.map((record) => ({
        ...record,
        text: `${record.text}（${actor}）`,
    }));
    return [first, ...rest];
}
function channelProblem(op, operation, fromPage) {
    if (!fromPage && operation.channel === "page")
        return `${op} 是使用者在頁面上按的，不能從指令送。`;
    if (fromPage && operation.channel === "socket")
        return `${op} 只能從指令送。`;
    return null;
}
function commit(target, board, change, actor, line) {
    const saved = commitChange(target, board, change, actor);
    if (!saved.ok)
        return answer(board, refused(saved.line));
    return {
        ...answer(saved.board, { ok: true, line }),
        committed: change.file === "memory" ? "lifecycle" : change.file,
        records: saved.records,
        appendError: saved.appendError,
    };
}
function suffixOf(request, actor) {
    return request.fromPage ? "你在頁面上" : `${actor.label} 用指令`;
}
function withFollowLine(line, follow) {
    return follow.follow === null || follow.line === "" ? line : `${line}；${follow.line}`;
}
function applyTopicOp(target, board, request, actor, run) {
    const { result } = run;
    if (!result.ok)
        return answer(board, refused(result.line));
    const follow = run.follow(result);
    if ("refused" in follow)
        return answer(board, refused(follow.refused));
    const suffix = suffixOf(request, actor);
    if (!result.changed) {
        assertUnchanged(request.op, board.topics, result.state);
        if (follow.follow === null)
            return answer(board, { ok: true, line: result.line });
        const change = {
            file: "hashtags",
            next: follow.follow.store,
            records: withSuffix(follow.follow.records, suffix),
        };
        return commit(target, board, change, actor, withFollowLine(result.line, follow));
    }
    const recorded = board.topics.doc.history.length;
    const stamped = topics.stampHistory(result, recorded, request.fromPage ? "page" : "command");
    const change = {
        file: "topics",
        next: stamped.state,
        records: withSuffix(stamped.records, suffix),
        ...(follow.follow === null
            ? {}
            : {
                hashtags: {
                    next: follow.follow.store,
                    records: withSuffix(follow.follow.records, suffix),
                },
            }),
        ...schedulePartOf(run.schedules(result)),
        ...lifecyclePartOf(run.lifecycle(result)),
    };
    return {
        ...commit(target, board, change, actor, withFollowLine(stamped.line, follow)),
        dispatchable: stamped.dispatchable,
        decisions: request.fromPage ? decisionNotices(stamped.records) : [],
    };
}
function applyHashtagOp(target, board, request, actor, result) {
    if (!result.ok)
        return answer(board, { ok: false, code: result.code, line: result.line });
    if (!result.changed) {
        assertUnchanged(request.op, board.hashtags, result.store);
        return answer(board, { ok: true, line: result.line });
    }
    const change = {
        file: "hashtags",
        next: result.store,
        records: withSuffix(result.records, suffixOf(request, actor)),
    };
    return commit(target, board, change, actor, result.line);
}
function applyTodoOp(target, board, request, actor, result) {
    if (!result.ok)
        return answer(board, { ok: false, code: result.code, line: result.line });
    if (!result.changed) {
        assertUnchanged(request.op, board.todos, result.store);
        return answer(board, { ok: true, line: result.line });
    }
    // A hands-on record names its item, not a task, and the topic it shows under now.
    const [first, ...rest] = result.records.map((record) => ({
        ...record,
        topic: record.topic === null ? null : topics.resolveTopicId(board.topics.doc, record.topic),
    }));
    const change = {
        file: "todos",
        next: result.store,
        records: [first, ...rest],
    };
    return { ...commit(target, board, change, actor, result.line), notices: result.notices };
}
function applyConfirmOp(target, board, request, actor, result) {
    if (!result.ok)
        return answer(board, { ok: false, code: result.code, line: result.line });
    if (!result.changed) {
        assertUnchanged(request.op, board.confirmations, result.store);
        return answer(board, { ok: true, line: result.line });
    }
    const change = {
        file: "confirmations",
        next: result.store,
        records: withSuffix(result.records, "你在頁面上"),
    };
    return commit(target, board, change, actor, result.line);
}
/** Runs a topic operation, then its follow-up in hashtags.json, and saves both. */
function runTopicOp(target, board, request, actor, run) {
    const { operation, ctx } = run;
    const result = operation.run(ctx, request.args);
    if ("usage" in result)
        return answer(board, { ok: false, code: "usage", line: result.usage });
    const follow = (ok) => operation.hashtags?.(ctx, request.args, ok) ?? { follow: null, line: "" };
    const part = (ok) => operation.schedules?.(ctx, ok) ?? null;
    const lifecycle = (ok) => operation.lifecycle?.(ctx, request.args, ok) ?? null;
    return applyTopicOp(target, board, request, actor, {
        result,
        follow,
        schedules: part,
        lifecycle,
    });
}
/** A topic change's part in schedules.json as the change carries it. */
function schedulePartOf(part) {
    return part === null ? {} : { schedules: part };
}
function lifecyclePartOf(part) {
    return part === null ? {} : { lifecycle: part };
}
function applyLifecycleOp(target, board, actor, result) {
    if (!result.ok)
        return answer(board, { ok: false, code: result.code, line: result.line });
    if (!result.changed)
        return answer(board, { ok: true, line: result.line });
    const change = {
        file: "lifecycle",
        next: result.store,
        records: withSuffix(result.records, "你在頁面上"),
    };
    const applied = commit(target, board, change, actor, result.line);
    // Saved first: the message goes only for an ask the board has recorded.
    if (applied.committed === null || result.message === undefined)
        return applied;
    return { ...applied, messages: [result.message] };
}
function applyScheduleOp(target, board, request, actor, result) {
    if (!result.ok)
        return answer(board, { ok: false, code: result.code, line: result.line });
    if (!result.changed) {
        assertUnchanged(request.op, board.schedules, result.store);
        return answer(board, { ok: true, line: result.line });
    }
    const change = { file: "schedules", next: result.store, records: result.records };
    const applied = commit(target, board, change, actor, result.line);
    const closed = result.closed;
    // Only the captain's close is news to the aggregator, and only once it was told of the occurrence.
    if (applied.committed === null || !request.fromPage || closed === undefined)
        return applied;
    if (Object.keys(closed.occurrence.notices ?? {}).length === 0)
        return applied;
    const atMs = Date.parse(closed.occurrence.at);
    const notice = closedNotice(board.schedules, board.topics, {
        series: closed.occurrence.series,
        key: closed.key,
        atMs,
        outcome: closed.outcome,
    });
    return { ...applied, scheduleNotices: [notice] };
}
/**
 * Runs one operation and saves what it changed. The page's requests are the
 * captain's, the socket's the agent side's; each channel may run only its own
 * operations.
 */
export function applyOperation(target, board, request, who) {
    const operation = operationOf(request.op);
    if (operation === undefined)
        return answer(board, { ok: false, code: "usage", line: `不認得的 op：${request.op}` });
    const problem = channelProblem(request.op, operation, request.fromPage);
    if (problem !== null)
        return answer(board, refused(problem));
    const by = request.fromPage ? "captain" : "aggregator";
    const ctx = {
        topics: board.topics,
        todos: board.todos,
        confirmations: board.confirmations,
        hashtags: board.hashtags,
        schedules: board.schedules,
        lifecycle: board.lifecycle,
        by,
        ...who,
    };
    const actor = { by, label: who.label };
    const blocked = transitionProblem(request.op, ctx, request.args);
    if (blocked !== null)
        return answer(board, refused(blocked));
    return runOperation(target, board, request, { actor, operation, ctx });
}
/** Runs an operation the channel and the card's state allow, and saves it through its commit file. */
function runOperation(target, board, request, run) {
    const { actor, operation, ctx } = run;
    if (operation.commitFile === "topics")
        return runTopicOp(target, board, request, actor, { operation, ctx });
    if (operation.commitFile === "hashtags")
        return applyHashtagOp(target, board, request, actor, operation.run(ctx, request.args));
    if (operation.commitFile === "confirmations")
        return applyConfirmOp(target, board, request, actor, operation.run(ctx, request.args));
    if (operation.commitFile === "schedules")
        return applyScheduleOp(target, board, request, actor, operation.run(ctx, request.args));
    if (operation.commitFile === "lifecycle")
        return applyLifecycleOp(target, board, actor, operation.run(ctx, request.args));
    return applyTodoOp(target, board, request, actor, operation.run(ctx, request.args));
}
