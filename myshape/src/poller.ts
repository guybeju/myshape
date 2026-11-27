// Reads every home through the aggregator's feed: on every home's interval
// while someone is looking at the board, slowly with nobody looking, and on
// demand. It is the only caller of the feed. Every home is read the same way,
// with the same arguments; only the root report's hints change how often and
// how patiently.
import type { CommandRunner } from "./commands.js";
import type { Journal, Offsets } from "./journal.js";
import { MAIN_HOME } from "./journal.js";
import { parseReport, parseTopicsAnswer } from "./report.js";
import type { Aggregator, FeedHome, HomeReport } from "./report.js";
import type { HomeSnapshot } from "./view.js";

export interface PollTimings {
  /** How often a home with no read_every_s hint is read. */
  readMs: number;
  /** How long a read of a home with no read_timeout_s hint may take. */
  timeoutMs: number;
  /** Polling on every home's interval stops this long after the last viewer asked for the board. */
  idleMs: number;
  staleMs: number;
  /** With nobody looking, a home is read this long after its last read... */
  slowMs: number;
  /** ...and a home the root report hints to read less often than the default, this long. */
  slowFarMs: number;
}

export const DEFAULT_TIMINGS: PollTimings = {
  readMs: 10_000,
  timeoutMs: 60_000,
  idleMs: 120_000,
  staleMs: 180_000,
  slowMs: 900_000,
  slowFarMs: 3_600_000,
};

/** The feed's exit code for "this home's code cannot produce a report". */
export const FEED_CANNOT_REPORT = 4;
/** The feed's exit code for arguments it does not take. */
const FEED_USAGE = 2;

/** The code_commit of a home whose code is not known yet because it never reported. */
const UNREAD = Symbol("unread");

/** How many topics calls may run at once, across every home. */
export const MAX_TOPICS_CALLS = 2;

const TICK_MS = 250;
/** How often the poller looks for a home due a slow read, at most. */
const SLOW_TICK_MS = 15_000;
const MAX_CATCH_UP_READS = 50;
const ERROR_MAX = 400;

interface HomeState extends HomeSnapshot {
  everyMs: number | null;
  timeoutMs: number | null;
  reading: Promise<boolean> | null;
  dueAt: number;
  /** When the last read of the home ended, or when the poller first knew the home. */
  readAt: number;
  /** When the last good read of the home began, or null before one. */
  goodFrom: number | null;
  /**
   * The code_commit of the home whose feed refused the topics call (exit 2):
   * its last report's, or the next report's when it had none yet. Null while
   * the board still asks; a report from other code asks again.
   */
  topicsRefusedAt: string | typeof UNREAD | null;
  /** The topics calls of the home in flight; a read of the home waits them out. */
  topicsCalls: Set<Promise<void>>;
}

function newHome(id: string): HomeState {
  return {
    id,
    everyMs: null,
    timeoutMs: null,
    report: null,
    lastOkAt: null,
    error: null,
    version: "unknown",
    reading: null,
    dueAt: Number.NEGATIVE_INFINITY,
    readAt: Date.now(),
    goodFrom: null,
    topicsRefusedAt: null,
    topicsCalls: new Set(),
  };
}

export interface PollHost {
  /** Called after any read that changed what a viewer could see. */
  onChange: () => void;
  /** The cursor of a home's closed decisions to pass to its feed, when its last report carried one. */
  closedCursor: (home: string) => { offset: number; sha: string } | null;
  /** Called with each good report, after its ledger is stored, to record its decisions; `startedAt` is when that read began, in epoch seconds. */
  onReport: (home: string, report: HomeReport, startedAt: number) => void;
  /** Called when a feed given a closed decisions' cursor refused its arguments (exit 2). */
  onCursorRefused: (home: string) => void;
  /** Called with the root report's aggregator block after each read of the root home. */
  onAggregator: (aggregator: Aggregator | null) => void;
}

