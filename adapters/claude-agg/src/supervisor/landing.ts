// Whether a topic's work has all landed, so the supervisor proposes closing
// it (plan section 4.4, 關閉提議), as a pure function. The captain decides on
// the page whether it closes.

import type { TaskEntry } from "#agg/state-files.js";

export interface TopicWork {
  /** The topic is on the board now (not archived, not merged away). */
  live: boolean;
  /** The topic already carries a close proposal. */
  proposed: boolean;
  /** The topic's tasks, by id. */
  tasks: ReadonlyMap<string, TaskEntry>;
  /** Tasks of the topic with an open hold. */
  held: ReadonlySet<string>;
  /** Anything still to come: a session running, a task queued, a message for the planner. */
  pending: boolean;
  /** The detail of a task whose pull request was closed without a merge. */
  closedDetail: string;
}

function landed(task: TaskEntry, closedDetail: string): boolean {
  return task.state === "done" && task.worktree === undefined && task.detail !== closedDetail;
}

/** The reason to give with close-propose, or undefined when the topic is not ready to close. */
export function closeReason(work: TopicWork): string | undefined {
  if (!work.live || work.proposed || work.pending || work.tasks.size === 0) return undefined;
  for (const [id, task] of work.tasks) {
    if (work.held.has(id) || !landed(task, work.closedDetail)) return undefined;
  }
  const ids = [...work.tasks.keys()].join("、");
  return `這個議題的 ${work.tasks.size} 個 task 都落地了（${ids}）。`;
}
