// Every operation that changes the board, in one table: which channel may run
// it, which file commits it, and how its arguments become a change. The
// socket and the page both run operations only through applyOperation, which
// saves each change with its records through store.ts commitChange.
import * as confirmations from "./confirmations.js";
import type { ConfirmResult, ConfirmationStore } from "./confirmations.js";
import { stringField } from "./files.js";
import type { BoardResponse } from "./protocol.js";
import type { Actor, Draft, Frozen, Records, StoredRecord } from "./records.js";
import { commitChange } from "./store.js";
import type { CommitFile, CommitTarget, StoredBoard } from "./store.js";
import * as topics from "./topics.js";
import type { MovePosition, Queue, TopicResult, TopicState } from "./topics.js";
import * as todos from "./todos.js";
import type { CloseWords, TodoNotice, TodoResult, TodoStore } from "./todos.js";
import type { NoticeEvent } from "./writes.js";

/** What an operation reads: the board as it is, who the agent side is, and the time. */
export interface OpContext {
  topics: Frozen<TopicState>;
  todos: Frozen<TodoStore>;
  confirmations: Frozen<ConfirmationStore>;
  /** The agent side's label, which its records and texts use. */
  label: string;
  /** The agent side's name, which a new item records as who put it there. */
  agent: string;
  now: string;
}

type Usage = { usage: string };

/** Who may run an operation: the agent side over the socket, the captain on the page, or both. */
export type Channel = "socket" | "page" | "both";

interface TopicOperation {
  channel: Channel;
  commitFile: "topics";
  run: (ctx: OpContext, args: Record<string, unknown>) => TopicResult | Usage;
}

interface TodoOperation {
  channel: Channel;
  commitFile: "todos";
  /** A malformed hands-on request is a usage result, so it can name the field it lacks. */
  run: (ctx: OpContext, args: Record<string, unknown>) => TodoResult;
}

interface ConfirmOperation {
  channel: "page";
  commitFile: "confirmations";
  run: (ctx: OpContext, args: Record<string, unknown>) => ConfirmResult;
}

export type Operation = TopicOperation | TodoOperation | ConfirmOperation;

function optionalQueue(args: Record<string, unknown>): Queue | undefined | null {
  const value = args["queue"];
  if (value === undefined) return undefined;
  return topics.isQueue(value) ? value : null;
}

function movePosition(args: Record<string, unknown>): MovePosition | null {
  const before = args["before"];
  if (args["first"] === true) return before === undefined ? { first: true } : null;
  if (args["last"] === true) return before === undefined ? { last: true } : null;
  if (before === undefined) return undefined;
  return typeof before === "string" ? { before } : null;
}

/** The `reason` argument: absent, a string, or null when it is something else. */
function optionalReason(args: Record<string, unknown>): string | undefined | null {
  const reason = args["reason"];
  if (reason === undefined) return undefined;
  return typeof reason === "string" ? reason : null;
}

function create(ctx: OpContext, args: Record<string, unknown>): TopicResult | Usage {
  const name = stringField(args, "name");
  const goal = stringField(args, "goal");
  const queue = optionalQueue(args);
  const id = args["id"];
  if (name === null || goal === null) return { usage: "create 需要名稱與 --goal。" };
  if (queue === null) return { usage: "--queue 只能是 high、normal、later。" };
  if (id !== undefined && typeof id !== "string") return { usage: "--id 要是字串。" };
  const input = {
    name,
    goal,
    ...(id === undefined ? {} : { id }),
    ...(queue === undefined ? {} : { queue }),
  };
  return topics.create(ctx.topics, input, ctx.now);
}

function merge(ctx: OpContext, args: Record<string, unknown>): TopicResult | Usage {
  const from = stringField(args, "from");
  const into = stringField(args, "into");
  const reason = optionalReason(args);
  if (from === null || into === null) return { usage: "merge 需要兩個議題 id。" };
  if (reason === null) return { usage: "--reason 要是一行文字。" };
  return topics.merge(ctx.topics, from, into, ctx.now, reason);
}

function move(ctx: OpContext, args: Record<string, unknown>): TopicResult | Usage {
  const id = stringField(args, "id");
  const queue = optionalQueue(args);
  const position = movePosition(args);
  if (id === null || queue === null || queue === undefined || position === null) {
    return { usage: "move 需要議題 id 與佇列（high、normal、later）。" };
  }
  return topics.move(ctx.topics, id, queue, position, ctx.now);
}

/** What a split asks for, or why it is malformed. */
function splitInput(args: Record<string, unknown>): topics.SplitInput | Usage {
  const from = stringField(args, "from");
  const name = stringField(args, "name");
  const goal = stringField(args, "goal");
  const id = args["id"];
  const reason = optionalReason(args);
  if (from === null || name === null || goal === null)
    return { usage: "split 需要來源議題、新名稱與 --goal。" };
  if (id !== undefined && typeof id !== "string") return { usage: "--id 要是字串。" };
  if (reason === null) return { usage: "--reason 要是一行文字。" };
  return {
    from,
    name,
    goal,
    ...(id === undefined ? {} : { id }),
    ...(reason === undefined ? {} : { reason }),
  };
}