export class Poller {
  private readonly homes = new Map<string, HomeState>([[MAIN_HOME, newHome(MAIN_HOME)]]);
  private lastViewerAt = 0;
  private timer: NodeJS.Timeout | null = null;
  /** The interval `timer` ticks at: TICK_MS while someone looks, the slow tick otherwise. */
  private timerMs = 0;
  private topicsRunning = 0;
  private topicsWaiting: (() => void)[] = [];

  constructor(
    private readonly run: CommandRunner,
    private readonly journal: Journal,
    private readonly offsets: Offsets,
    private readonly timings: PollTimings,
    private readonly host: PollHost,
    /** Why the feed may not run now, or null when it may (binding.ts). */
    private readonly blocked: () => string | null,
  ) {}

  /** True while a viewer asked for the board recently enough to keep polling. */
  get active(): boolean {
    return Date.now() - this.lastViewerAt < this.timings.idleMs;
  }

  /** Starts reading on its own: slowly with nobody looking, on every home's interval once someone looks. */
  start(): void {
    this.arm();
  }

  /** Records that someone is looking, which starts or continues polling on every home's interval. */
  touch(): void {
    this.lastViewerAt = Date.now();
    this.arm();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Makes the timer tick at the pace of now: often while someone looks, slowly otherwise. */
  private arm(): void {
    const every = this.active ? TICK_MS : Math.min(SLOW_TICK_MS, this.timings.slowMs);
    if (this.timer !== null && this.timerMs === every) return;
    this.stop();
    this.timerMs = every;
    this.timer = setInterval(() => this.tick(), every);
  }

  /** How long after its last read a home is read with nobody looking. */
  private slowEveryMs(home: HomeState): number {
    const far = home.everyMs !== null && home.everyMs > this.timings.readMs;
    return far ? this.timings.slowFarMs : this.timings.slowMs;
  }

  /**
   * How long a good read of a home counts as current: the stale limit while
   * someone looks, twice the home's slow interval with nobody looking, so
   * the board's own reads keep it current.
   */
  private staleAfterMs(home: HomeState): number {
    if (this.active) return this.timings.staleMs;
    return Math.max(this.timings.staleMs, 2 * this.slowEveryMs(home));
  }

  snapshots(): HomeSnapshot[] {
    return [...this.homes.values()].map((home) => ({
      id: home.id,
      report: home.report,
      lastOkAt: home.lastOkAt,
      error: home.error,
      version: home.version,
      staleAfterMs: this.staleAfterMs(home),
    }));
  }

  hasMainReport(): boolean {
    return (this.homes.get(MAIN_HOME) as HomeState).report !== null;
  }

  knows(home: string): boolean {
    return this.homes.has(home);
  }

  /** When the last good read of each home began, epoch ms, for every home read well since the start. */
  goodReadsFrom(): Map<string, number> {
    const found = new Map<string, number>();
    for (const home of this.homes.values())
      if (home.goodFrom !== null) found.set(home.id, home.goodFrom);
    return found;
  }

  /** Reads one home now (joining a read already in flight); resolves to whether it succeeded. */
  readNow(id: string): Promise<boolean> {
    const home = this.homes.get(id);
    if (home === undefined || this.blocked() !== null) return Promise.resolve(false);
    home.reading ??= this.readHome(home).finally(() => {
      home.reading = null;
      home.readAt = Date.now();
      home.dueAt = home.readAt + (home.everyMs ?? this.timings.readMs);
    });
    return home.reading;
  }

  /**
   * Reads one home with a read that starts after this call. A read already in
   * flight may predate what the caller wants to observe, so it is waited out
   * first rather than joined.
   */
  async readFresh(id: string): Promise<boolean> {
    await this.homes.get(id)?.reading;
    return this.readNow(id);
  }

  /**
   * Asks the feed for these tasks' tag files in one home, with a call that
   * starts now and leaves what the board knows of the home untouched.
   *
   * Returns:
   *   The tag texts by task (a task left out has no tag file), or null when
   *   the call is not supported or failed, or the feed may not run: the caller
   *   then reads the whole home. After exit 2 the home is not asked again
   *   until it reports other code.
   *
   * The call waits while a read of the home runs and while MAX_TOPICS_CALLS
   * calls run; one that could not start before `deadline` (epoch ms) runs
   * nothing and gives null.
   */
  async readTopics(
    id: string,
    tasks: string[],
    deadline: number = Number.POSITIVE_INFINITY,
  ): Promise<Record<string, string> | null> {
    const home = this.homes.get(id);
    if (home === undefined || !this.mayAskTopics(home)) return null;
    const done = await this.topicsTurn(home);
    try {
      if (this.homes.get(id) !== home || !this.mayAskTopics(home) || Date.now() >= deadline)
        return null;
      const result = await this.run(
        { kind: "topics", home: id, tasks },
        home.timeoutMs ?? this.timings.timeoutMs,
      );
      if (result.code === FEED_USAGE) home.topicsRefusedAt = home.report?.code_commit ?? UNREAD;
      return result.code === 0 ? parseTopicsAnswer(result.stdout, tasks) : null;
    } finally {
      done();
    }
  }

  private mayAskTopics(home: HomeState): boolean {
    return home.topicsRefusedAt === null && this.blocked() === null;
  }

  /**
   * Waits until a topics call of `home` may start: fewer than MAX_TOPICS_CALLS
   * run and no read of the home runs. Both are checked in the same turn the
   * call is counted, so no read of the home starts in between. Returns what
   * ends the call's turn.
   */
  private async topicsTurn(home: HomeState): Promise<() => void> {
    for (;;) {
      if (this.topicsRunning >= MAX_TOPICS_CALLS)
        await new Promise<void>((resume) => this.topicsWaiting.push(resume));
      else if (home.reading !== null) await Promise.allSettled([home.reading]);
      else break;
    }
    this.topicsRunning += 1;
    let finished: (() => void) | undefined;
    const call = new Promise<void>((resolve) => {
      finished = resolve;
    });
    home.topicsCalls.add(call);
    return () => {
      home.topicsCalls.delete(call);
      finished?.();
      this.topicsRunning -= 1;
      for (const resume of this.topicsWaiting.splice(0)) resume();
    };
  }

  /** Reads every home now, the main home first so new secondmates are included. */
  async refreshAll(): Promise<void> {
    await this.readNow(MAIN_HOME);
    await Promise.all(
      [...this.homes.keys()].filter((id) => id !== MAIN_HOME).map((id) => this.readNow(id)),
    );
  }

  private tick(): void {
    const { active } = this;
    if (!active) this.arm();
    const now = Date.now();
    for (const home of this.homes.values()) {
      const due = active ? home.dueAt : home.readAt + this.slowEveryMs(home);
      if (home.reading === null && due <= now) void this.readNow(home.id);
    }
  }

  private async readHome(home: HomeState): Promise<boolean> {
    while (home.topicsCalls.size > 0) await Promise.all(home.topicsCalls);
    const before = fingerprint(home);
    const eventsBefore = this.journal.events.length;
    for (let reads = 0; reads < MAX_CATCH_UP_READS; reads += 1) {
      const { offset, sha } = this.offsets.get(home.id);
      const closed = this.host.closedCursor(home.id);
      const startedMs = Date.now();
      const result = await this.run(
        { kind: "feed", home: home.id, offset, sha, ...(closed === null ? {} : { closed }) },
        home.timeoutMs ?? this.timings.timeoutMs,
      );
      // The feed may not run now: nothing was read, and the page says why.
      if (result.blocked !== undefined) return false;
      const more =
        result.code === 0
          ? this.accept(home, result.stdout, startedMs)
          : this.reject(home, result.code, result.stderr, closed !== null);
      if (!more) break;
    }
    // A read that found nothing new must not look like a change, or every
    // viewer would redraw the whole page on every poll.
    if (fingerprint(home) !== before || this.journal.events.length !== eventsBefore)
      this.host.onChange();
    return home.error === null;
  }

  /**
   * A failed read. Exit 4 says the home cannot report at all: its data is
   * dropped and the feed's one line becomes its banner. Any other failure keeps
   * the last report until it goes stale. A usage error to a read that passed
   * the closed decisions' cursor makes the host forget that cursor.
   */
  private reject(
    home: HomeState,
    code: number | null,
    stderr: string,
    cursorSent: boolean,
  ): boolean {
    const text = stderr.trim();
    // A home whose code went back to before the cursor refuses it; read it without one next time.
    if (code === FEED_USAGE && cursorSent) this.host.onCursorRefused(home.id);
    if (code === FEED_CANNOT_REPORT) {
      home.version = "unreported";
      home.report = null;
      home.error = (text.split("\n")[0] ?? "").slice(0, ERROR_MAX) || "這個 home 現在無法回報";
      return false;
    }
    home.error = text.slice(0, ERROR_MAX) || "讀取失敗";
    return false;
  }

  /** Applies one successful read, begun at `startedMs`; returns whether the home has more ledger to read right away. */
  private accept(home: HomeState, stdout: string, startedMs: number): boolean {
    const parsed = parseReport(stdout);
    if (parsed.kind === "incompatible") {
      home.version = "incompatible";
      home.report = null;
      home.error = "讀到的資料版本和看板不相容";
      return false;
    }
    if (parsed.kind === "invalid") {
      home.error = "讀到的資料不是合法的 JSON";
      return false;
    }
    const { report } = parsed;
    if (home.topicsRefusedAt === UNREAD) home.topicsRefusedAt = report.code_commit;
    if (home.topicsRefusedAt !== report.code_commit) home.topicsRefusedAt = null;
    const rewind = this.storeLedger(home.id, report);
    home.report = report;
    home.lastOkAt = Date.now();
    home.goodFrom = startedMs;
    home.error = null;
    if (home.id === MAIN_HOME) {
      this.syncHomes(report.secondmates);
      this.host.onAggregator(report.aggregator);
    }
    this.refreshVersions();
    this.host.onReport(home.id, report, Math.floor(startedMs / 1000));
    return rewind || report.ledger.more || report.closed_cursor?.more === true;
  }

  /** Stores a read's ledger lines and cursor; returns true when the ledger must be re-read from the start. */
  private storeLedger(home: string, report: HomeReport): boolean {
    const { ledger } = report;
    if (ledger.status === "continuity-broken") {
      this.offsets.set(home, { offset: 0, sha: "-" });
      return true;
    }
    if (ledger.status === "delta") {
      // Events first, cursor second: a crash in between re-reads this piece and
      // the journal drops the lines it already has.
      this.journal.appendLedger(home, ledger.lines);
      this.offsets.set(home, { offset: ledger.to_offset, sha: ledger.to_prefix_sha256 });
    }
    return false;
  }

  /** Makes the further homes exactly the ones the root report lists, with its hints. */
  private syncHomes(listed: FeedHome[]): void {
    const ids = new Set(listed.map((entry) => entry.id));
    for (const id of this.homes.keys()) {
      if (id !== MAIN_HOME && !ids.has(id)) this.homes.delete(id);
    }
    for (const entry of listed) {
      const home = this.homes.get(entry.id) ?? newHome(entry.id);
      home.everyMs = entry.read_every_s === null ? null : entry.read_every_s * 1000;
      home.timeoutMs = entry.read_timeout_s === null ? null : entry.read_timeout_s * 1000;
      this.homes.set(entry.id, home);
    }
  }

  private refreshVersions(): void {
    const mainReport = (this.homes.get(MAIN_HOME) as HomeState).report;
    const main = mainReport === null ? "" : mainReport.code_commit;
    for (const home of this.homes.values()) {
      if (home.report !== null) home.version = versionOf(home.id, home.report.code_commit, main);
    }
  }
}

/** Everything about a home that a viewer could see, apart from when it was last read. */
function fingerprint(home: HomeState): string {
  const { report } = home;
  const shown =
    report === null ? null : { ...report, ledger: null, closed_holds: null, closed_cursor: null };
  return JSON.stringify([home.error, home.version, shown]);
}

function versionOf(home: string, commit: string, mainCommit: string): HomeSnapshot["version"] {
  if (home === MAIN_HOME) return "same";
  if (mainCommit === "") return "unknown";
  return commit === mainCommit ? "same" : "different";
}
