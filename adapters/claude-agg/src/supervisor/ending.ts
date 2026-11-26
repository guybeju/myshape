// What the end of a worker session means for its task (plan sections 4.4 to
// 4.6), as a pure function: the task's state and detail, the summary to write,
// whether the PR is ready, whether the worktree is cleaned up, and whether the
// quota stops dispatching.

import type { TaskState } from "#agg/state-files.js";

import type { SummaryKind } from "./commands.js";
import { parseWorkerOutput } from "./outputs.js";
import type { SessionEnd } from "./session.js";
import { WORKER_MAX_TURNS } from "./session-options.js";

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
}

export const TEXT = {
  ready: "PR 就緒，等合併",
  reported: "做完了",
  failed: "worker 說沒有做成",
  invalid: "worker 沒有交回合格的結果。",
  maxTurns: `worker 用完了 ${WORKER_MAX_TURNS} 輪還沒做完。`,
  quota: "額度用盡或被限流，等恢復後接著做",
  untreated: "worker 交回了問題或要你動手的事；這一版還不處理，worktree 留著。",
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
  };
}

function fromOutput(value: unknown): Ending {
  const output = parseWorkerOutput(value);
  if (output === undefined) return failed(TEXT.invalid);
  const untreated = output.question !== null || output.todos.length > 0;
  const summary = { kind: output.outcome, text: output.summary };
  let ending: Ending;
  if (output.outcome === "ready") {
    ending = {
      state: "done",
      text: TEXT.ready,
      summary,
      prReady: output.pr_url,
      cleanUp: false,
      quota: null,
    };
  } else {
    const ok = output.outcome !== "failed";
    ending = {
      state: ok ? "done" : "failed",
      text: ok ? TEXT.reported : TEXT.failed,
      summary,
      prReady: null,
      cleanUp: true,
      quota: null,
    };
  }
  return untreated ? { ...ending, state: "blocked", text: TEXT.untreated, cleanUp: false } : ending;
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
      };
    case "error":
      return failed(TEXT.crashed(end.message));
  }
}
