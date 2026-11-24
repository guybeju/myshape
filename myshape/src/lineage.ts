// Looks up where a topic or task is now and how it got there, from the
// history kept in the topic file. Pure, and bounded: the answer is meant to be
// read by firstmate without filling its context. Asked for everything, it
// drops the bounds and prints exact times, for working out what went wrong.
import type { Frozen } from "./records.js";
import { QUEUES, resolveTopicId } from "./topics.js";
import type { HistoryEntry, TopicState } from "./topics.js";

const MAX_TOPICS = 5;
const MAX_HISTORY = 8;
const QUEUE_LABEL = { high: "高", normal: "一般", later: "待辦" } as const;

/** The tag file of one task: every topic it was tagged with, oldest first. */
export interface TaskTags {
  home: string;
  task: string;
  tags: { topic: string; atMs: number }[];
}

function nameOf(state: Frozen<TopicState>, id: string): string | null {
  return state.doc.topics[id]?.name ?? state.archive.topics[id]?.name ?? null;
}

/** Where a live topic sits now. */
function placeOf(state: Frozen<TopicState>, id: string): string {
  const queue = QUEUES.find((name) => state.doc.queues[name].includes(id));
  return queue === undefined ? "沒有排進佇列" : QUEUE_LABEL[queue];
}

function header(state: Frozen<TopicState>, id: string): string {
  const archived = state.archive.topics[id];
  if (archived !== undefined) return `${id}　${archived.name}（已封存）`;
  const topic = state.doc.topics[id];
  if (topic === undefined) return `${id}　（已不存在）`;
  return `${id}　${topic.name}（${placeOf(state, id)}）`;
}

/** The line for a merge, rename, or split, which name the topic the change started from. */
function describeMove(entry: HistoryEntry, kind: "merged" | "renamed" | "split"): string {
  const oldName = `「${entry.from_name ?? "？"}」`;
  const oldId = `（${entry.from ?? "？"}）`;
  if (kind === "renamed") return `${oldName}改名為「${entry.name}」`;
  if (kind === "merged") return `${oldName}${oldId}併入「${entry.name}」`;
  return `從${oldName}${oldId}拆出「${entry.name}」（${entry.topic}）`;
}

const ACTOR_LABEL = { page: "在頁面上", command: "用指令" } as const;

/** Who made the change and why, in brackets; empty when neither was recorded. */
function circumstances(entry: HistoryEntry): string {
  const parts = [
    ...(entry.by === undefined ? [] : [ACTOR_LABEL[entry.by]]),
    ...(entry.reason === undefined ? [] : [`原因：${entry.reason}`]),
  ];
  return parts.length === 0 ? "" : `（${parts.join("；")}）`;
}

function whatHappened(entry: HistoryEntry): string {
  switch (entry.kind) {
    case "archived":
      return "封存";
    case "reopened":
      return "重開";
    case "moved":
      return `移到「${entry.queue === undefined ? "？" : QUEUE_LABEL[entry.queue]}」第 ${entry.position ?? "？"}`;
    case "goal":
      return `目標改為「${entry.goal ?? "？"}」`;
    default:
      return describeMove(entry, entry.kind);
  }
}

function describe(entry: HistoryEntry, everything: boolean): string {
  const when = everything ? entry.at : entry.at.slice(0, 10);
  return `${when} ${whatHappened(entry)}${circumstances(entry)}`;
}

/** True when the entry is part of how `id` came to be what it is. */
function concerns(state: Frozen<TopicState>, entry: HistoryEntry, id: string): boolean {
  if (resolveTopicId(state.doc, entry.topic) === id) return true;
  return entry.from !== undefined && resolveTopicId(state.doc, entry.from) === id;
}

function matches(needle: string, ...texts: (string | undefined)[]): boolean {
  return texts.some((text) => text !== undefined && text.toLowerCase().includes(needle));
}

/** Current ids of every topic the query touches: by id, name, goal, an old id, or an old name. */
function matchingTopics(state: Frozen<TopicState>, needle: string): string[] {
  const found = new Set<string>();
  for (const topics of [state.doc.topics, state.archive.topics]) {
    for (const [id, topic] of Object.entries(topics)) {
      if (matches(needle, id, topic.name, topic.goal)) found.add(id);
    }
  }
  for (const old of Object.keys(state.doc.merged)) {
    if (matches(needle, old)) found.add(resolveTopicId(state.doc, old));
  }
  for (const entry of state.doc.history) {
    if (matches(needle, entry.name, entry.from_name))
      found.add(resolveTopicId(state.doc, entry.topic));
  }
  return [...found];
}

/** Moves and goal changes are listed only when everything is asked for, so they never crowd out a merge or a split. */
const DETAIL_KINDS = ["moved", "goal"];

function topicLines(state: Frozen<TopicState>, id: string, everything: boolean): string[] {
  const history = state.doc.history.filter(
    (entry) => concerns(state, entry, id) && (everything || !DETAIL_KINDS.includes(entry.kind)),
  );
  const recorded = new Set(
    history.filter((entry) => entry.kind === "merged").map((entry) => entry.from),
  );
  const unrecorded = Object.keys(state.doc.merged).filter(
    (old) => resolveTopicId(state.doc, old) === id && !recorded.has(old),
  );
  const shown = everything ? history : history.slice(-MAX_HISTORY);
  const older = history.length - shown.length;
  return [
    header(state, id),
    ...(older > 0 ? [`  還有 ${older} 筆更早的紀錄，加 --all 看全部`] : []),
    ...shown.map((entry) => `  ${describe(entry, everything)}`),
    ...unrecorded.map((old) => `  ${old} 併入這裡（沒有當時的紀錄）`),
  ];
}

function taskLine(state: Frozen<TopicState>, entry: TaskTags, everything: boolean): string {
  const steps = entry.tags.map((tag) => {
    const id = resolveTopicId(state.doc, tag.topic);
    const name = nameOf(state, id);
    if (name === null) return `${tag.topic}（不認得的議題）`;
    const at = new Date(tag.atMs).toISOString();
    const day = tag.atMs === 0 ? "時間不明" : everything ? at : at.slice(0, 10);
    return `${name}（${day}${tag.topic === id ? "" : `，原 ${tag.topic}`}）`;
  });
  const path = steps.length === 0 ? "沒有標過議題" : steps.join("→ ");
  return `task ${entry.home}/${entry.task}：${path}`;
}

/**
 * Answers "where is this now, and what happened to it" for a query.
 *
 * Args:
 *   state: The topics, their archive, and their history.
 *   query: Plain text matched, ignoring case, against topic ids, names, and
 *     goals, including ids and names that no longer exist.
 *   tasks: Tag files of the tasks whose id is the query, already looked up.
 *   everything: Print every matching topic and every history entry, with
 *     exact times, instead of the bounded answer.
 *
 * Returns:
 *   A few lines for firstmate: one per task, then each matching topic under
 *   its current id with its history. Never empty.
 */
export function findLines(
  state: Frozen<TopicState>,
  query: string,
  tasks: TaskTags[],
  everything = false,
): string[] {
  const needle = query.trim().toLowerCase();
  const ids = matchingTopics(state, needle);
  const shown = everything ? ids : ids.slice(0, MAX_TOPICS);
  const lines = [
    ...tasks.map((entry) => taskLine(state, entry, everything)),
    ...shown.flatMap((id) => topicLines(state, id, everything)),
  ];
  if (ids.length > shown.length)
    lines.push(`還有 ${ids.length - shown.length} 個議題符合，請用更長的關鍵字。`);
  return lines.length === 0 ? [`找不到「${query.trim()}」。`] : lines;
}
