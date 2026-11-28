// The structured outputs a worker and the planner hand back (plan sections
// 4.2 and 4.5), parsed once where they come in. Anything that does not match
// is not used: a worker's becomes 「worker 沒有交回合格的結果」.

import {
  HASHTAG_ASK_CHANGES,
  HASHTAG_ASKED_MAX,
  HASHTAG_ASKS_MAX,
  SUMMARY_MAX,
} from "./session-options.js";

export interface Question {
  title: string;
  text: string;
  options: string[];
}

export interface Todo {
  id: string;
  title: string;
  do: string;
  cmds: string[];
}

export type WorkerOutput = {
  summary: string;
  todos: Todo[];
  question: Question | null;
} & ({ outcome: "ready"; pr_url: string } | { outcome: "report" | "failed" | "landed" });

export interface PlannedWork {
  title: string;
  repo: string;
  kind: "ship" | "scout";
  prompt: string;
}

/** One hashtag change the planner asks for, its name as the model wrote it. */
export interface HashtagAsk {
  name: string;
  change: (typeof HASHTAG_ASK_CHANGES)[number];
}

export interface PlannerOutput {
  tasks: PlannedWork[];
  question: Question | null;
  nothing: boolean;
  hashtags: HashtagAsk[];
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max = Number.POSITIVE_INFINITY): value is string {
  return typeof value === "string" && value.trim() !== "" && [...value].length <= max;
}

function isTexts(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** An option the board can show as a button: one line, no ` | ` (contract C5). */
function isOption(value: string): boolean {
  return value.trim() !== "" && !/[\r\n]/.test(value) && !value.includes(" | ");
}

function parseQuestion(value: unknown): Question | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !isText(value["title"]) || !isText(value["text"])) return undefined;
  const { options } = value;
  if (!isTexts(options) || options.length < 2 || !options.every(isOption)) return undefined;
  return { title: value["title"], text: value["text"], options: options.map((o) => o.trim()) };
}

function parseTodo(value: unknown): Todo | undefined {
  if (!isRecord(value) || !isText(value["id"]) || !isText(value["title"])) return undefined;
  if (!isText(value["do"]) || !isTexts(value["cmds"])) return undefined;
  return { id: value["id"], title: value["title"], do: value["do"], cmds: value["cmds"] };
}

const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

/** A worker's output, or undefined when it is not one. */
export function parseWorkerOutput(value: unknown): WorkerOutput | undefined {
  if (!isRecord(value) || !isText(value["summary"], SUMMARY_MAX)) return undefined;
  const question = parseQuestion(value["question"]);
  const rawTodos = value["todos"];
  if (question === undefined || !Array.isArray(rawTodos)) return undefined;
  const todos = rawTodos.map(parseTodo);
  if (todos.some((todo) => todo === undefined)) return undefined;
  const base = { summary: value["summary"], todos: todos as Todo[], question };
  const { outcome, pr_url: url } = value;
  if (outcome === "ready") {
    return typeof url === "string" && PR_URL.test(url)
      ? { ...base, outcome, pr_url: url }
      : undefined;
  }
  if (outcome === "report" || outcome === "failed" || outcome === "landed") {
    return { ...base, outcome };
  }
  return undefined;
}

function parseWork(value: unknown): PlannedWork | undefined {
  if (!isRecord(value) || !isText(value["title"], 200) || !isText(value["repo"])) return undefined;
  const { kind } = value;
  if ((kind !== "ship" && kind !== "scout") || !isText(value["prompt"])) return undefined;
  return { title: value["title"], repo: value["repo"], kind, prompt: value["prompt"] };
}

/**
 * One change of the schema's shape: exactly `name` and `change`. Only the
 * shape is checked here; whether the name is a hashtag name is the
 * supervisor's to decide, so one bad name never voids the whole plan.
 */
function parseHashtagAsk(value: unknown): HashtagAsk | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 2) return undefined;
  const { name } = value;
  const change = HASHTAG_ASK_CHANGES.find((candidate) => candidate === value["change"]);
  if (typeof name !== "string" || name === "" || change === undefined) return undefined;
  return [...name].length <= HASHTAG_ASKED_MAX ? { name, change } : undefined;
}

function parseHashtagAsks(value: unknown): HashtagAsk[] | undefined {
  if (!Array.isArray(value) || value.length > HASHTAG_ASKS_MAX) return undefined;
  const asks = value.map(parseHashtagAsk);
  return asks.some((ask) => ask === undefined) ? undefined : (asks as HashtagAsk[]);
}

/** The planner's output, or undefined when it is not one. */
export function parsePlannerOutput(value: unknown): PlannerOutput | undefined {
  if (!isRecord(value) || !Array.isArray(value["tasks"])) return undefined;
  const question = parseQuestion(value["question"]);
  if (question === undefined || typeof value["nothing"] !== "boolean") return undefined;
  const hashtags = parseHashtagAsks(value["hashtags"]);
  const tasks = value["tasks"].map(parseWork);
  if (hashtags === undefined || tasks.some((task) => task === undefined)) return undefined;
  return { tasks: tasks as PlannedWork[], question, nothing: value["nothing"], hashtags };
}
