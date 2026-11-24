// The JSON report the aggregator's feed prints for one home (contracts
// section 4), parsed and checked once where it enters the service.
import { isRecord, stringField, stringRecord, textField } from "./files.js";

export const REPORT_SCHEMA = 1;

export interface ReportTask {
  id: string;
  kind: string;
  state: string;
  source: string;
  detail: string;
  /** True when the home says the harness is still on the busy record seeded at spawn. */
  unstarted: boolean;
}

/** A backlog item that has not been dispatched yet. */
export interface ReportQueued {
  id: string;
  kind: string;
  title: string;
  /** Why the item is held, or null when nothing holds it. */
  hold: string | null;
  /** True when the hold is a question for the captain. */
  captain: boolean;
  /** Ids of unfinished items this one waits for. */
  blockers: string[];
  /**
   * The topic a "topic: <id>" line in the item's body names. Firstmate writes
   * that line on items it hands to a secondmate, whose home has no tag for the
   * item until it dispatches it.
   */
  topic_hint: string | null;
}

/** What answering a hold does to its item, as the aggregator recorded it on the hold. */
export type OnAnswer = "close" | "release";
const ON_ANSWER: readonly OnAnswer[] = ["close", "release"];

export const HOLD_BUCKETS = ["live", "aged", "dated", "blocked"] as const;
export type HoldBucket = (typeof HOLD_BUCKETS)[number];

export interface ReportHold {
  id: string;
  title: string;
  question: string;
  hold_bucket: HoldBucket;
  hold_until: string | null;
  unresolved_blocker_ids: string[];
  hold_age_days: number | null;
  origin: string;
  /** Null when the hold records no outcome, or the home's code is too old to report one. */
  on_answer: OnAnswer | null;
  /** When the hold was set ("Captain hold set:", UTC ISO or a date); null when unknown. */
  hold_set: string | null;
}

/** A decision that closed, as the home's backlog recorded it (contracts section 4). */
export interface ClosedHold {
  id: string;
  title: string;
  origin: string;
  /** The record's Resolution mode: answered, released, repaired, reconciled, forge-closed, forge-released, or "". */
  mode: string;
  answer: string;
  label: string;
  /** Where a keyed answer came from (for example "myshape"); "" for words recorded directly. */
  source: string;
  digest: string;
  /** Which hold of the task this was: 1 for the first, one more for each re-hold. */
  occurrence: number;
  /** Epoch seconds from the home's hold lines, or null when it has none. */
  opened_at: number | null;
  closed_at: number | null;
}

/** Where the board stopped reading a home's closed decisions in its archive. */
export interface ClosedCursor {
  status: "start" | "delta" | "continuity-broken" | "absent";
  to_offset: number;
  to_prefix_sha256: string;
  more: boolean;
}

export interface ReportQuestion {
  id: string;
  key: string;
  summary: string;
}

export interface ReportLedger {
  status: "delta" | "continuity-broken" | "absent";
  to_offset: number;
  to_prefix_sha256: string;
  more: boolean;
  lines: string[];
}

/**
 * A further home the aggregator reads, as the root report lists it. The ids
 * are labels the aggregator chose; the board reads every one the same way.
 * The two hints are seconds, already within READ_EVERY_S and READ_TIMEOUT_S,
 * or null when the report gave none (the board's default then applies).
 */
export interface FeedHome {
  id: string;
  read_every_s: number | null;
  read_timeout_s: number | null;
}

/** Who feeds the board, from the root report; every field is optional there. */
export interface Aggregator {
  name: string | null;
  /** The name the page and the board's texts use for the agent on the other side. */
  label: string | null;
  /** One line the version banners add after the board's own words. */
  update_hint: string | null;
}

export interface Bounds {
  min: number;
  max: number;
}

/** How often a further home may be read, and how long one read may take, in seconds. */
export const READ_EVERY_S: Bounds = { min: 1, max: 3600 };
export const READ_TIMEOUT_S: Bounds = { min: 1, max: 3600 };

export interface HomeReport {
  code_commit: string;
  ledger_enabled: boolean;
  tasks: ReportTask[];
  /** Empty for a home whose code does not report queued items yet. */
  queued: ReportQueued[];
  holds: ReportHold[];
  status_decisions: ReportQuestion[];
  /** Task id to the raw text of its tag file. */
  topics: Record<string, string>;
  ledger: ReportLedger;
  /** Why the ledger is off and what to do, from the aggregator; null when it gave none. */
  ledger_hint: string | null;
  /** Read only from the root report. */
  aggregator: Aggregator | null;
  /** The further homes; read only from the root report. */
  secondmates: FeedHome[];
  /** Empty for a home whose code does not report closed decisions. */
  closed_holds: ClosedHold[];
  /** Null for a home whose code does not report closed decisions. */
  closed_cursor: ClosedCursor | null;
}

