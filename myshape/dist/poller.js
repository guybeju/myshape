import { MAIN_HOME } from "./journal.js";
import { parseReport, parseTopicsAnswer } from "./report.js";
export const DEFAULT_TIMINGS = {
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
function newHome(id) {
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
export class Poller {
    run;
    journal;
    offsets;
    timings;
    host;
    blocked;
    homes = new Map([[MAIN_HOME, newHome(MAIN_HOME)]]);
    lastViewerAt = 0;
    timer = null;
    /** The interval `timer` ticks at: TICK_MS while someone looks, the slow tick otherwise. */
    timerMs = 0;
    topicsRunning = 0;
    topicsWaiting = [];
    constructor(run, journal, offsets, timings, host, 
    /** Why the feed may not run now, or null when it may (binding.ts). */
    blocked) {
        this.run = run;
        this.journal = journal;
        this.offsets = offsets;
        this.timings = timings;
        this.host = host;
        this.blocked = blocked;
    }
    /** True while a viewer asked for the board recently enough to keep polling. */
    get active() {
        return Date.now() - this.lastViewerAt < this.timings.idleMs;
    }
    /** Starts reading on its own: slowly with nobody looking, on every home's interval once someone looks. */
    start() {
        this.arm();
    }
    /** Records that someone is looking, which starts or continues polling on every home's interval. */
    touch() {
        this.lastViewerAt = Date.now();
        this.arm();
    }
    stop() {
        if (this.timer !== null)
            clearInterval(this.timer);
        this.timer = null;
        this.timerMs = 0;
    }
    /** Makes the timer tick at the pace of now: often while someone looks, slowly otherwise. */
    arm() {
        const every = this.active ? TICK_MS : Math.min(SLOW_TICK_MS, this.timings.slowMs);
        if (this.timerMs === every)
            return;
        this.stop();
        this.timerMs = every;
        this.timer = setInterval(() => this.tick(), every);
    }
    /** How long after its last read a home is read while someone looks: its hint, else the default. */
    everyMs(home) {
        return home.everyMs === null ? this.timings.readMs : home.everyMs;
    }
    /** How long one read of a home may take: its hint, else the default. */
    timeoutMs(home) {
        return home.timeoutMs === null ? this.timings.timeoutMs : home.timeoutMs;
    }
    /** How long after its last read a home is read with nobody looking. */
    slowEveryMs(home) {
        const far = home.everyMs !== null && home.everyMs > this.timings.readMs;
        return far ? this.timings.slowFarMs : this.timings.slowMs;
    }
    /**
     * How long a good read of a home counts as current: the stale limit while
     * someone looks, twice the home's slow interval with nobody looking, so
     * the board's own reads keep it current.
     */
    staleAfterMs(home) {
        if (this.active)
            return this.timings.staleMs;
        return Math.max(this.timings.staleMs, 2 * this.slowEveryMs(home));
    }
    snapshots() {
        return [...this.homes.values()].map((home) => ({
            id: home.id,
            report: home.report,
            lastOkAt: home.lastOkAt,
            error: home.error,
            version: home.version,
            staleAfterMs: this.staleAfterMs(home),
        }));
    }
    hasMainReport() {
        return this.homes.get(MAIN_HOME).report !== null;
    }
    knows(home) {
        return this.homes.has(home);
    }
    /** When the last good read of each home began, epoch ms, for every home read well since the start. */
    goodReadsFrom() {
        const found = new Map();
        for (const home of this.homes.values())
            if (home.goodFrom !== null)
                found.set(home.id, home.goodFrom);
        return found;
    }
    /** Reads one home now (joining a read already in flight); resolves to whether it succeeded. */
    readNow(id) {
        const home = this.homes.get(id);
        if (home === undefined || this.blocked() !== null)
            return Promise.resolve(false);
        home.reading ??= this.readHome(home).finally(() => {
            home.reading = null;
            home.readAt = Date.now();
            home.dueAt = home.readAt + this.everyMs(home);
        });
        return home.reading;
    }
    /**
     * Reads one home with a read that starts after this call. A read already in
     * flight may predate what the caller wants to observe, so it is waited out
     * first rather than joined.
     */
    async readFresh(id) {
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
    async readTopics(id, tasks, deadline = Number.POSITIVE_INFINITY) {
        const home = this.homes.get(id);
        if (home === undefined || !this.mayAskTopics(home))
            return null;
        const done = await this.topicsTurn(home);
        try {
            if (this.homes.get(id) !== home || !this.mayAskTopics(home) || Date.now() >= deadline)
                return null;
            const result = await this.run({ kind: "topics", home: id, tasks }, this.timeoutMs(home));
            if (result.code === FEED_USAGE)
                home.topicsRefusedAt = home.report?.code_commit ?? UNREAD;
            return result.code === 0 ? parseTopicsAnswer(result.stdout, tasks) : null;
        }
        finally {
            done();
        }
    }
    mayAskTopics(home) {
        return home.topicsRefusedAt === null && this.blocked() === null;
    }
    /**
     * Waits until a topics call of `home` may start: fewer than MAX_TOPICS_CALLS
     * run and no read of the home runs. Both are checked in the same turn the
     * call is counted, so no read of the home starts in between. Returns what
     * ends the call's turn.
     */
    async topicsTurn(home) {
        for (;;) {
            if (this.topicsRunning >= MAX_TOPICS_CALLS)
                await new Promise((resume) => this.topicsWaiting.push(resume));
            else if (home.reading !== null)
                await Promise.allSettled([home.reading]);
            else
                break;
        }
        this.topicsRunning += 1;
        let finished;
        const call = new Promise((resolve) => {
            finished = resolve;
        });
        home.topicsCalls.add(call);
        return () => {
            home.topicsCalls.delete(call);
            finished?.();
            this.topicsRunning -= 1;
            for (const resume of this.topicsWaiting.splice(0))
                resume();
        };
    }
    /** Reads every home now, the main home first so new secondmates are included. */
    async refreshAll() {
        await this.readNow(MAIN_HOME);
        await Promise.all([...this.homes.keys()].filter((id) => id !== MAIN_HOME).map((id) => this.readNow(id)));
    }
    tick() {
        const { active } = this;
        if (!active)
            this.arm();
        const now = Date.now();
        for (const home of this.homes.values()) {
            const due = active ? home.dueAt : home.readAt + this.slowEveryMs(home);
            if (home.reading === null && due <= now)
                void this.readNow(home.id);
        }
    }
    async readHome(home) {
        while (home.topicsCalls.size > 0)
            await Promise.all(home.topicsCalls);
        const before = fingerprint(home);
        const eventsBefore = this.journal.events.length;
        for (let reads = 0; reads < MAX_CATCH_UP_READS; reads += 1) {
            const step = await this.readOnce(home);
            if (step === "blocked")
                return false;
            if (step === "done")
                break;
        }
        // A read that found nothing new must not look like a change, or every
        // viewer would redraw the whole page on every poll.
        if (fingerprint(home) !== before || this.journal.events.length !== eventsBefore)
            this.host.onChange();
        return home.error === null;
    }
    /** One feed call: the feed may not run now, the home has more to read at once, or this read is done. */
    async readOnce(home) {
        const { offset, sha } = this.offsets.get(home.id);
        const closed = this.host.closedCursor(home.id);
        const startedMs = Date.now();
        const result = await this.run({ kind: "feed", home: home.id, offset, sha, ...(closed === null ? {} : { closed }) }, this.timeoutMs(home));
        // The feed may not run now: nothing was read, and the page says why.
        if (result.blocked !== undefined)
            return "blocked";
        const more = result.code === 0
            ? this.accept(home, result.stdout, startedMs)
            : this.reject(home, result.code, result.stderr, closed !== null);
        return more ? "more" : "done";
    }
    /**
     * A failed read. Exit 4 says the home cannot report at all: its data is
     * dropped and the feed's one line becomes its banner. Any other failure keeps
     * the last report until it goes stale. A usage error to a read that passed
     * the closed decisions' cursor makes the host forget that cursor.
     */
    reject(home, code, stderr, cursorSent) {
        const text = stderr.trim();
        // A home whose code went back to before the cursor refuses it; read it without one next time.
        if (code === FEED_USAGE && cursorSent)
            this.host.onCursorRefused(home.id);
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
    accept(home, stdout, startedMs) {
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
        if (home.topicsRefusedAt === UNREAD)
            home.topicsRefusedAt = report.code_commit;
        if (home.topicsRefusedAt !== report.code_commit)
            home.topicsRefusedAt = null;
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
    storeLedger(home, report) {
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
    syncHomes(listed) {
        const ids = new Set(listed.map((entry) => entry.id));
        for (const id of this.homes.keys()) {
            if (id !== MAIN_HOME && !ids.has(id))
                this.homes.delete(id);
        }
        for (const entry of listed) {
            const home = this.homes.get(entry.id) ?? newHome(entry.id);
            home.everyMs = entry.read_every_s === null ? null : entry.read_every_s * 1000;
            home.timeoutMs = entry.read_timeout_s === null ? null : entry.read_timeout_s * 1000;
            this.homes.set(entry.id, home);
        }
    }
    refreshVersions() {
        const mainReport = this.homes.get(MAIN_HOME).report;
        const main = mainReport === null ? "" : mainReport.code_commit;
        for (const home of this.homes.values()) {
            if (home.report !== null)
                home.version = versionOf(home.id, home.report.code_commit, main);
        }
    }
}
/** Everything about a home that a viewer could see, apart from when it was last read. */
function fingerprint(home) {
    const { report } = home;
    const shown = report === null ? null : { ...report, ledger: null, closed_holds: null, closed_cursor: null };
    return JSON.stringify([home.error, home.version, shown]);
}
function versionOf(home, commit, mainCommit) {
    if (home === MAIN_HOME)
        return "same";
    if (mainCommit === "")
        return "unknown";
    return commit === mainCommit ? "same" : "different";
}
