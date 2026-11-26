// Readers for the board files the dispatch order needs, in one board home
// (myshape/spec/contracts.markdown sections 3.1, 3.8 and 3.9). A missing file
// reads as empty. A file that is not JSON, or whose top level is not the
// documented shape, is an error naming the file. Single entries the reader
// cannot use are skipped, as the contract tells every reader to do.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const QUEUES = ["high", "normal", "later"] as const;
export type Queue = (typeof QUEUES)[number];

export const RT_VALUES = ["hard-rt", "soft-rt", "none"] as const;
export type Rt = (typeof RT_VALUES)[number];

export const OCCURRENCE_STATES = ["upcoming", "due", "taken"] as const;
export type OccurrenceState = (typeof OCCURRENCE_STATES)[number];

export interface Topic {
  name: string;
  goal: string;
  created_at: string;
}

export interface TopicsFile {
  topics: ReadonlyMap<string, Topic>;
  queues: Readonly<Record<Queue, readonly string[]>>;
  /** Old id to new id; chains are possible. */
  merged: ReadonlyMap<string, string>;
  /** The topics that carry a close proposal (`close_proposal`) now. */
  proposed: ReadonlySet<string>;
}

/** The captain's hashtag settings (contract section 3.8), each at its default when missing or bad. */
export interface HashtagSettings {
  aggregator_may_tag: boolean;
  aggregator_may_create: boolean;
  per_topic_max: number;
  board_max: number;
  aggregator_hourly_max: number;
}

export const HASHTAG_DEFAULTS: HashtagSettings = {
  aggregator_may_tag: true,
  aggregator_may_create: true,
  per_topic_max: 8,
  board_max: 50,
  aggregator_hourly_max: 20,
};

const HASHTAG_RANGES = {
  per_topic_max: [1, 32],
  board_max: [1, 500],
  aggregator_hourly_max: [0, 1000],
} as const;

export interface HashtagsFile {
  /** Topic id (possibly a merged one) to its hashtags, in the order they were added. */
  topics: ReadonlyMap<string, readonly string[]>;
  /** A hashtag's stored spelling to its `key`, the form two spellings are compared in. */
  keys: ReadonlyMap<string, string>;
  /** The keys of the hashtags only the captain may put on or take off. */
  locked: ReadonlySet<string>;
  settings: HashtagSettings;
}

export interface Series {
  /** The topic id when the schedule was made; merges are not written back. */
  topic: string;
  rt: Rt;
  /**
   * Whether the board's clock sends its notices: the schedule is on,
   * nothing is all paused, and it is not an aggregator's waiting for the
   * captain's enable (contract section 3.9). An occurrence of a schedule
   * that does not ring gets no notice, so it gets no work either.
   */
  rings: boolean;
}

export interface Occurrence {
  series: string;
  at: string;
  atMs: number;
  state: OccurrenceState;
  closes_by: string;
  closesByMs: number;
}

export interface SchedulesFile {
  series: ReadonlyMap<string, Series>;
  occurrences: ReadonlyMap<string, Occurrence>;
}

export interface Board {
  topics: TopicsFile;
  /** Ids in data/topics-archive.json. */
  archived: ReadonlySet<string>;
  hashtags: HashtagsFile;
  schedules: SchedulesFile;
}

/** A board file that exists but cannot be read as the contract describes it. */
export class BoardFileError extends Error {
  constructor(path: string, problem: string) {
    super(`${path}: ${problem}`);
    this.name = "BoardFileError";
  }
}

type Json = Record<string, unknown>;

const TOPIC_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

