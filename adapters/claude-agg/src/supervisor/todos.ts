// The 要你動手 items a worker asks for, as pure functions: its `todos` made
// into items within the board's limits (contract section 3.6), and what the
// supervisor runs on the board when the worker's session ends, given the
// items the board holds for that task now (plan section 4.4).

import type { TodoItem } from "./board-files.js";
import { clip, type BoardTodo } from "./commands.js";
import type { Todo } from "./outputs.js";

export const TITLE_MAX = 200;
export const DO_MAX = 1000;
export const CMDS_MAX = 50;
export const REASON_MAX = 200;
const ITEM_ID_MAX = 128;
const ITEM_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * `text` as one line the board takes: control, format and direction
 * characters and runs of white space become one space, a leading `-` (which
 * the board's command would read as a flag) goes, and it is cut to `max`.
 */
export function oneLine(text: string, max: number): string {
  const flat = text.replaceAll(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  return clip(flat.replace(/^-+\s*/, ""), max);
}

function itemId(task: string, own: string, index: number): string {
  const slug = own.replaceAll(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  const prefixed = slug.startsWith(`${task}-`) ? slug : `${task}-${slug || String(index + 1)}`;
  return prefixed.slice(0, ITEM_ID_MAX);
}

/**
 * The worker's todos as board items under `topic`, each with the task id as
 * its `ref`. An item id is namespaced under the task id, since item ids are
 * the whole board's; a second todo with the same id is left out.
 */
export function boardTodos(task: string, topic: string, todos: readonly Todo[]): BoardTodo[] {
  const items: BoardTodo[] = [];
  const seen = new Set<string>();
  todos.forEach((todo, index) => {
    const id = itemId(task, todo.id, index);
    if (seen.has(id) || !ITEM_ID.test(id)) return;
    seen.add(id);
    const title = oneLine(todo.title, TITLE_MAX) || id;
    items.push({
      id,
      title,
      topic,
      do: oneLine(todo.do, DO_MAX) || title,
      cmds: todo.cmds.filter((cmd) => cmd.trim() !== "").slice(0, CMDS_MAX),
      ref: task,
    });
  });
  return items;
}

/** What a session's end means for the task's items on the board. */
export type TodoChange =
  /** The session will go on (the quota stopped it): leave every item as it is. */
  | { kind: "keep" }
  /** The worker handed back a valid output listing these items as still needed. */
  | { kind: "sync"; wanted: readonly BoardTodo[]; summary: string }
  /** The task ended with no output the supervisor can use: nothing can be checked. */
  | { kind: "drop" };

export type TodoOp =
  | { op: "add"; item: BoardTodo }
  | { op: "done"; id: string }
  | { op: "failed"; id: string; reason: string }
  | { op: "obsolete"; id: string; reason: string };

export const TODO_REASON = {
  stillNeeded: (summary: string) => `worker 確認後說還沒好：${summary}`,
  notNeeded: "worker 不再需要這件事。",
  ended: "這個 task 結束了，不再需要。",
} as const;

/**
 * The board writes that bring `items` (the board's items whose ref is the
 * task) in line with `change`. An item the captain claimed is the worker's
 * to verify: still listed means not done (`failed` with the worker's
 * summary), no longer listed means done. Any other item no longer listed is
 * obsolete. Every listed item is added again, which the board takes as no
 * change when its text is the same.
 */
export function todoOps(items: ReadonlyMap<string, TodoItem>, change: TodoChange): TodoOp[] {
  if (change.kind === "keep") return [];
  const ops: TodoOp[] = [];
  if (change.kind === "drop") {
    for (const id of items.keys()) ops.push({ op: "obsolete", id, reason: TODO_REASON.ended });
    return ops;
  }
  const wanted = new Set(change.wanted.map((item) => item.id));
  const reason = oneLine(TODO_REASON.stillNeeded(change.summary), REASON_MAX);
  for (const [id, item] of items) {
    if (wanted.has(id)) {
      if (item.state === "claimed") ops.push({ op: "failed", id, reason });
    } else if (item.state === "claimed") {
      ops.push({ op: "done", id });
    } else {
      ops.push({ op: "obsolete", id, reason: TODO_REASON.notNeeded });
    }
  }
  for (const item of change.wanted) ops.push({ op: "add", item });
  return ops;
}
