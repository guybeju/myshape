// Which waiting work starts now, and why the rest waits (plan sections 3.8
// and 4.3, D6): at most MAX_RUNNING sessions in all (workers and the planner)
// and at most MAX_PER_TOPIC on one topic; nothing new for a topic in later
// (待辦) or gone from the board, nor for an occurrence before its time or of
// a silent schedule; nothing new at all while the quota or rate limit has
// stopped dispatching. Each open occurrence whose work has not started keeps
// one place free: other work starts only while running sessions plus kept
// places stay under MAX_RUNNING. Nothing running is ever stopped. A pure
// function: the supervisor runs what it returns.

export const MAX_RUNNING = 2;
export const MAX_PER_TOPIC = 1;

/** A session that runs now, on a topic; `occurrence` is the key of the occurrence it works for. */
export interface Slot {
  id: string;
  topic: string;
  occurrence?: string;
}

/** Work that may start: a planned task, a task to resume, or a topic to plan. */
export type Candidate = Slot;

export type TopicStatus = "dispatchable" | "later" | "gone" | "notYet" | "silent";

export interface Situation {
  running: readonly Slot[];
  /** In dispatch order. */
  candidates: readonly Candidate[];
  status: (candidate: Candidate) => TopicStatus;
  /** When dispatching is stopped for the quota: the UTC ISO time it should clear, or "" when unknown. */
  quotaUntil: string | null;
  /** The keys of the open occurrences that keep a place free until their work starts. */
  reserved: ReadonlySet<string>;
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
  notYet: "排程的這一場還沒到時間",
  silent: "排程暫停中，這一場不開工",
  reserved: (key: string) => `為排程的場次留位子（${key}）`,
};

const STATUS_WAIT: Readonly<Record<Exclude<TopicStatus, "dispatchable">, string>> = {
  later: WAIT.later,
  gone: WAIT.gone,
  notYet: WAIT.notYet,
  silent: WAIT.silent,
};

/** The kept places no running session works for yet, in key order. */
function keptPlaces(running: readonly Slot[], reserved: ReadonlySet<string>): string[] {
  const served = new Set(running.map((slot) => slot.occurrence));
  return [...reserved].filter((key) => !served.has(key)).toSorted();
}

/** Why a candidate waits for a place another occurrence keeps, or undefined. */
function keptReason(candidate: Candidate, running: readonly Slot[], reserved: ReadonlySet<string>) {
  if (candidate.occurrence !== undefined && reserved.has(candidate.occurrence)) return undefined;
  const kept = keptPlaces(running, reserved);
  return running.length + kept.length >= MAX_RUNNING ? WAIT.reserved(kept[0] ?? "") : undefined;
}

function waitReason(candidate: Candidate, running: readonly Slot[], situation: Situation) {
  const status = situation.status(candidate);
  if (status !== "dispatchable") return STATUS_WAIT[status];
  if (situation.quotaUntil !== null) return WAIT.quota(situation.quotaUntil);
  const sameTopic = running.filter((slot) => slot.topic === candidate.topic);
  if (sameTopic.length >= MAX_PER_TOPIC) return WAIT.topicBusy(sameTopic[0]?.id ?? "");
  if (running.length >= MAX_RUNNING) return WAIT.full;
  return keptReason(candidate, running, situation.reserved);
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
