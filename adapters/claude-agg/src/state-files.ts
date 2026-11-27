/**
 * The formats of claude-agg's state under `$MYSHAPE_HOME/agg/`, as
 * `spec/state-files.markdown` defines them. The supervisor writes `tasks.json`,
 * `holds.json`, `queued.json` and `ledger.jsonl`; `bin/agg-board.mjs` reads
 * them and writes only inbox files, answer files and appended tag lines.
 */

/** The directory under the board home that holds every file below. */
export const AGG_DIR = "agg";

/** A task's state. The board's lights: working and paused are in progress,
 * blocked and failed are stuck, done is done. */
export type TaskState = "working" | "paused" | "blocked" | "failed" | "done";

/** One task the supervisor runs, keyed by its task id in `tasks.json`. */
export interface TaskEntry {
  /** Any word but `secondmate`; `ship` for a task that opens a pull request. */
  kind: string;
  state: TaskState;
  detail?: string;
  unstarted?: boolean;
  title?: string;
  repo?: string;
  session_id?: string;
  worktree?: string;
  branch?: string;
  pr_url?: string | null;
  /** The model the worker's session named in its start message. */
  model?: string;
  cost_usd_estimate?: number;
}

/** `tasks.json`. */
export interface TasksFile {
  v: 1;
  tasks: Record<string, TaskEntry>;
}

/** One decision the supervisor waits on, keyed by the id of the task it stops. */
export interface HoldEntry {
  state: "open" | "closed";
  title: string;
  /** The full question; its last line is `選項：A | B` when it has options. */
  question: string;
  on_answer: "close" | "release";
  /** The UTC ISO time the hold opened. */
  hold_set: string;
  origin?: string;
  hold_bucket?: "live" | "aged" | "dated" | "blocked";
  hold_until?: string | null;
  unresolved_blocker_ids?: string[];
}

/** `holds.json`. */
export interface HoldsFile {
  v: 1;
  holds: Record<string, HoldEntry>;
}

/** One planned task not started yet. */
export interface QueuedEntry {
  id: string;
  kind: string;
  title: string;
  hold?: string | null;
  captain?: boolean;
  blockers?: string[];
  topic_hint?: string | null;
  /** When a dated wait ends (a date or a UTC time). */
  hold_until?: string | null;
  /** True when the supervisor starts the item by itself once a place frees. */
  turn?: boolean;
}

/** `queued.json`; the array order is the dispatch order. */
export interface QueuedFile {
  v: 1;
  queued: QueuedEntry[];
}

/** The events the board knows, one per line of `ledger.jsonl`. */
export type LedgerEvent =
  | { v: 1; ts: number; event: "task.dispatched"; task: string; kind?: string }
  | { v: 1; ts: number; event: "task.status"; task: string; state: TaskState; text: string }
  | { v: 1; ts: number; event: "task.pr_ready"; task: string; pr: string }
  | { v: 1; ts: number; event: "task.merged"; task: string; pr: string }
  | { v: 1; ts: number; event: "task.cleaned_up"; task: string };

/** A topic as an action record names it. */
export interface TopicRef {
  id: string;
  name: string;
}

/** An action record as the board hands it to `deliver` (contract section 7.1). */
export type ActionRecord = { v: 1; id: string; attempt: number } & (
  | { kind: "message"; topic: TopicRef; text: string }
  | { kind: "direct"; home: string; task: string; text: string }
  | {
      kind: "answer";
      home: string;
      task: string;
      answer: string;
      label: string;
      mode: "done" | "release";
      question_sha256: string;
      topic: TopicRef | null;
    }
  | { kind: "tag"; home: string; task: string; topic: string; last_tag_line: string }
  | { kind: "notice"; event: string; text: string; [field: string]: unknown }
);

/** `inbox/<write-id>.json` and `answers/<task-id>.json`. */
export interface LandedRecord {
  v: 1;
  /** When `deliver` landed it, in epoch milliseconds: the order to handle inbox files in. */
  received_ms: number;
  record: ActionRecord;
}
