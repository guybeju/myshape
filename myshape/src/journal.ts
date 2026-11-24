// The board's own append-only files: the event journal (every home's ledger
// events plus the board's system records), the milestone summaries, and the
// per-home ledger offsets.
import {
  appendLine,
  appendLineDurable,
  isRecord,
  readCompleteLines,
  readJsonFile,
  stringField,
  textField,
  writeFileAtomic,
} from "./files.js";
import type { BoardPaths } from "./layout.js";
import type { StoredRecord } from "./records.js";
import path from "node:path";

const FILE_MODE = 0o644;
export const MAIN_HOME = "main";

export interface LedgerEvent {
  src: "ledger";
  home: string;
  /** Seconds since the epoch, as the ledger recorded it. */
  ts: number;
  event: string;
  task: string;
  fields: Record<string, unknown>;
}

export interface BoardEvent {
  src: "board";
  /** The record's id, the key replay dedupes on; lines written before records had one have none. */
  rid?: string;
  ts: number;
  kind: string;
  topic: string | null;
  home: string | null;
  task: string | null;
  text: string;
  /** A hands-on item's records: the item, who made the step, and how it ended or why. */
  item?: string;
  by?: string;
  label?: string;
  outcome?: string;
  reason?: string;
  /** A decision's records: what the record is about, the answer, and where it was answered. */
  key?: string;
  answer?: string;
  source?: string;
}

const OPTIONAL_BOARD_FIELDS = [
  "rid",
  "item",
  "by",
  "label",
  "outcome",
  "reason",
  "key",
  "answer",
  "source",
] as const;

export type JournalEvent = LedgerEvent | BoardEvent;

function parseLedgerLine(home: string, raw: string): LedgerEvent | null {
  let line: unknown;
  try {
    line = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(line)) return null;
  const event = stringField(line, "event");
  const task = stringField(line, "task");
  const ts = line["ts"];
  if (event === null || task === null || typeof ts !== "number") return null;
  return { src: "ledger", home, ts, event, task, fields: line };
}

function parseStoredLedger(stored: Record<string, unknown>): {
  event: JournalEvent | null;
  key: string | null;
} {
  const home = stringField(stored, "home");
  const raw = stringField(stored, "raw");
  if (home === null || raw === null) return { event: null, key: null };
  return { event: parseLedgerLine(home, raw), key: `${home}\n${raw}` };
}

function parseStoredBoard(stored: Record<string, unknown>): BoardEvent | null {
  const ts = stored["ts"];
  const kind = stringField(stored, "kind");
  if (typeof ts !== "number" || kind === null) return null;
  return {
    src: "board",
    ts,
    kind,
    topic: stringField(stored, "topic"),
    home: stringField(stored, "home"),
    task: stringField(stored, "task"),
    text: textField(stored, "text"),
    ...Object.fromEntries(
      OPTIONAL_BOARD_FIELDS.flatMap((name) => {
        const value = stringField(stored, name);
        return value === null ? [] : [[name, value]];
      }),
    ),
  };
}

function parseStored(text: string): { event: JournalEvent | null; key: string | null } {
  let stored: unknown;
  try {
    stored = JSON.parse(text);
  } catch {
    return { event: null, key: null };
  }
  if (!isRecord(stored)) return { event: null, key: null };
  if (stored["src"] === "ledger") return parseStoredLedger(stored);
  return { event: stored["src"] === "board" ? parseStoredBoard(stored) : null, key: null };
}

/** Every event the board knows, in the order it learned them. */
export class Journal {
  readonly events: JournalEvent[] = [];
  private readonly seen = new Set<string>();
  private readonly rids = new Set<string>();
  private readonly keys = new Set<string>();

  constructor(private readonly file: string) {
    for (const line of readCompleteLines(file)) {
      const { event, key } = parseStored(line);
      if (key !== null) this.seen.add(key);
      if (event?.src === "board") this.index(event);
      if (event !== null) this.events.push(event);
    }
  }

  /** Remembers a saved record's id and what it is about, for replay and for decisions. */
  private index(record: { rid?: string; key?: string }): void {
    if (record.rid !== undefined) this.rids.add(record.rid);
    if (record.key !== undefined) this.keys.add(record.key);
  }

  /** True when the record with this id is already saved. */
  hasRecord(rid: string): boolean {
    return this.rids.has(rid);
  }

  /** True when a record about `key` (a decision's opening or close) is already saved. */
  hasKey(key: string): boolean {
    return this.keys.has(key);
  }

