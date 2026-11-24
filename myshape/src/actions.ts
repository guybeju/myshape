// The four things the captain can send from the board, checked and turned into
// writes. The socket's test ops and the browser API both come through here.
import type { Frozen } from "./records.js";
import crypto from "node:crypto";
import { directTextProblem } from "./commands.js";
import type { HomeReport, ReportHold } from "./report.js";
import { MAIN_HOME } from "./journal.js";
import { resolveTopicId } from "./topics.js";
import type { TopicState } from "./topics.js";
import { answerOutcome, placeTask } from "./view.js";
import type { HomeSnapshot } from "./view.js";
import type { TopicRef, WriteEngine, WriteRecord } from "./writes.js";

export interface ActionContext {
  topics: Frozen<TopicState>;
  /** Every home the board reads: the root home and the further homes its report lists. */
  homes: HomeSnapshot[];
  writes: WriteEngine;
}

export type ActionResult = { ok: true; write: WriteRecord } | { ok: false; line: string };
export type Channel = WriteRecord["channel"];

const TASK_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const MESSAGE_MAX = 4000;
const ANSWER_MAX = 1000;

function refuse(line: string): ActionResult {
  return { ok: false, line };
}

function topicName(topics: Frozen<TopicState>, id: string): string | null {
  return topics.doc.topics[id]?.name ?? topics.archive.topics[id]?.name ?? null;
}

function lengthOf(text: string): number {
  return [...text].length;
}

/** A message from a topic page to the agent on the other side. */
export function message(
  context: ActionContext,
  rawTopic: string,
  text: string,
  channel: Channel,
): ActionResult {
  const topic = resolveTopicId(context.topics.doc, rawTopic);
  const name = topicName(context.topics, topic);
  if (name === null) return refuse(`沒有 ${rawTopic} 這個議題。`);
  const body = text.trim();
  if (body === "" || lengthOf(body) > MESSAGE_MAX)
    return refuse(`訊息要有內容，而且最多 ${MESSAGE_MAX} 個字。`);
  return {
    ok: true,
    write: context.writes.submit({
      channel,
      home: MAIN_HOME,
      task: null,
      topic,
      text: body,
      action: { kind: "message", topic: { id: topic, name }, text: body },
    }),
  };
}

/** Checks the home and task every agent-directed action names; null when both are fine. */
function agentTarget(context: ActionContext, home: string, task: string): ActionResult | null {
  if (!context.homes.some((entry) => entry.id === home)) return refuse(`不認得 home ${home}。`);
  return TASK_ID.test(task) ? null : refuse(`task id 格式不對：${task}`);
}

/** Why `text` cannot be sent to an agent, or null when it can. */
function directProblem(text: string): string | null {
  const problem = directTextProblem(text);
  if (problem !== null) return problem;
  return lengthOf(text) > MESSAGE_MAX ? `訊息最多 ${MESSAGE_MAX} 個字。` : null;
}

/** A message straight to one agent of one home. */
export function direct(
  context: ActionContext,
  home: string,
  task: string,
  text: string,
  channel: Channel,
): ActionResult {
  const target = agentTarget(context, home, task);
  if (target !== null) return target;
  const problem = directProblem(text);
  if (problem !== null) return refuse(problem);
  const topic = placeTask(context.topics, context.homes, home, task).topic;
  const action = { kind: "direct" as const, home, task, text };
  return { ok: true, write: context.writes.submit({ channel, home, task, topic, text, action }) };
}

export interface AnswerInput {
  home: string;
  task: string;
  answer: string;
  label: string;
}

function oneLineProblem(what: string, text: string): string | null {
  if (text.trim() === "" || lengthOf(text) > ANSWER_MAX)
    return `${what}要有內容，而且最多 ${ANSWER_MAX} 個字。`;
  return /[\t\r\n]/.test(text) ? `${what}只能有一行，而且不能有 tab。` : null;
}

