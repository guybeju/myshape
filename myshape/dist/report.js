// The JSON report the aggregator's feed prints for one home (contracts
// section 4), parsed and checked once where it enters the service.
import { isRecord, stringField, stringRecord, textField } from "./files.js";
export const REPORT_SCHEMA = 1;
const ON_ANSWER = ["close", "release"];
export const HOLD_BUCKETS = ["live", "aged", "dated", "blocked"];
/** How often a further home may be read, and how long one read may take, in seconds. */
export const READ_EVERY_S = { min: 1, max: 3600 };
export const READ_TIMEOUT_S = { min: 1, max: 3600 };
function records(value) {
    return Array.isArray(value) ? value.filter(isRecord) : [];
}
/** The strings of an array, or none when `value` is not one. */
export function strings(value) {
    return Array.isArray(value)
        ? value.filter((entry) => typeof entry === "string")
        : [];
}
function onAnswerOf(value) {
    const found = ON_ANSWER.find((name) => name === value);
    return found === undefined ? null : found;
}
/** A hold with no bucket is due now; an unknown word drops the hold. */
function bucketOf(value) {
    if (value === undefined || value === null)
        return "live";
    const found = HOLD_BUCKETS.find((name) => name === value);
    return found === undefined ? null : found;
}
function parseHold(raw) {
    const id = stringField(raw, "id");
    const bucket = bucketOf(raw["hold_bucket"]);
    if (id === null || bucket === null)
        return null;
    const age = raw["hold_age_days"];
    return {
        id,
        title: textField(raw, "title"),
        question: textField(raw, "question"),
        hold_bucket: bucket,
        hold_until: stringField(raw, "hold_until"),
        unresolved_blocker_ids: strings(raw["unresolved_blocker_ids"]),
        hold_age_days: typeof age === "number" ? age : null,
        origin: textField(raw, "origin"),
        on_answer: onAnswerOf(raw["on_answer"]),
        hold_set: stringField(raw, "hold_set"),
    };
}
function epochOrNull(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function parseClosedHold(raw) {
    const id = stringField(raw, "id");
    const digest = stringField(raw, "digest");
    const occurrence = raw["occurrence"];
    if (id === null || digest === null || typeof occurrence !== "number")
        return null;
    return {
        id,
        title: textField(raw, "title"),
        origin: textField(raw, "origin"),
        mode: textField(raw, "mode"),
        answer: textField(raw, "answer"),
        label: textField(raw, "label"),
        source: textField(raw, "source"),
        digest,
        occurrence,
        opened_at: epochOrNull(raw["opened_at"]),
        closed_at: epochOrNull(raw["closed_at"]),
    };
}
const CURSOR_STATUSES = ["start", "delta", "continuity-broken", "absent"];
function parseClosedCursor(raw) {
    if (!isRecord(raw))
        return null;
    const status = CURSOR_STATUSES.find((name) => name === raw["status"]);
    const offset = raw["to_offset"];
    const sha = stringField(raw, "to_prefix_sha256");
    if (status === undefined || typeof offset !== "number" || sha === null)
        return null;
    return { status, to_offset: offset, to_prefix_sha256: sha, more: raw["more"] === true };
}
function parseLedger(raw) {
    if (!isRecord(raw))
        return null;
    const status = raw["status"];
    const offset = raw["to_offset"];
    const sha = stringField(raw, "to_prefix_sha256");
    if (status !== "delta" && status !== "continuity-broken" && status !== "absent")
        return null;
    if (typeof offset !== "number" || sha === null)
        return null;
    return {
        status,
        to_offset: offset,
        to_prefix_sha256: sha,
        more: raw["more"] === true,
        lines: strings(raw["lines"]),
    };
}
/** Builds an entry from a record that must carry a string `id`. */
function withId(raw, build) {
    const id = stringField(raw, "id");
    return id === null ? null : build(id);
}
/** A task's crew state; a report that omits it means the state is not known. */
function stateOf(raw) {
    const state = stringField(raw, "state");
    return state === null ? "unknown" : state;
}
function parseTask(raw) {
    return withId(raw, (id) => ({
        id,
        kind: textField(raw, "kind"),
        state: stateOf(raw),
        source: textField(raw, "source"),
        detail: textField(raw, "detail"),
        unstarted: raw["unstarted"] === true,
    }));
}
function parseQueued(raw) {
    return withId(raw, (id) => ({
        id,
        kind: textField(raw, "kind"),
        title: textField(raw, "title"),
        hold: stringField(raw, "hold"),
        captain: raw["captain"] === true,
        blockers: strings(raw["blockers"]),
        topic_hint: stringField(raw, "topic_hint"),
    }));
}
/** A number of seconds within `bounds`, or null when `value` is not a finite number. */
function seconds(value, bounds) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return null;
    return Math.min(bounds.max, Math.max(bounds.min, value));
}
const HOME_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
function parseFeedHome(raw) {
    const id = stringField(raw, "id");
    if (id === null || !HOME_ID.test(id) || id === "main")
        return null;
    return {
        id,
        read_every_s: seconds(raw["read_every_s"], READ_EVERY_S),
        read_timeout_s: seconds(raw["read_timeout_s"], READ_TIMEOUT_S),
    };
}
function parseAggregator(raw) {
    if (!isRecord(raw))
        return null;
    return {
        name: stringField(raw, "name"),
        label: stringField(raw, "label"),
        update_hint: stringField(raw, "update_hint"),
    };
}
function parseQuestion(raw) {
    return withId(raw, (id) => ({
        id,
        key: textField(raw, "key"),
        summary: textField(raw, "summary"),
    }));
}
function present(value) {
    return value !== null;
}
export function parseReport(stdout) {
    let raw;
    try {
        raw = JSON.parse(stdout);
    }
    catch {
        return { kind: "invalid" };
    }
    if (!isRecord(raw))
        return { kind: "invalid" };
    if (raw["schema"] !== REPORT_SCHEMA)
        return { kind: "incompatible" };
    const ledger = parseLedger(raw["ledger"]);
    if (ledger === null)
        return { kind: "invalid" };
    return {
        kind: "ok",
        report: {
            code_commit: textField(raw, "code_commit"),
            ledger_enabled: raw["ledger_enabled"] === true,
            tasks: records(raw["tasks"]).map(parseTask).filter(present),
            queued: records(raw["queued"]).map(parseQueued).filter(present),
            holds: records(raw["holds"]).map(parseHold).filter(present),
            status_decisions: records(raw["status_decisions"]).map(parseQuestion).filter(present),
            topics: stringRecord(raw["topics"]),
            ledger,
            ledger_hint: stringField(raw, "ledger_hint"),
            aggregator: parseAggregator(raw["aggregator"]),
            secondmates: records(raw["secondmates"]).map(parseFeedHome).filter(present),
            closed_holds: records(raw["closed_holds"]).map(parseClosedHold).filter(present),
            closed_cursor: parseClosedCursor(raw["closed_cursor"]),
        },
    };
}
/**
 * The tag files a feed's topics call printed: `{"topics": {"<task>": "<tag text>"}}`,
 * the same shape and meaning as a report's `topics` (C7). Only the tasks asked
 * for are kept; a task left out has no tag file.
 *
 * Returns:
 *   The tag texts by task, or null when the output is not that shape, which
 *   the board reads as "not supported or failed".
 */
export function parseTopicsAnswer(stdout, tasks) {
    let raw;
    try {
        raw = JSON.parse(stdout);
    }
    catch {
        return null;
    }
    if (!isRecord(raw) || !isRecord(raw["topics"]))
        return null;
    const given = raw["topics"];
    // No prototype, so a task named __proto__ is kept like any other.
    const found = Object.create(null);
    for (const task of tasks) {
        if (!Object.hasOwn(given, task))
            continue;
        const text = given[task];
        if (typeof text !== "string")
            return null;
        found[task] = text;
    }
    return found;
}
