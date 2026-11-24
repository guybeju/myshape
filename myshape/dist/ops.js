// Every operation that changes the board, in one table: which channel may run
// it, which file commits it, and how its arguments become a change. The
// socket and the page both run operations only through applyOperation, which
// saves each change with its records through store.ts commitChange.
import * as confirmations from "./confirmations.js";
import { stringField } from "./files.js";
import { commitChange } from "./store.js";
import * as topics from "./topics.js";
import * as todos from "./todos.js";
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
/** The `reason` argument: absent, a string, or null when it is something else. */
function optionalReason(args) {
    const reason = args["reason"];
    if (reason === undefined)
        return undefined;
    return typeof reason === "string" ? reason : null;
}
function create(ctx, args) {
    const name = stringField(args, "name");
    const goal = stringField(args, "goal");
    const queue = optionalQueue(args);
    const id = args["id"];
    if (name === null || goal === null)
        return { usage: "create 需要名稱與 --goal。" };
    if (queue === null)
        return { usage: "--queue 只能是 high、normal、later。" };
    if (id !== undefined && typeof id !== "string")
        return { usage: "--id 要是字串。" };
    const input = {
        name,
        goal,
        ...(id === undefined ? {} : { id }),
        ...(queue === undefined ? {} : { queue }),
    };
    return topics.create(ctx.topics, input, ctx.now);
}
function merge(ctx, args) {
    const from = stringField(args, "from");
    const into = stringField(args, "into");
    const reason = optionalReason(args);
    if (from === null || into === null)
        return { usage: "merge 需要兩個議題 id。" };
    if (reason === null)
        return { usage: "--reason 要是一行文字。" };
    return topics.merge(ctx.topics, from, into, ctx.now, reason);
}
function move(ctx, args) {
    const id = stringField(args, "id");
    const queue = optionalQueue(args);
    const position = movePosition(args);
    if (id === null || queue === null || queue === undefined || position === null) {
        return { usage: "move 需要議題 id 與佇列（high、normal、later）。" };
    }
    return topics.move(ctx.topics, id, queue, position, ctx.now);
}
/** What a split asks for, or why it is malformed. */
function splitInput(args) {
    const from = stringField(args, "from");
    const name = stringField(args, "name");
    const goal = stringField(args, "goal");
    const id = args["id"];
    const reason = optionalReason(args);
    if (from === null || name === null || goal === null)
        return { usage: "split 需要來源議題、新名稱與 --goal。" };
    if (id !== undefined && typeof id !== "string")
        return { usage: "--id 要是字串。" };
    if (reason === null)
        return { usage: "--reason 要是一行文字。" };
    return {
        from,
        name,
        goal,
        ...(id === undefined ? {} : { id }),
        ...(reason === undefined ? {} : { reason }),
    };
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
/**
 * Every operation that changes the board. A hands-on operation commits
 * through todos.json, every other one through topics.json (store.ts).
 */
export const OPERATIONS = {
    create: { channel: "socket", commitFile: "topics", run: create },
    merge: { channel: "both", commitFile: "topics", run: merge },
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
    split: { channel: "socket", commitFile: "topics", run: split },
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
    },
    keep: {
        channel: "page",
        commitFile: "topics",
        run: (ctx, args) => {
            const id = stringField(args, "id");
            return id === null ? { usage: "keep 需要議題 id。" } : topics.keepOpen(ctx.topics, id);
        },
    },
    reopen: {
        channel: "both",
        commitFile: "topics",
        run: (ctx, args) => {
            const id = stringField(args, "id");
            const queue = optionalQueue(args);
            if (id === null || queue === null)
                return { usage: "reopen 需要議題 id。" };
            return topics.reopen(ctx.topics, id, queue, ctx.now);
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
        committed: change.file,
        records: saved.records,
        appendError: saved.appendError,
    };
}
function applyTopicOp(target, board, request, actor, result) {
    if (!result.ok)
        return answer(board, refused(result.line));
    if (!result.changed) {
        assertUnchanged(request.op, board.topics, result.state);
        return answer(board, { ok: true, line: result.line });
    }
    const recorded = board.topics.doc.history.length;
    const stamped = topics.stampHistory(result, recorded, request.fromPage ? "page" : "command");
    const suffix = request.fromPage ? "你在頁面上" : `${actor.label} 用指令`;
    const change = {
        file: "topics",
        next: stamped.state,
        records: withSuffix(stamped.records, suffix),
    };
    return {
        ...commit(target, board, change, actor, stamped.line),
        dispatchable: stamped.dispatchable,
        decisions: request.fromPage ? decisionNotices(stamped.records) : [],
    };
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
    const ctx = {
        topics: board.topics,
        todos: board.todos,
        confirmations: board.confirmations,
        ...who,
    };
    const actor = { by: request.fromPage ? "captain" : "aggregator", label: who.label };
    if (operation.commitFile === "topics") {
        const result = operation.run(ctx, request.args);
        if ("usage" in result)
            return answer(board, { ok: false, code: "usage", line: result.usage });
        return applyTopicOp(target, board, request, actor, result);
    }
    if (operation.commitFile === "confirmations")
        return applyConfirmOp(target, board, request, actor, operation.run(ctx, request.args));
    return applyTodoOp(target, board, request, actor, operation.run(ctx, request.args));
}
