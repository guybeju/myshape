// The supervisor's board writes for schedules (plan section 3.8): it takes
// an occurrence when its coming-up or due notice lands, or at the latest when
// its work starts; it closes an occurrence `done` once its work has ended;
// and it answers a missed occurrence by its rt: soft-rt is made up once,
// hard-rt and none get a report summary. It reads what an occurrence is from
// the board's schedules.json each pass and never works one out itself; it
// creates, edits, pauses and deletes no schedule.
//
// A notice stays in inbox/ until what it asks for is done, so a restart
// finds it again; a write is never sent twice at once, and never sent at all
// when the file already says it happened (an occurrence already taken, or no
// longer open). So a restart neither takes an occurrence twice nor loses one.

import type { SchedulesFile } from "./board-files.js";
import type { BoardCommand } from "./commands.js";
import type { ScheduleItem } from "./inbox.js";
import {
  missedAction,
  missedReport,
  missedReportId,
  NOTE,
  occurrencePhase,
  workOf,
} from "./occurrences.js";
import type { StateStore } from "./state-store.js";

export const SCHEDULE_LOG = {
  taken: (key: string) => `took occurrence ${key}`,
  notTaken: (key: string, problem: string) => `occurrence ${key} was not taken: ${problem}`,
  closed: (key: string) => `closed occurrence ${key} done`,
  notClosed: (key: string, problem: string) => `occurrence ${key} was not closed: ${problem}`,
  ended: (key: string) => `occurrence ${key} has ended; its notice is not acted on`,
  silent: (key: string) => `occurrence ${key}'s schedule does not ring now; not taken`,
  reported: (key: string) => `reported the missed occurrence ${key}`,
  alreadyReported: (key: string) => `the missed occurrence ${key} was already reported`,
  notReported: (key: string, problem: string) =>
    `the missed occurrence ${key} was not reported: ${problem}`,
  expired: (key: string) =>
    `the missed occurrence ${key} is not made up: its schedule's next occurrence is coming`,
  madeUp: (key: string) => `the missed occurrence ${key} was already made up`,
  noTopic: (key: string, topic: string) =>
    `the missed occurrence ${key} is not made up: its topic ${topic} is not on the board`,
} as const;

/** What the step needs from the supervisor. */
export interface StepHost {
  board: BoardCommand;
  store: StateStore;
  log: (line: string) => void;
  nowMs: () => number;
  /** A topic id with merges followed. */
  current: (topic: string) => string;
  /** Whether a topic (merges followed) is live on the board. */
  live: (topic: string) => boolean;
  /** Every task id and queued id the supervisor knows. */
  ids: () => string[];
  /** Whether the board already stores a report summary for this id. */
  reported: (id: string) => boolean;
}

/** A missed soft-rt occurrence waiting for its planner, under the topic it is on now. */
export interface MakeUp {
  key: string;
  topic: string;
  item: ScheduleItem;
}

export class ScheduleStep {
  private readonly host: StepHost;
  /** Board writes in flight, as "<op> <key>", so none is sent twice at once. */
  private readonly sending = new Set<string>();

  constructor(host: StepHost) {
    this.host = host;
  }

  /**
   * Acts on this pass's schedule notices, oldest first.
   *
   * Returns:
   *   The make-ups that wait for a planner, by topic: one per topic, the oldest.
   */
  takeNotices(items: readonly ScheduleItem[], schedules: SchedulesFile): Map<string, MakeUp> {
    const makeUps = new Map<string, MakeUp>();
    for (const item of items) {
      if (item.schedule.event === "schedule.missed") {
        const makeUp = this.missed(item);
        if (makeUp !== undefined && !makeUps.has(makeUp.topic)) makeUps.set(makeUp.topic, makeUp);
      } else {
        this.coming(item, schedules);
      }
    }
    return makeUps;
  }

  /** Takes the occurrence when the file says it is open and not taken yet. */
  takeIfOpen(key: string, schedules: SchedulesFile, note: string, done?: () => void): void {
    const phase = occurrencePhase(schedules, key, this.host.nowMs());
    const taken = schedules.occurrences.get(key)?.state === "taken";
    if (phase === "ended" || phase === "silent" || taken) {
      done?.();
      return;
    }
    this.send(`take ${key}`, () => this.host.board.scheduleTake(key, note), {
      ok: () => this.host.log(SCHEDULE_LOG.taken(key)),
      problem: (problem) => this.host.log(SCHEDULE_LOG.notTaken(key, problem)),
      done,
    });
  }