function split(ctx: OpContext, args: Record<string, unknown>): TopicResult | Usage {
  const input = splitInput(args);
  if ("usage" in input) return input;
  const result = topics.split(ctx.topics, input, ctx.now);
  // --dry answers what the split would do, so the caller can check its tasks first.
  if (args["dry"] !== true || !result.ok) return result;
  return { ok: true, changed: false, state: ctx.topics, line: result.line };
}

/** An operation that takes a topic id and one line of text (rename, goal). */
function textOp(
  apply: typeof topics.rename,
  problem: string,
): (ctx: OpContext, args: Record<string, unknown>) => TopicResult | Usage {
  return (ctx, args) => {
    const id = stringField(args, "id");
    const value = stringField(args, "value");
    if (id === null || value === null) return { usage: problem };
    return apply(ctx.topics, id, value, ctx.now);
  };
}

function todoUsage(line: string): TodoResult {
  return { ok: false, code: "usage", line };
}

/** The optional parts of a `todo-add` request. */
function todoOptions(args: Record<string, unknown>) {
  return {
    guidance: typeof args["guidance"] === "string" ? args["guidance"] : "",
    ref: typeof args["ref"] === "string" ? args["ref"] : "",
    captainCloses: args["captain_closes"] === true,
  };
}

/** What a `todo-add` request asks for, or why it is malformed. */
function todoInput(args: Record<string, unknown>): todos.TodoInput | string {
  const commands = args["commands"];
  const topic = args["topic"];
  const id = stringField(args, "id");
  const title = stringField(args, "title");
  const action = stringField(args, "action");
  if (id === null || title === null || action === null)
    return "todo add 需要 task id、標題與 --do。";
  if (!Array.isArray(commands) || !commands.every((command) => typeof command === "string"))
    return "--cmd 要是文字。";
  if (topic !== null && typeof topic !== "string") return "--topic 要是議題 id。";
  return { id, title, topic, action, commands, ...todoOptions(args) };
}

/** The item id and one-line reason of a verdict, or why they are missing. */
function verdictArgs(args: Record<string, unknown>): { task: string; reason: string } | TodoResult {
  const task = stringField(args, "task");
  const reason = stringField(args, "reason");
  if (task === null) return todoUsage("需要 task id。");
  if (reason === null) return todoUsage("需要 --reason <一行>。");
  return { task, reason };
}

/** An operation on one item named by `task`. */
function onItem(
  apply: (ctx: OpContext, task: string) => TodoResult,
): (ctx: OpContext, args: Record<string, unknown>) => TodoResult {
  return (ctx, args) => {
    const task = stringField(args, "task");
    return task === null ? todoUsage("需要 task id。") : apply(ctx, task);
  };
}

/** The aggregator's verdict on an item, with its one-line reason. */
function verdict(
  apply: typeof todos.rejectItem,
): (ctx: OpContext, args: Record<string, unknown>) => TodoResult {
  return (ctx, args) => {
    const given = verdictArgs(args);
    if (!("task" in given)) return given;
    return apply(ctx.todos, given.task, given.reason, ctx.now, ctx.label);
  };
}

