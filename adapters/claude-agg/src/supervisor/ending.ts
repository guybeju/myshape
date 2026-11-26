// What the end of a worker session means for its task (plan sections 4.4 to
// 4.6), as a pure function: the task's state and detail, the summary to write,
// whether the PR is ready, whether the worktree is cleaned up, whether the
// quota stops dispatching, the hold a question opens and what happens to the
// task's 要你動手 items.

import type { TaskState } from "#agg/state-files.js";

import type { SummaryKind } from "./commands.js";
import { parseWorkerOutput, type Question, type Todo, type WorkerOutput } from "./outputs.js";
import type { SessionEnd } from "./session.js";
import { WORKER_MAX_TURNS } from "./session-options.js";
import { oneLine, TITLE_MAX } from "./todos.js";

/** A hold to open on the task: `close` for a question only, `release` for one that stops the work. */
export interface HoldRequest {
  title: string;
  /** The question's full text; its last line is 選項：A | B (contract C5). */
  question: string;
  onAnswer: "close" | "release";
}

/** What the session's end means for the task's items on the board. */
export type EndTodos =
  | { kind: "keep" }
  | { kind: "sync"; todos: Todo[]; summary: string }
  | { kind: "drop" };

export interface Ending {
  state: TaskState;
  /** The task's detail and the text of its last `task.status` line. */
  text: string;
  summary: { kind: SummaryKind; text: string } | null;
  /** The pull request a `task.pr_ready` line names, or null. */
  prReady: string | null;
  /** Whether the worktree goes now (it stays while a PR waits, or for a resume). */
  cleanUp: boolean;
  /** Set when the quota or rate limit stopped the session. */
  quota: { resetsAtMs: number | null } | null;
  hold: HoldRequest | null;
  todos: EndTodos;
}

/** How the detail of a task waiting on the captain starts. */
export const TEXT_PREFIX = { question: "等 captain 決定：", todos: "等你動手：" } as const;

export const TEXT = {
  ready: "PR 就緒，等合併",
  reported: "做完了",
  failed: "worker 說沒有做成",
  invalid: "worker 沒有交回合格的結果。",
  maxTurns: `worker 用完了 ${WORKER_MAX_TURNS} 輪還沒做完。`,
  quota: "額度用盡或被限流，等恢復後接著做",
  question: (title: string) => `${TEXT_PREFIX.question}${title}`,
  todos: (count: number) => `${TEXT_PREFIX.todos}${count} 件`,
  crashed: (message: string) => `worker 意外結束：${message}`,
} as const;

function failed(text: string): Ending {
  return {
    state: "failed",
    text,
    summary: { kind: "failed", text },
    prReady: null,
    cleanUp: true,
    quota: null,
    hold: null,
    todos: { kind: "drop" },
  };
}

/** The hold a question opens: answered work goes on (`release`) unless the work is delivered. */
function holdFor(question: Question, outcome: WorkerOutput["outcome"]): HoldRequest {
  const delivered = outcome === "ready" || outcome === "landed";
  return {
    title: oneLine(question.title, TITLE_MAX),
    question: `${question.text.trim()}\n選項：${question.options.join(" | ")}`,
    onAnswer: delivered ? "close" : "release",
  };
}

/** The ending a valid output with a question or todos waits in instead. */
function waiting(ending: Ending, output: WorkerOutput): Ending {
  const hold = output.question === null ? null : holdFor(output.question, output.outcome);
  const withAsks = { ...ending, hold };
  if (hold?.onAnswer === "release") {
    return { ...withAsks, state: "blocked", text: TEXT.question(hold.title), cleanUp: false };
  }
  if (output.todos.length > 0) {
    return { ...withAsks, state: "blocked", text: TEXT.todos(output.todos.length), cleanUp: false };
  }
  return withAsks;
}

function fromOutput(value: unknown): Ending {
  const output = parseWorkerOutput(value);
  if (output === undefined) return failed(TEXT.invalid);
  const summary = { kind: output.outcome, text: output.summary };
  const asks = {
    quota: null,
    hold: null,
    todos: { kind: "sync", todos: output.todos, summary: output.summary },
  } as const;
  let ending: Ending;
  if (output.outcome === "ready") {
    ending = {
      state: "done",
      text: TEXT.ready,
      summary,
      prReady: output.pr_url,
      cleanUp: false,
      ...asks,
    };
  } else {
    const ok = output.outcome !== "failed";
    ending = {
      state: ok ? "done" : "failed",
      text: ok ? TEXT.reported : TEXT.failed,
      summary,
      prReady: null,
      cleanUp: true,
      ...asks,
    };
  }
  return waiting(ending, output);
}

/** What a worker session's end means for its task. */
export function endingOf(end: SessionEnd): Ending {
  switch (end.kind) {
    case "output":
      return fromOutput(end.output);
    case "refused":
      return failed(end.reason);
    case "max_turns":
      return failed(TEXT.maxTurns);
    case "quota":
      return {
        state: "paused",
        text: TEXT.quota,
        summary: null,
        prReady: null,
        cleanUp: false,
        quota: { resetsAtMs: end.resetsAtMs },
        hold: null,
        todos: { kind: "keep" },
      };
    case "error":
      return failed(TEXT.crashed(end.message));
  }
}
