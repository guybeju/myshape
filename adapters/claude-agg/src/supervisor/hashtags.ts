// Putting one hashtag on a topic or taking it off (plan section 3.7, D11),
// guarded on the agent's own side before anything goes to the board: the
// name's grammar, the captain's settings (aggregator_may_tag,
// aggregator_may_create, per_topic_max, board_max, aggregator_hourly_max) and
// the lock, all read from data/myshape/hashtags.json, with the hourly count
// read from data/myshape/events.jsonl the way the board counts it. The change
// itself goes only through `bin/myshape.sh hashtag`, so the board records it
// `by: aggregator` and checks the same rules again. claude-agg never creates
// a topic or a schedule.
//
// Nothing calls this yet: which output may ask for a hashtag change waits for
// the board tag list's design. These guards are rails against a careless or
// misled caller, not a boundary: the board's socket checks no identity.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { readBoard, type HashtagsFile } from "./board-files.js";
import type { BoardCommand } from "./commands.js";
import { followMerges } from "./dispatch-order.js";

export const HOUR_SECONDS = 3600;
const NAME = /^[\p{L}\p{M}\p{N}_]{1,32}$/u;
const WATCHED = new Set(["hashtag.added", "hashtag.removed"]);

export type HashtagChange = "add" | "remove";

/** The form two spellings of a hashtag are compared in: NFKC, then lower case. */
export function hashtagKey(name: string): string {
  return name.normalize("NFKC").toLowerCase();
}

export interface HashtagSituation {
  hashtags: HashtagsFile;
  /** The topic's id, merges followed. */
  topic: string;
  /** Whether the topic is on the board now. */
  live: boolean;
  /** Old topic id to new, as data/topics.json has it. */
  merged: ReadonlyMap<string, string>;
  /** The aggregator's hashtag changes the board recorded in the last hour. */
  lastHour: number;
}

export type HashtagCheck =
  | { send: true }
  /** Nothing to send: `skip` when the topic already is that way, else refused. */
  | { send: false; skip: boolean; reason: string };

export const HASHTAG_REASON = {
  name: (name: string) => `#${name} 不是 hashtag 的名稱：只能是文字、數字與底線，1 到 32 個字。`,
  topic: (topic: string) => `議題 ${topic} 不在看板上。`,
  mayTag: "captain 在頁面上關掉了 aggregator 貼撕 hashtag。",
  locked: (name: string) => `#${name} 鎖上了，只有 captain 能在頁面上貼撕。`,
  hourly: (made: number, cap: number) => `一小時內已經改了 ${made} 次，上限是 ${cap} 次。`,
  already: (name: string) => `議題已經有 #${name}。`,
  absent: (name: string) => `議題沒有 #${name}。`,
  perTopic: (cap: number) => `議題已經有 ${cap} 個 hashtag，到上限了。`,
  mayCreate: (name: string) =>
    `#${name} 還不存在，captain 在頁面上關掉了 aggregator 開新的 hashtag。`,
  boardMax: (cap: number) => `看板已經有 ${cap} 個 hashtag，到上限了。`,
} as const;

/** The keys of the hashtags on `topic`, counting those left on ids merged into it. */
function topicKeys(situation: HashtagSituation): Set<string> {
  const keys = new Set<string>();
  for (const [id, names] of situation.hashtags.topics) {
    if (followMerges(situation.merged, id) !== situation.topic) continue;
    for (const name of names) keys.add(situation.hashtags.keys.get(name) ?? hashtagKey(name));
  }
  return keys;
}

function refuse(reason: string, skip = false): HashtagCheck {
  return { send: false, skip, reason };
}

function checkAdd(name: string, key: string, situation: HashtagSituation): HashtagCheck {
  const { settings } = situation.hashtags;
  const on = topicKeys(situation);
  if (on.has(key)) return refuse(HASHTAG_REASON.already(name), true);
  if (on.size >= settings.per_topic_max)
    return refuse(HASHTAG_REASON.perTopic(settings.per_topic_max));
  const known = new Set(situation.hashtags.keys.values());
  if (known.has(key)) return { send: true };
  if (!settings.aggregator_may_create) return refuse(HASHTAG_REASON.mayCreate(name));
  if (known.size >= settings.board_max) return refuse(HASHTAG_REASON.boardMax(settings.board_max));
  return { send: true };
}

/** Whether the change may go to the board, as a pure function of what the board files say. */
export function checkHashtag(
  change: HashtagChange,
  raw: string,
  situation: HashtagSituation,
): HashtagCheck {
  const name = raw.replace(/^#/, "");
  if (!NAME.test(name)) return refuse(HASHTAG_REASON.name(name));
  if (!situation.live) return refuse(HASHTAG_REASON.topic(situation.topic));
  const { settings } = situation.hashtags;
  if (!settings.aggregator_may_tag) return refuse(HASHTAG_REASON.mayTag);
  const key = hashtagKey(name);
  if (situation.hashtags.locked.has(key)) return refuse(HASHTAG_REASON.locked(name));
  if (situation.lastHour >= settings.aggregator_hourly_max) {
    return refuse(HASHTAG_REASON.hourly(situation.lastHour, settings.aggregator_hourly_max));
  }
  if (change === "add") return checkAdd(name, key, situation);
  return topicKeys(situation).has(key) ? { send: true } : refuse(HASHTAG_REASON.absent(name), true);
}

/**
 * How many `hashtag.added` and `hashtag.removed` records by the aggregator
 * data/myshape/events.jsonl holds from the hour before `nowSeconds`, as the
 * board counts its hourly cap; a missing file holds none, a line that is not
 * JSON is skipped.
 */
export function hashtagChangesInLastHour(home: string, nowSeconds: number): number {
  let text: string;
  try {
    text = readFileSync(join(home, "data", "myshape", "events.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const since = nowSeconds - HOUR_SECONDS;
  return text.split("\n").filter((line) => isRecentChange(line, since)).length;
}

/** Whether one events.jsonl line is a hashtag change by the aggregator saved after `since`. */
function isRecentChange(line: string, since: number): boolean {
  if (!line.includes("hashtag.")) return false;
  let record: { by?: unknown; kind?: unknown; ts?: unknown };
  try {
    record = JSON.parse(line) as typeof record;
  } catch {
    return false;
  }
  const recent = typeof record.ts === "number" && record.ts > since;
  return recent && record.by === "aggregator" && WATCHED.has(String(record.kind));
}

export type HashtagOutcome = { sent: true } | { sent: false; reason: string };

/** The guarded hashtag operation for one board home. */
export class Tagger {
  constructor(
    private readonly home: string,
    private readonly board: BoardCommand,
    private readonly nowMs: () => number,
  ) {}

  /**
   * Puts `name` on `topic` (`add`) or takes it off (`remove`), when every
   * guard allows it. `opening` says a name put on is meant as a new hashtag:
   * the board opens a name it does not have only when told so.
   */
  async change(
    topic: string,
    change: HashtagChange,
    name: string,
    opening = false,
  ): Promise<HashtagOutcome> {
    const board = readBoard(this.home);
    const current = followMerges(board.topics.merged, topic);
    const check = checkHashtag(change, name, {
      hashtags: board.hashtags,
      topic: current,
      live: board.topics.topics.has(current),
      merged: board.topics.merged,
      lastHour: hashtagChangesInLastHour(this.home, Math.floor(this.nowMs() / 1000)),
    });
    if (!check.send) return { sent: false, reason: check.reason };
    const problem = await this.board.hashtag(current, change, name.replace(/^#/, ""), opening);
    return problem === undefined ? { sent: true } : { sent: false, reason: problem };
  }
}
