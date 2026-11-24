// What the page remembers between renders, and the actions its buttons call.
import type { Queue } from "#board/topics.js";
import type { BoardView } from "#board/view.js";

export interface WriteView {
  id: string;
  kind: "message" | "direct" | "answer" | "tag" | "notice";
  home: string;
  task: string | null;
  topic: string | null;
  text: string;
  state: string;
  error: string | null;
  attempt: number;
  next_at: number | null;
  created_at: number;
}

/** A program the board runs only after the captain confirms it on the page. */
export interface ProgramView {
  path: string;
  sha256: string;
  roles: ("feed" | "deliver")[];
}

/** Who is on the other side of the board, and whether the board can reach it. */
export interface AggregatorView {
  connected: boolean;
  /** Why the board cannot reach it right now, or null. */
  unavailable: string | null;
  /** The binding file's aggregator and program paths, when it can be read. */
  binding: { name: string; feed: string; deliver: string } | null;
  /** The programs waiting for the captain's confirmation. */
  confirm: ProgramView[];
  name: string | null;
  label: string;
  update_hint: string | null;
}

export type View = BoardView & {
  boot_id: string;
  /** The service's code; a page loaded with other code reloads itself. */
  code_commit: string;
  aggregator: AggregatorView;
  version: string;
  polling: boolean;
  writes: WriteView[];
};

/** The first half of a two-step action, waiting for the captain to confirm. */
export interface Pending {
  path: string;
  body: Record<string, unknown>;
  confirm: string;
  expiresAt: number;
}

export interface Page {
  view: View | null;
  /** The board stopped answering; the view on screen is the last one received. */
  down: boolean;
  tokenBad: boolean;
  /** Text typed into inputs, by input key, so a re-render does not lose it. */
  drafts: Map<string, string>;
  pending: Map<string, Pending>;
  /** Fields being edited in place: "name:<topic>" or "goal:<topic>". */
  editing: Set<string>;
  /** Which small panel is open on the topic page: the menu, or one of its two questions. */
  panel: "menu" | "archive" | "merge" | null;
  /** The last refusal from the board, shown until the next action. */
  notice: string | null;
}

export interface Actions {
  open: (topic: string | null) => void;
  refresh: () => void;
  draft: (key: string, value: string) => void;
  setPanel: (panel: Page["panel"]) => void;
  edit: (key: string, on: boolean) => void;
  topic: (op: string, body: Record<string, unknown>) => void;
  move: (topic: string, queue: Queue, before: string | null) => void;
  /** Asks the board for a confirmation code; the action runs when `confirm` is called with the same key. */
  ask: (key: string, path: string, body: Record<string, unknown>) => void;
  confirm: (key: string) => void;
  cancel: (key: string) => void;
  /** Says a hands-on item is done; the agent checks before it is closed. */
  claim: (task: string) => void;
  message: (topic: string, key: string) => void;
  direct: (home: string, task: string, key: string) => void;
  tag: (home: string, task: string, topic: string) => void;
  resend: (write: WriteView) => void;
  ignore: (write: WriteView) => void;
}

/** The queues in display order. Kept here because page scripts cannot load modules outside dist/page. */
export const QUEUES: readonly Queue[] = ["high", "normal", "later"];
export const QUEUE_LABEL: Record<Queue, string> = { high: "高", normal: "一般", later: "待辦" };
export const LIGHT_LABEL: Record<string, string> = {
  decide: "待你決定",
  stuck: "卡住",
  working: "進行中",
  done: "完成",
  unknown: "未知",
};
export const WRITE_LABEL: Record<string, string> = {
  waiting: "等 aggregator 接上",
  sending: "送出中",
  retrying: "重試中",
  delivered: "已送達",
  handled_elsewhere: "已由別處處理",
  failed: "失敗",
  undelivered: "未送達",
  unknown: "結果不明",
  ignored: "已忽略",
};
export const BAD_WRITES = ["failed", "undelivered", "unknown"];

let label = "aggregator";

/** Remembers the name the board gave the agent side; called with every view. */
export function setAgentLabel(value: string): void {
  label = value;
}

/** The name the page uses for the agent on the other side. */
export function agentName(): string {
  return label;
}

export function currentTopic(): string | null {
  const match = /^#\/topic\/(.+)$/.exec(location.hash);
  return match === null ? null : decodeURIComponent(match[1] as string);
}