export type ParsedReport =
  | { kind: "ok"; report: HomeReport }
  | { kind: "incompatible" }
  | { kind: "invalid" };

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** The strings of an array, or none when `value` is not one. */
export function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function onAnswerOf(value: unknown): OnAnswer | null {
  const found = ON_ANSWER.find((name) => name === value);
  return found === undefined ? null : found;
}

/** A hold with no bucket is due now; an unknown word drops the hold. */
function bucketOf(value: unknown): HoldBucket | null {
  if (value === undefined || value === null) return "live";
  const found = HOLD_BUCKETS.find((name) => name === value);
  return found === undefined ? null : found;
}

function parseHold(raw: Record<string, unknown>): ReportHold | null {
  const id = stringField(raw, "id");
  const bucket = bucketOf(raw["hold_bucket"]);
  if (id === null || bucket === null) return null;
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

function epochOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseClosedHold(raw: Record<string, unknown>): ClosedHold | null {
  const id = stringField(raw, "id");
  const digest = stringField(raw, "digest");
  const occurrence = raw["occurrence"];
  if (id === null || digest === null || typeof occurrence !== "number") return null;
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

const CURSOR_STATUSES = ["start", "delta", "continuity-broken", "absent"] as const;

function parseClosedCursor(raw: unknown): ClosedCursor | null {
  if (!isRecord(raw)) return null;
  const status = CURSOR_STATUSES.find((name) => name === raw["status"]);
  const offset = raw["to_offset"];
  const sha = stringField(raw, "to_prefix_sha256");
  if (status === undefined || typeof offset !== "number" || sha === null) return null;
  return { status, to_offset: offset, to_prefix_sha256: sha, more: raw["more"] === true };
}

function parseLedger(raw: unknown): ReportLedger | null {
  if (!isRecord(raw)) return null;
  const status = raw["status"];
  const offset = raw["to_offset"];
  const sha = stringField(raw, "to_prefix_sha256");
  if (status !== "delta" && status !== "continuity-broken" && status !== "absent") return null;
  if (typeof offset !== "number" || sha === null) return null;
  return {
    status,
    to_offset: offset,
    to_prefix_sha256: sha,
    more: raw["more"] === true,
    lines: strings(raw["lines"]),
  };
}

/** Builds an entry from a record that must carry a string `id`. */
function withId<T>(raw: Record<string, unknown>, build: (id: string) => T): T | null {
  const id = stringField(raw, "id");
  return id === null ? null : build(id);
}

/** A task's crew state; a report that omits it means the state is not known. */
function stateOf(raw: Record<string, unknown>): string {
  const state = stringField(raw, "state");
  return state === null ? "unknown" : state;
}

function parseTask(raw: Record<string, unknown>): ReportTask | null {
  return withId(raw, (id) => ({
    id,
    kind: textField(raw, "kind"),
    state: stateOf(raw),
    source: textField(raw, "source"),
    detail: textField(raw, "detail"),
    unstarted: raw["unstarted"] === true,
  }));
}

function parseQueued(raw: Record<string, unknown>): ReportQueued | null {
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
function seconds(value: unknown, bounds: Bounds): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

const HOME_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

function parseFeedHome(raw: Record<string, unknown>): FeedHome | null {
  const id = stringField(raw, "id");
  if (id === null || !HOME_ID.test(id) || id === "main") return null;
  return {
    id,
    read_every_s: seconds(raw["read_every_s"], READ_EVERY_S),
    read_timeout_s: seconds(raw["read_timeout_s"], READ_TIMEOUT_S),
  };
}

function parseAggregator(raw: unknown): Aggregator | null {
  if (!isRecord(raw)) return null;
  return {
    name: stringField(raw, "name"),
    label: stringField(raw, "label"),
    update_hint: stringField(raw, "update_hint"),
  };
}

function parseQuestion(raw: Record<string, unknown>): ReportQuestion | null {
  return withId(raw, (id) => ({
    id,
    key: textField(raw, "key"),
    summary: textField(raw, "summary"),
  }));
}

function present<T>(value: T | null): value is T {
  return value !== null;
}

export function parseReport(stdout: string): ParsedReport {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { kind: "invalid" };
  }
  if (!isRecord(raw)) return { kind: "invalid" };
  if (raw["schema"] !== REPORT_SCHEMA) return { kind: "incompatible" };
  const ledger = parseLedger(raw["ledger"]);
  if (ledger === null) return { kind: "invalid" };
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
