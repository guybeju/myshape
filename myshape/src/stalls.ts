// The board's two cards that say nobody picked something up (spec/lifecycle.markdown
// section 2.13). The 沒人接 card: one per topic, and one for work with no
// topic, listing the cards under it that passed their escalation deadline; N2
// puts it in front of the captain, the captain's 延到 <日期> puts the members
// listed then off (N4), and it settles once no member is overdue. The
// 沒人處理的議題 card: a topic in 高 or 一般 with no work past its deadline.
// Pure: the service commits what these return.
import { KEEP_MAX_DAYS } from "./lifecycle-settings.js";
import type { Stall } from "./lifecycle.js";
import type { Draft, Frozen } from "./records.js";

/** The stall key of a topic, and of work with no topic. */
export const NO_TOPIC = "-";

/** MM-DD of `iso` in this machine's time, as the page prints days. */
export function localDay(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function stallKeyOf(topic: string | null): string {
  return topic === null ? NO_TOPIC : topic;
}

/** How a 沒人接 card names where it is: a topic, or work with no topic. */
export type NameOf = (key: string) => string;

function where(nameOf: NameOf, key: string): string {
  return key === NO_TOPIC ? "沒有議題的工作" : `議題「${nameOf(key)}」`;
}

function topicOfKey(key: string): string | null {
  return key === NO_TOPIC ? null : key;
}

export interface StallStep {
  stalls: Record<string, Stall>;
  /** stall.raised for each new card, stall.settled for each that ended. */
  records: Draft[];
}

/**
 * The 沒人接 cards after this look. `members` holds, for each stall key, the
 * keys of the cards under it now past their escalation deadline. A key with
 * members gets a card (a stall.raised record when it is new); a card left
 * with none settles (stall.settled). A deferral that ran out is dropped.
 */
export function stallStep(
  previous: Frozen<Record<string, Stall>>,
  members: ReadonlyMap<string, readonly string[]>,
  nameOf: NameOf,
  nowMs: number,
): StallStep {
  const stalls: Record<string, Stall> = {};
  const records: Draft[] = [];
  for (const [key, list] of members) {
    if (list.length === 0) continue;
    const old = previous[key];
    stalls[key] = nextStall(old, list, nowMs);
    if (old === undefined) records.push(raisedRecord(nameOf, key, list.length));
  }
  for (const key of Object.keys(previous))
    if (stalls[key] === undefined)
      records.push({
        kind: "stall.settled",
        topic: topicOfKey(key),
        outcome: "stall",
        text: `「沒人接」${where(nameOf, key)}已不需要：每張卡都離開了逾期的狀態`,
      });
  return { stalls, records };
}

/** A 沒人接 card with these members: its first time kept, a 延到 kept while it runs. */
function nextStall(
  old: Frozen<Stall> | undefined,
  members: readonly string[],
  nowMs: number,
): Stall {
  const put = old?.deferred;
  const running = put !== undefined && Date.parse(put.until) > nowMs;
  return {
    since: old === undefined ? new Date(nowMs).toISOString() : old.since,
    members: [...members],
    ...(running ? { deferred: { until: put.until, members: [...put.members] } } : {}),
  };
}

function raisedRecord(nameOf: NameOf, key: string, count: number): Draft {
  return {
    kind: "stall.raised",
    topic: topicOfKey(key),
    outcome: "stall",
    text: `「沒人接」：${where(nameOf, key)}有 ${count} 張卡過了期限，交給你決定`,
  };
}

/** N4 while the captain's 延到 still covers every member, N2 otherwise. */
export function stallState(stall: Frozen<Stall>, nowMs: number): "N2" | "N4" {
  const { deferred } = stall;
  if (deferred === undefined || Date.parse(deferred.until) <= nowMs) return "N2";
  return stall.members.every((member) => deferred.members.includes(member)) ? "N4" : "N2";
}

export type DeferResult =
  | { ok: true; stall: Stall; line: string; records: [Draft] }
  | { ok: false; code: "refused" | "usage"; line: string };

/** The captain's 延到 <日期>: puts off the members listed now, for `days` days. */
export function deferStall(
  stalls: Frozen<Record<string, Stall>>,
  key: string,
  days: unknown,
  context: { nameOf: NameOf; nowMs: number },
): DeferResult {
  const stall = stalls[key];
  if (stall === undefined || stallState(stall, context.nowMs) !== "N2")
    return { ok: false, code: "refused", line: "這張「沒人接」卡現在沒有在等你決定。" };
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > KEEP_MAX_DAYS)
    return { ok: false, code: "usage", line: `延幾天要是 1 到 ${KEEP_MAX_DAYS} 的整數。` };
  const until = new Date(context.nowMs + days * 86_400_000).toISOString();
  const shown = localDay(until);
  return {
    ok: true,
    stall: {
      since: stall.since,
      members: [...stall.members],
      deferred: { until, members: [...stall.members] },
    },
    line: `ok ${key} 延到 ${shown}`,
    records: [
      {
        kind: "lifecycle.answered",
        topic: topicOfKey(key),
        outcome: "deferred",
        text: `「沒人接」${where(context.nameOf, key)}：延到 ${shown}，只延現在列出的 ${stall.members.length} 張`,
      },
    ],
  };
}

export interface IdleStep {
  idle: Record<string, string>;
  records: Draft[];
}

/**
 * The 沒人處理的議題 cards after this look: one for each topic in `topics`
 * (overdue with no work), raised with a stall.raised record when new; one
 * whose topic is no longer overdue settles with stall.settled.
 */
export function idleStep(
  previous: Frozen<Record<string, string>>,
  topics: readonly string[],
  nameOf: NameOf,
  nowMs: number,
): IdleStep {
  const now = new Date(nowMs).toISOString();
  const idle: Record<string, string> = {};
  const records: Draft[] = [];
  for (const topic of topics) {
    const since = previous[topic];
    idle[topic] = since === undefined ? now : since;
    if (since === undefined)
      records.push({
        kind: "stall.raised",
        topic,
        outcome: "idle",
        text: `「沒人處理的議題」：議題「${nameOf(topic)}」過了期限還沒有任何工作，交給你決定`,
      });
  }
  for (const topic of Object.keys(previous)) {
    if (idle[topic] !== undefined) continue;
    records.push({
      kind: "stall.settled",
      topic,
      outcome: "idle",
      text: `「沒人處理的議題」議題「${nameOf(topic)}」已不需要：它離開了沒有工作的狀態`,
    });
  }
  return { idle, records };
}
