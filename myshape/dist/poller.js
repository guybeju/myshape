import { MAIN_HOME } from "./journal.js";
import { parseReport, parseTopicsAnswer } from "./report.js";
export const DEFAULT_TIMINGS = {
    readMs: 10_000,
    timeoutMs: 60_000,
    idleMs: 120_000,
    staleMs: 180_000,
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
    /** Records that someone is looking, which starts or continues scheduled polling. */
    touch() {
        this.lastViewerAt = Date.now();
        this.timer ??= setInterval(() => this.tick(), TICK_MS);
    }
    stop() {
        if (this.timer !== null)
            clearInterval(this.timer);
        this.timer = null;
    }
    snapshots() {
        return [...this.homes.values()].map(({ id, report, lastOkAt, error, version }) => ({
            id,
            report,
            lastOkAt,
            error,
            version,
        }));
    }
    hasMainReport() {
        return this.homes.get(MAIN_HOME).report !== null;
    }
    knows(home) {
        return this.homes.has(home);
    }
    /** Reads one home now (joining a read already in flight); resolves to whether it succeeded. */
    readNow(id) {
        const home = this.homes.get(id);
        if (home === undefined || this.blocked() !== null)
            return Promise.resolve(false);
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
            const result = await this.run({ kind: "topics", home: id, tasks }, home.timeoutMs ?? this.timings.timeoutMs);
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
        if (!this.active) {
            this.stop();
            return;
        }
        const now = Date.now();
        for (const home of this.homes.values()) {
            if (home.reading === null && home.dueAt <= now)
                void this.readNow(home.id);
        }
    }
    async readHome(home) {
        while (home.topicsCalls.size > 0)
            await Promise.all(home.topicsCalls);
        const before = fingerprint(home);
        const eventsBefore = this.journal.events.length;
        for (let reads = 0; reads < MAX_CATCH_UP_READS; reads += 1) {
            const { offset, sha } = this.offsets.get(home.id);
            const closed = this.host.closedCursor(home.id);
            const startedAt = Math.floor(Date.now() / 1000);
            const result = await this.run({ kind: "feed", home: home.id, offset, sha, ...(closed === null ? {} : { closed }) }, home.timeoutMs ?? this.timings.timeoutMs);
            // The feed may not run now: nothing was read, and the page says why.
            if (result.blocked !== undefined)
                return false;
            const more = result.code === 0
                ? this.accept(home, result.stdout, startedAt)
                : this.reject(home, result.code, result.stderr, closed !== null);
            if (!more)
                break;
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
    /** Applies one successful read; returns whether the home has more ledger to read right away. */
    accept(home, stdout, startedAt) {
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
