// Which waiting work starts now, and why the rest waits (plan section 4.3,
// D6): at most MAX_RUNNING sessions in all (workers and the planner) and at
// most MAX_PER_TOPIC on one topic; nothing new for a topic in later (待辦) or
// gone from the board; nothing new at all while the quota or rate limit has
// stopped dispatching. A pure function: the supervisor runs what it returns.

export const MAX_RUNNING = 2;
export const MAX_PER_TOPIC = 1;

/** A session that runs now, on a topic. */
export interface Slot {
  id: string;
  topic: string;
}

/** Work that may start: a planned task, a task to resume, or a topic to plan. */
export interface Candidate {
  id: string;
  topic: string;
}

export type TopicStatus = "dispatchable" | "later" | "gone";

export interface Situation {
  running: readonly Slot[];
  /** In dispatch order. */
  candidates: readonly Candidate[];
  topicStatus: (topic: string) => TopicStatus;
  /** When dispatching is stopped for the quota: the UTC ISO time it should clear, or "" when unknown. */
  quotaUntil: string | null;
}

export interface Decision {
  start: Candidate[];
  /** Each candidate that waits, with the reason shown in its queued entry's `hold`. */
  waiting: Map<string, string>;
}

export const WAIT = {
  quota: (until: string) =>
    `額度用盡或被限流，暫停派工${until === "" ? "" : `，預計 ${until} 恢復`}`,
  later: "議題在待辦，不開新工作",
  gone: "議題已封存或不在看板上，不開新工作",
  topicBusy: (id: string) => `同一個議題已經有 worker 在跑（${id}）`,
  full: `等空位（${MAX_RUNNING}/${MAX_RUNNING}）`,
};

function waitReason(candidate: Candidate, running: readonly Slot[], situation: Situation) {
  const status = situation.topicStatus(candidate.topic);
  if (status === "later") return WAIT.later;
  if (status === "gone") return WAIT.gone;
  if (situation.quotaUntil !== null) return WAIT.quota(situation.quotaUntil);
  const sameTopic = running.filter((slot) => slot.topic === candidate.topic);
  if (sameTopic.length >= MAX_PER_TOPIC) return WAIT.topicBusy(sameTopic[0]?.id ?? "");
  if (running.length >= MAX_RUNNING) return WAIT.full;
  return undefined;
}

/** What starts now, in order, and why each other candidate waits. */
export function schedule(situation: Situation): Decision {
  const running = [...situation.running];
  const start: Candidate[] = [];
  const waiting = new Map<string, string>();
  const seen = new Set(running.map((slot) => slot.id));
  for (const candidate of situation.candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    const reason = waitReason(candidate, running, situation);
    if (reason === undefined) {
      start.push(candidate);
      running.push(candidate);
    } else {
      waiting.set(candidate.id, reason);
    }
  }
  return { start, waiting };
}