/** Whether `id` follows the contract's topic id grammar (section 3.1). */
export function isTopicId(id: string): boolean {
  return TOPIC_ID.test(id);
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.find((candidate) => candidate === value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The file's top-level object, or undefined when the file does not exist. */
function readDocument(path: string): Json | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new BoardFileError(path, `cannot be read (${(error as Error).message})`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    throw new BoardFileError(path, `is not valid JSON (${(error as Error).message})`);
  }
  if (!isRecord(doc)) throw new BoardFileError(path, "is not a JSON object");
  if (doc["v"] !== undefined && doc["v"] !== 1) {
    throw new BoardFileError(path, `has version ${JSON.stringify(doc["v"])}; only v 1 is known`);
  }
  return doc;
}

/** A top-level object field: absent is empty, any other type is an error. */
function objectField(doc: Json, name: string, path: string): Json {
  const value = doc[name];
  if (value === undefined) return {};
  if (!isRecord(value)) throw new BoardFileError(path, `"${name}" is not an object`);
  return value;
}

function strings(values: readonly unknown[]): string[] {
  return values.filter((value): value is string => typeof value === "string");
}

function parseQueues(doc: Json, path: string): Record<Queue, string[]> {
  const queues = objectField(doc, "queues", path);
  const parsed: Record<Queue, string[]> = { high: [], normal: [], later: [] };
  for (const queue of QUEUES) {
    const value = queues[queue];
    if (value === undefined) continue;
    if (!Array.isArray(value)) throw new BoardFileError(path, `"queues.${queue}" is not an array`);
    parsed[queue] = strings(value);
  }
  return parsed;
}

/** data/topics.json: the topics not archived, the queues and the merges. */
export function readTopicsFile(path: string): TopicsFile {
  const doc = readDocument(path) ?? {};
  const topics = new Map<string, Topic>();
  const proposed = new Set<string>();
  for (const [id, raw] of Object.entries(objectField(doc, "topics", path))) {
    if (!isTopicId(id) || !isRecord(raw)) continue;
    topics.set(id, {
      name: text(raw["name"]),
      goal: text(raw["goal"]),
      created_at: text(raw["created_at"]),
    });
    if (isRecord(raw["close_proposal"])) proposed.add(id);
  }
  const merged = new Map<string, string>();
  for (const [from, to] of Object.entries(objectField(doc, "merged", path))) {
    if (typeof to === "string") merged.set(from, to);
  }
  return { topics, queues: parseQueues(doc, path), merged, proposed };
}

/** data/topics-archive.json: the ids of the archived topics. */
export function readArchiveFile(path: string): ReadonlySet<string> {
  const doc = readDocument(path) ?? {};
  return new Set(Object.keys(objectField(doc, "topics", path)).filter(isTopicId));
}

/** data/myshape/hashtags.json: each topic's hashtags and each hashtag's key. */
export function readHashtagsFile(path: string): HashtagsFile {
  const doc = readDocument(path) ?? {};
  const topics = new Map<string, readonly string[]>();
  for (const [id, names] of Object.entries(objectField(doc, "topics", path))) {
    if (Array.isArray(names)) topics.set(id, strings(names));
  }
  const keys = new Map<string, string>();
  const locked = new Set<string>();
  for (const [name, raw] of Object.entries(objectField(doc, "hashtags", path))) {
    if (!isRecord(raw) || typeof raw["key"] !== "string") continue;
    keys.set(name, raw["key"]);
    if (raw["locked"] === true) locked.add(raw["key"]);
  }
  return {
    topics,
    keys,
    locked,
    settings: parseHashtagSettings(objectField(doc, "settings", path)),
  };
}

function parseHashtagSettings(raw: Json): HashtagSettings {
  const settings: HashtagSettings = { ...HASHTAG_DEFAULTS };
  for (const name of ["aggregator_may_tag", "aggregator_may_create"] as const) {
    const value = raw[name];
    if (typeof value === "boolean") settings[name] = value;
  }
  for (const [name, [min, max]] of Object.entries(HASHTAG_RANGES) as [
    keyof typeof HASHTAG_RANGES,
    readonly [number, number],
  ][]) {
    const value = raw[name];
    if (Number.isInteger(value) && (value as number) >= min && (value as number) <= max) {
      settings[name] = value as number;
    }
  }
  return settings;
}

export const TODO_STATES = ["open", "claimed", "rejected", "obsolete"] as const;
export type TodoState = (typeof TODO_STATES)[number];

/** One item on the board's 要你動手 list, as the aggregator needs it. */
export interface TodoItem {
  state: TodoState;
  /** The text the aggregator gave with --ref: claude-agg gives the task id. */
  ref: string;
  title: string;
}

/** data/myshape/todos.json: the items still on the board, by item id. */
export function readTodosFile(path: string): ReadonlyMap<string, TodoItem> {
  const doc = readDocument(path) ?? {};
  const items = new Map<string, TodoItem>();
  for (const [id, raw] of Object.entries(objectField(doc, "items", path))) {
    if (!isRecord(raw)) continue;
    const state = oneOf(TODO_STATES, raw["state"]);
    if (state !== undefined) {
      items.set(id, { state, ref: text(raw["ref"]), title: text(raw["title"]) });
    }
  }
  return items;
}

/** The board's todos.json in the board home `home`. */
export function readTodos(home: string): ReadonlyMap<string, TodoItem> {
  return readTodosFile(join(home, "data", "myshape", "todos.json"));
}

function parseOccurrence(raw: unknown): Occurrence | undefined {
  if (!isRecord(raw)) return undefined;
  const state = oneOf(OCCURRENCE_STATES, raw["state"]);
  const { series, at } = raw;
  const closesBy = raw["closes_by"];
  if (state === undefined || typeof series !== "string") return undefined;
  if (typeof at !== "string" || typeof closesBy !== "string") return undefined;
  const atMs = Date.parse(at);
  const closesByMs = Date.parse(closesBy);
  if (Number.isNaN(atMs) || Number.isNaN(closesByMs)) return undefined;
  return { series, at, atMs, state, closes_by: closesBy, closesByMs };
}

function rings(raw: Json, settings: Json): boolean {
  if (raw["state"] === "paused" || settings["all_paused"] === true) return false;
  const waiting = raw["by"] === "aggregator" && raw["seen"] !== true;
  return !(waiting && settings["aggregator_needs_enable"] === true);
}

/** data/myshape/schedules.json: each schedule's topic, rt and whether it rings; the occurrences. */
export function readSchedulesFile(path: string): SchedulesFile {
  const doc = readDocument(path) ?? {};
  const settings = objectField(doc, "settings", path);
  const series = new Map<string, Series>();
  for (const [id, raw] of Object.entries(objectField(doc, "series", path))) {
    if (!isRecord(raw) || typeof raw["topic"] !== "string") continue;
    const rt = oneOf(RT_VALUES, raw["rt"]) ?? "none";
    series.set(id, { topic: raw["topic"], rt, rings: rings(raw, settings) });
  }
  const occurrences = new Map<string, Occurrence>();
  for (const [key, raw] of Object.entries(objectField(doc, "occurrences", path))) {
    const occurrence = parseOccurrence(raw);
    if (occurrence !== undefined) occurrences.set(key, occurrence);
  }
  return { series, occurrences };
}

/**
 * Whether data/myshape/summaries.jsonl in the board home `home` holds a
 * summary of this kind for this task of the root home (contract section 3.4).
 * A missing file holds none; a line that is not JSON is skipped.
 */
export function hasSummary(home: string, task: string, kind: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(join(home, "data", "myshape", "summaries.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  return raw.split("\n").some((line) => {
    try {
      const entry = JSON.parse(line) as unknown;
      return (
        isRecord(entry) &&
        entry["home"] === "main" &&
        entry["task"] === task &&
        entry["kind"] === kind
      );
    } catch {
      return false;
    }
  });
}

/** The four files of the board home `home`, as the dispatch order reads them. */
export function readBoard(home: string): Board {
  const data = join(home, "data");
  return {
    topics: readTopicsFile(join(data, "topics.json")),
    archived: readArchiveFile(join(data, "topics-archive.json")),
    hashtags: readHashtagsFile(join(data, "myshape", "hashtags.json")),
    schedules: readSchedulesFile(join(data, "myshape", "schedules.json")),
  };
}