/** What `home` last reported, or null when the board has no report for it. */
function reportOf(context: ActionContext, home: string): HomeReport | null {
  const snapshot = context.homes.find((entry) => entry.id === home);
  return snapshot === undefined ? null : snapshot.report;
}

/** The captain hold on `task` in `home`, as last reported. */
export function findHold(
  context: ActionContext,
  home: string,
  task: string,
): ReportHold | undefined {
  const report = reportOf(context, home);
  return report === null ? undefined : report.holds.find((entry) => entry.id === task);
}

/** The name to show for a topic id; "未分類" when there is none. */
function topicLabel(topics: Frozen<TopicState>, topic: string | null): string {
  if (topic === null) return "未分類";
  const name = topicName(topics, topic);
  return name === null ? topic : name;
}

function topicRef(topics: Frozen<TopicState>, topic: string | null): TopicRef | null {
  return topic === null ? null : { id: topic, name: topicLabel(topics, topic) };
}

/** The last line of a task's tag file as its home last reported it. */
function lastTagLine(context: ActionContext, home: string, task: string): string {
  const report = reportOf(context, home);
  const tags = report === null ? undefined : report.topics[task];
  if (tags === undefined) return "";
  const lines = tags.trimEnd().split("\n");
  return lines[lines.length - 1] as string;
}

/** The topic a hold belongs to: its own task's, else its origin task's, else none. */
function holdTopic(
  context: ActionContext,
  home: string,
  task: string,
  origin: string,
): string | null {
  const own = placeTask(context.topics, context.homes, home, task).topic;
  if (own !== null || origin === "") return own;
  return placeTask(context.topics, context.homes, home, origin).topic;
}

/** The mode an answer carries for what answering `hold` does: close the item or let it go on. */
export function answerMode(hold: ReportHold): "done" | "release" {
  return answerOutcome(hold).on_answer === "close" ? "done" : "release";
}

/** An answer to a waiting decision, closing or releasing it as the decision recorded. */
export function answer(context: ActionContext, input: AnswerInput, channel: Channel): ActionResult {
  const target = agentTarget(context, input.home, input.task);
  if (target !== null) return target;
  const hold = findHold(context, input.home, input.task);
  if (hold === undefined)
    return refuse(`${input.home}/${input.task} 沒有等你回答的待決事項（可能已經有人答了）。`);
  const answerProblem = oneLineProblem("答案", input.answer);
  if (answerProblem !== null) return refuse(answerProblem);
  const labelProblem = oneLineProblem("選項", input.label);
  if (labelProblem !== null) return refuse(labelProblem);
  const topic = holdTopic(context, input.home, input.task, hold.origin);
  return {
    ok: true,
    write: context.writes.submit({
      channel,
      home: input.home,
      task: input.task,
      topic,
      text: input.answer,
      action: {
        kind: "answer",
        home: input.home,
        task: input.task,
        answer: input.answer,
        label: input.label,
        mode: answerMode(hold),
        question_sha256: crypto.createHash("sha256").update(hold.question).digest("hex"),
        topic: topicRef(context.topics, topic),
      },
    }),
  };
}

/** Files an agent under a live topic by tagging its task in the home it lives in. */
export function tagAgent(
  context: ActionContext,
  home: string,
  task: string,
  rawTopic: string,
  channel: Channel,
): ActionResult {
  const target = agentTarget(context, home, task);
  if (target !== null) return target;
  const topic = resolveTopicId(context.topics.doc, rawTopic);
  if (context.topics.doc.topics[topic] === undefined)
    return refuse(`${rawTopic} 不是看板上還開著的議題。`);
  return {
    ok: true,
    write: context.writes.submit({
      channel,
      home,
      task,
      topic,
      text: `歸到「${topicLabel(context.topics, topic)}」`,
      action: {
        kind: "tag",
        home,
        task,
        topic,
        last_tag_line: lastTagLine(context, home, task),
      },
    }),
  };
}