function closeByCaptain(
  words: CloseWords,
): (ctx: OpContext, args: Record<string, unknown>) => TodoResult {
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
      if (id === null || queue === null) return { usage: "reopen 需要議題 id。" };
      return topics.reopen(ctx.topics, id, queue, ctx.now);
    },
  },
  "todo-add": {
    channel: "socket",
    commitFile: "todos",
    run: (ctx, args) => {
      const input = todoInput(args);
      if (typeof input === "string") return todoUsage(input);
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
} satisfies Record<string, Operation>;

export type OperationName = keyof typeof OPERATIONS;

/** The operation called `name`, or undefined for anything else. */
export function operationOf(name: string): Operation | undefined {
  return Object.hasOwn(OPERATIONS, name) ? OPERATIONS[name as OperationName] : undefined;
}

/** One notice the page's press should send, before the board says who did it. */
export interface PageNotice {
  event: NoticeEvent;
  topic: string | null;
  line: string;
}

// Decisions the agent side is waiting on or has to act on. A reopening is
// left out: the dispatchable notice already covers it.
const DECISION_EVENTS: Partial<Record<string, NoticeEvent>> = {
  "topic.merged": "topic.merged",
  "topic.archived": "topic.archived",
  "topic.kept": "topic.kept",
};

/** What the captain just decided on the page, from the change's records; empty when none. */
function decisionNotices(records: readonly Draft[]): PageNotice[] {
  return records.flatMap((record) => {
    const event = DECISION_EVENTS[record.kind];
    if (event === undefined || record.topic === null) return [];
    return [{ event, topic: record.topic, line: `${record.text}（id：${record.topic}）` }];
  });
}

/** A request to run one operation, and from where. */
export interface OpRequest {
  op: string;
  args: Record<string, unknown>;
  fromPage: boolean;
}

/** What running an operation did; `board` is the board after it, the same one when nothing changed. */
export interface Applied {
  response: BoardResponse;
  board: StoredBoard;
  /** The commit file of the change, or null when nothing changed. */
  committed: CommitFile | null;
  records: StoredRecord[];
  appendError: string | null;
  dispatchable: string[];
  /** For the aggregator: the hands-on notices, and what the captain decided on the page. */
  notices: TodoNotice[];
  decisions: PageNotice[];
}

function answer(board: StoredBoard, response: BoardResponse): Applied {
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

function refused(line: string): BoardResponse {
  return { ok: false, code: "refused", line };
}

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

/** A result that says it changed nothing must hand back the state it was given. */
export function assertUnchanged(op: string, before: unknown, after: unknown): void {
  if (serialize(before) !== serialize(after))
    throw new Error(`${op} 說沒有改任何東西，卻回了不同的狀態`);
}

/** Each record of a change, saying whether it came from the page or a command. */
function withSuffix(records: Records, actor: string): Records {
  const [first, ...rest] = records.map((record) => ({
    ...record,
    text: `${record.text}（${actor}）`,
  }));
  return [first as Draft, ...rest];
}

function channelProblem(op: string, operation: Operation, fromPage: boolean): string | null {
  if (!fromPage && operation.channel === "page")
    return `${op} 是使用者在頁面上按的，不能從指令送。`;
  if (fromPage && operation.channel === "socket") return `${op} 只能從指令送。`;
  return null;
}

function commit(
  target: CommitTarget,
  board: StoredBoard,
  change: Parameters<typeof commitChange>[2],
  actor: Actor,
  line: string,
): Applied {
  const saved = commitChange(target, board, change, actor);
  if (!saved.ok) return answer(board, refused(saved.line));
  return {
    ...answer(saved.board, { ok: true, line }),
    committed: change.file,
    records: saved.records,
    appendError: saved.appendError,
  };
}

function applyTopicOp(
  target: CommitTarget,
  board: StoredBoard,
  request: OpRequest,
  actor: Actor,
  result: TopicResult,
): Applied {
  if (!result.ok) return answer(board, refused(result.line));
  if (!result.changed) {
    assertUnchanged(request.op, board.topics, result.state);
    return answer(board, { ok: true, line: result.line });
  }
  const recorded = board.topics.doc.history.length;
  const stamped = topics.stampHistory(result, recorded, request.fromPage ? "page" : "command");
  const suffix = request.fromPage ? "你在頁面上" : `${actor.label} 用指令`;
  const change = {
    file: "topics" as const,
    next: stamped.state,
    records: withSuffix(stamped.records, suffix),
  };
  return {
    ...commit(target, board, change, actor, stamped.line),
    dispatchable: stamped.dispatchable,
    decisions: request.fromPage ? decisionNotices(stamped.records) : [],
  };
}

function applyTodoOp(
  target: CommitTarget,
  board: StoredBoard,
  request: OpRequest,
  actor: Actor,
  result: TodoResult,
): Applied {
  if (!result.ok) return answer(board, { ok: false, code: result.code, line: result.line });
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
    file: "todos" as const,
    next: result.store,
    records: [first as Draft, ...rest] as Records,
  };
  return { ...commit(target, board, change, actor, result.line), notices: result.notices };
}

function applyConfirmOp(
  target: CommitTarget,
  board: StoredBoard,
  request: OpRequest,
  actor: Actor,
  result: ConfirmResult,
): Applied {
  if (!result.ok) return answer(board, { ok: false, code: result.code, line: result.line });
  if (!result.changed) {
    assertUnchanged(request.op, board.confirmations, result.store);
    return answer(board, { ok: true, line: result.line });
  }
  const change = {
    file: "confirmations" as const,
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
export function applyOperation(
  target: CommitTarget,
  board: StoredBoard,
  request: OpRequest,
  who: { label: string; agent: string; now: string },
): Applied {
  const operation = operationOf(request.op);
  if (operation === undefined)
    return answer(board, { ok: false, code: "usage", line: `不認得的 op：${request.op}` });
  const problem = channelProblem(request.op, operation, request.fromPage);
  if (problem !== null) return answer(board, refused(problem));
  const ctx: OpContext = {
    topics: board.topics,
    todos: board.todos,
    confirmations: board.confirmations,
    ...who,
  };
  const actor: Actor = { by: request.fromPage ? "captain" : "aggregator", label: who.label };
  if (operation.commitFile === "topics") {
    const result = operation.run(ctx, request.args);
    if ("usage" in result) return answer(board, { ok: false, code: "usage", line: result.usage });
    return applyTopicOp(target, board, request, actor, result);
  }
  if (operation.commitFile === "confirmations")
    return applyConfirmOp(target, board, request, actor, operation.run(ctx, request.args));
  return applyTodoOp(target, board, request, actor, operation.run(ctx, request.args));
}