  /** Closes each occurrence whose work has ended, once at a time. */
  close(closes: readonly { key: string; note: string }[]): void {
    for (const { key, note } of closes) {
      this.send(`close ${key}`, () => this.host.board.scheduleCloseDone(key, note), {
        ok: () => this.host.log(SCHEDULE_LOG.closed(key)),
        problem: (problem) => this.host.log(SCHEDULE_LOG.notClosed(key, problem)),
      });
    }
  }

  /** A coming-up or due notice: take the occurrence, then retire the notice. */
  private coming(item: ScheduleItem, schedules: SchedulesFile): void {
    const { key } = item.schedule;
    const phase = occurrencePhase(schedules, key, this.host.nowMs());
    if (phase === "ended" || phase === "silent") {
      this.host.log(phase === "ended" ? SCHEDULE_LOG.ended(key) : SCHEDULE_LOG.silent(key));
      this.retire(item);
      return;
    }
    const note = item.schedule.event === "schedule.due" ? NOTE.takeDue : NOTE.take;
    this.takeIfOpen(key, schedules, note, () => this.retire(item));
  }

  /** A missed notice: a make-up to plan, or a report summary. */
  private missed(item: ScheduleItem): MakeUp | undefined {
    const notice = item.schedule;
    const action = missedAction(notice, this.host.nowMs());
    if (action === "report") {
      this.report(item);
      return undefined;
    }
    const topic = this.host.current(notice.topic);
    const made = this.host.ids().some((id) => {
      const ref = workOf(id);
      return ref?.makeUp === true && ref.key === notice.key;
    });
    let log: string | undefined;
    if (action === "expired") log = SCHEDULE_LOG.expired(notice.key);
    else if (made) log = SCHEDULE_LOG.madeUp(notice.key);
    else if (!this.host.live(topic)) log = SCHEDULE_LOG.noTopic(notice.key, topic);
    if (log === undefined) return { key: notice.key, topic, item };
    this.host.log(log);
    this.retire(item);
    return undefined;
  }

  /**
   * Files the report summary under the occurrence's topic: the carrier id's
   * topic tag first (once), then the summary (once: not when the board
   * already stores one for the carrier), then the notice is retired.
   */
  private report(item: ScheduleItem): void {
    const notice = item.schedule;
    const id = missedReportId(notice.key);
    const { store } = this.host;
    if (this.host.reported(id)) {
      this.host.log(SCHEDULE_LOG.alreadyReported(notice.key));
      this.retire(item);
      return;
    }
    this.send(
      `report ${notice.key}`,
      async () => {
        if (!store.readTags().has(id)) {
          store.appendTag(id, this.host.current(notice.topic), isoNow(this.host.nowMs()));
        }
        return this.host.board.summary(id, "report", missedReport(notice));
      },
      {
        ok: () => this.host.log(SCHEDULE_LOG.reported(notice.key)),
        problem: (problem) => this.host.log(SCHEDULE_LOG.notReported(notice.key, problem)),
        done: () => this.retire(item),
      },
    );
  }

  private retire(item: ScheduleItem): void {
    try {
      this.host.store.retireInbox(item.file);
    } catch (error) {
      this.host.log(`inbox/${item.file} was handled but not moved: ${(error as Error).message}`);
    }
  }

  /**
   * Sends one board write unless the same one is in flight. A refusal is
   * logged and counts as handled; a runner that throws leaves the notice in
   * the inbox for the next pass.
   */
  private send(
    what: string,
    write: () => Promise<string | undefined>,
    then: { ok: () => void; problem: (problem: string) => void; done?: (() => void) | undefined },
  ): void {
    if (this.sending.has(what)) return;
    this.sending.add(what);
    write()
      .then((problem) => {
        if (problem === undefined) then.ok();
        else then.problem(problem);
        then.done?.();
      })
      .catch((error: unknown) => then.problem((error as Error).message))
      .finally(() => this.sending.delete(what));
  }
}

function isoNow(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