  /** Stores the ledger lines not seen before for `home`; returns how many were new. */
  appendLedger(home: string, rawLines: string[]): number {
    let added = 0;
    for (const raw of rawLines) {
      const key = `${home}\n${raw}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      appendLine(this.file, JSON.stringify({ src: "ledger", home, raw }), FILE_MODE);
      const event = parseLedgerLine(home, raw);
      if (event !== null) this.events.push(event);
      added += 1;
    }
    return added;
  }

  /** Saves one system record, on disk before it returns; only store.ts commitChange calls it. */
  appendRecord(record: StoredRecord): void {
    appendLineDurable(this.file, JSON.stringify(record), FILE_MODE);
    this.index(record);
    this.events.push(record);
  }
}

export const SUMMARY_KINDS = ["ready", "report", "failed", "landed"] as const;
export type SummaryKind = (typeof SUMMARY_KINDS)[number];
export const SUMMARY_MAX = 600;

export interface Summary {
  ts: number;
  home: string;
  task: string;
  kind: SummaryKind;
  text: string;
}

function parseSummary(text: string): Summary | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const kind = SUMMARY_KINDS.find((name) => name === raw["kind"]);
  const home = stringField(raw, "home");
  const task = stringField(raw, "task");
  const body = stringField(raw, "text");
  const ts = raw["ts"];
  if (
    kind === undefined ||
    home === null ||
    task === null ||
    body === null ||
    typeof ts !== "number"
  )
    return null;
  return { ts, home, task, kind, text: body };
}

/** A stored line that takes one earlier summary off the board; `text` is the reason. */
interface Retraction {
  ts: number;
  home: string;
  task: string;
  kind: "retract";
  text: string;
  target: { kind: SummaryKind; ts: number; text: string };
}

function parseRetraction(text: string): Retraction | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw["kind"] !== "retract" || !isRecord(raw["target"])) return null;
  // A retraction's target has the shape of a summary of the same home and task.
  const target = parseSummary(JSON.stringify({ ...raw, ...raw["target"] }));
  const reason = stringField(raw, "text");
  const ts = raw["ts"];
  if (target === null || reason === null || typeof ts !== "number") return null;
  return {
    ts,
    home: target.home,
    task: target.task,
    kind: "retract",
    text: reason,
    target: { kind: target.kind, ts: target.ts, text: target.text },
  };
}

export class Summaries {
  /** The summaries in effect: every stored one that was not retracted later. */
  readonly all: Summary[] = [];

  constructor(private readonly file: string) {
    for (const line of readCompleteLines(file)) {
      const summary = parseSummary(line);
      if (summary !== null) this.all.push(summary);
      else this.drop(parseRetraction(line));
    }
  }

  private drop(retraction: Retraction | null): void {
    if (retraction === null) return;
    const { target } = retraction;
    const at = this.all.findLastIndex(
      (known) =>
        known.home === retraction.home &&
        known.task === retraction.task &&
        known.kind === target.kind &&
        known.ts === target.ts &&
        known.text === target.text,
    );
    if (at !== -1) this.all.splice(at, 1);
  }

  /** Stores `summary` unless an identical one is in effect; returns whether it was new. */
  add(summary: Summary): boolean {
    const duplicate = this.all.some(
      (known) =>
        known.home === summary.home &&
        known.task === summary.task &&
        known.kind === summary.kind &&
        known.text === summary.text,
    );
    if (duplicate) return false;
    appendLine(this.file, JSON.stringify(summary), FILE_MODE);
    this.all.push(summary);
    return true;
  }

  /**
   * Takes the latest summary of `wanted.kind` for the task off the board and
   * returns it, or null when there is none. The line stays on file; the
   * retraction, with `wanted.text` as its reason, is appended after it.
   */
  retract(wanted: Summary): Summary | null {
    const gone = this.all.findLast(
      (known) =>
        known.home === wanted.home && known.task === wanted.task && known.kind === wanted.kind,
    );
    if (gone === undefined) return null;
    const retraction: Retraction = {
      ts: wanted.ts,
      home: wanted.home,
      task: wanted.task,
      kind: "retract",
      text: wanted.text,
      target: { kind: gone.kind, ts: gone.ts, text: gone.text },
    };
    appendLine(this.file, JSON.stringify(retraction), FILE_MODE);
    this.drop(retraction);
    return gone;
  }
}

export interface LedgerCursor {
  offset: number;
  sha: string;
}

/** Where the board stopped reading each home's ledger. */
export class Offsets {
  private readonly cursors = new Map<string, LedgerCursor>();
  private readonly file: string;

  constructor(paths: BoardPaths) {
    this.file = path.join(paths.boardDataDir, "offsets.json");
    let raw: unknown = null;
    try {
      raw = readJsonFile(this.file);
    } catch {
      raw = null;
    }
    if (!isRecord(raw)) return;
    for (const [home, cursor] of Object.entries(raw)) {
      if (!isRecord(cursor)) continue;
      const sha = stringField(cursor, "sha");
      if (typeof cursor["offset"] === "number" && sha !== null) {
        this.cursors.set(home, { offset: cursor["offset"], sha });
      }
    }
  }

  get(home: string): LedgerCursor {
    const cursor = this.cursors.get(home);
    return cursor === undefined ? { offset: 0, sha: "-" } : cursor;
  }

  /** Remembers the cursor; the file is rewritten only when the cursor moved. */
  set(home: string, cursor: LedgerCursor): void {
    const current = this.get(home);
    if (current.offset === cursor.offset && current.sha === cursor.sha) return;
    this.cursors.set(home, cursor);
    writeFileAtomic(
      this.file,
      `${JSON.stringify(Object.fromEntries(this.cursors), null, 2)}\n`,
      FILE_MODE,
    );
  }
}
