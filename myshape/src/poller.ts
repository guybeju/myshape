// Reads every home through the aggregator's feed on a schedule while someone
// is looking at the board, and on demand otherwise. It is the only caller of
// the feed. Every home is read the same way; only the root report's hints
// change how often and how patiently.
import type { CommandRunner } from "./commands.js";
import type { Journal, Offsets } from "./journal.js";
import { MAIN_HOME } from "./journal.js";
import { parseReport } from "./report.js";
import type { Aggregator, FeedHome, HomeReport } from "./report.js";
import type { HomeSnapshot } from "./view.js";

export interface PollTimings {
  /** How often a home with no read_every_s hint is read. */
  readMs: number;
  /** How long a read of a home with no read_timeout_s hint may take. */
  timeoutMs: number;
  /** Polling stops this long after the last viewer asked for the board. */
  idleMs: number;
  staleMs: number;
}

export const DEFAULT_TIMINGS: PollTimings = {
  readMs: 10_000,
  timeoutMs: 60_000,
  idleMs: 120_000,
  staleMs: 180_000,
};

/** The feed's exit code for "this home's code cannot produce a report". */
export const FEED_CANNOT_REPORT = 4;
/** The feed's exit code for arguments it does not take. */
const FEED_USAGE = 2;

const TICK_MS = 250;
const MAX_CATCH_UP_READS = 50;
const ERROR_MAX = 400;

interface HomeState extends HomeSnapshot {
  everyMs: number | null;
  timeoutMs: number | null;
  reading: Promise<boolean> | null;
  dueAt: number;
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

  /** Records that someone is looking, which starts or continues scheduled polling. */
  touch(): void {
    this.lastViewerAt = Date.now();
    this.timer ??= setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  snapshots(): HomeSnapshot[] {
    return [...this.homes.values()].map(({ id, report, lastOkAt, error, version }) => ({
      id,
      report,
      lastOkAt,
      error,
      version,
    }));
  }

  hasMainReport(): boolean {
    return (this.homes.get(MAIN_HOME) as HomeState).report !== null;
  }

  knows(home: string): boolean {
    return this.homes.has(home);
  }

  /** Reads one home now (joining a read already in flight); resolves to whether it succeeded. */
  readNow(id: string): Promise<boolean> {
    const home = this.homes.get(id);
    if (home === undefined || this.blocked() !== null) return Promise.resolve(false);
    home.reading ??= this.readHome(home).finally(() => {
      home.reading = null;
      home.dueAt = Date.now() + (home.everyMs ?? this.timings.readMs);
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

  /** Reads every home now, the main home first so new secondmates are included. */
  async refreshAll(): Promise<void> {
    await this.readNow(MAIN_HOME);
    await Promise.all(
      [...this.homes.keys()].filter((id) => id !== MAIN_HOME).map((id) => this.readNow(id)),
    );
  }

  private tick(): void {
    if (!this.active) {
      this.stop();
      return;
    }
    const now = Date.now();
    for (const home of this.homes.values()) {
      if (home.reading === null && home.dueAt <= now) void this.readNow(home.id);
    }
  }

  private async readHome(home: HomeState): Promise<boolean> {
    const before = fingerprint(home);
    const eventsBefore = this.journal.events.length;
    for (let reads = 0; reads < MAX_CATCH_UP_READS; reads += 1) {
      const { offset, sha } = this.offsets.get(home.id);
      const closed = this.host.closedCursor(home.id);
      const startedAt = Math.floor(Date.now() / 1000);
      const result = await this.run(
        { kind: "feed", home: home.id, offset, sha, ...(closed === null ? {} : { closed }) },
        home.timeoutMs ?? this.timings.timeoutMs,
      );
      // The feed may not run now: nothing was read, and the page says why.
      if (result.blocked !== undefined) return false;
      const more =
        result.code === 0
          ? this.accept(home, result.stdout, startedAt)
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

  /** Applies one successful read; returns whether the home has more ledger to read right away. */
  private accept(home: HomeState, stdout: string, startedAt: number): boolean {
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
    const rewind = this.storeLedger(home.id, report);
    home.report = report;
    home.lastOkAt = Date.now();
    home.error = null;
    if (home.id === MAIN_HOME) {
      this.syncHomes(report.secondmates);
      this.host.onAggregator(report.aggregator);
    }
    this.refreshVersions();
    this.host.onReport(home.id, report, startedAt);
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
