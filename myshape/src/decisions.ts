// The records of decisions (captain holds) that open and close outside the
// page, from what each read of a home reports: an opening when a hold is
// first seen, and a close for each closed decision the home reports
// (contracts sections 3.3 and 4). Each record carries a key, so the journal
// never takes the same opening or close twice, and decisions.json keeps what
// the last read of each home showed, so a read never records what was already
// there before the board started watching.
import { isRecord, readJsonFile, stringField, writeFileAtomic } from "./files.js";
import type { Draft } from "./records.js";
import { strings } from "./report.js";
import type { ClosedHold, HomeReport, ReportHold } from "./report.js";
import { shortTime } from "./todos.js";

const FILE_MODE = 0o644;
const LINE_MAX = 200;
/** The source of an answer the page itself sent: its own hold.answered record is that close. */
export const PAGE_SOURCE = "myshape";

/**
 * What the board knows of an answer it sent itself: its hold.answered record
 * is saved, its write is still under way, or neither (the write ended without
 * being delivered, or the answer was given through the same intake by hand).
 */
export type PageAnswer = "recorded" | "pending" | "none";

/** What the board saw at its last good read of one home. */
export interface HomeDecisions {
  /** The code the home's reader ran; across a change a hold is matched by its task alone. */
  code_commit: string;
  /** Where the closed decisions' archive was read up to; null until the home reported one. */
  cursor: { offset: number; sha: string } | null;
  /** "<task>\t<hold set>" of every open decision that read showed. */
  openSeen: string[];
  /** "<task>\t<digest>" of every closed decision that read showed. */
  closedSeen: string[];
  /**
   * When the read that last changed this entry started, in epoch seconds: every
   * hold open then and seen since was set before it. Null in an entry an older
   * board wrote.
   */
  seenAt: number | null;
}

export interface DecisionRead {
  home: string;
  /** What the last good read of this home showed; undefined before the first. */
  previous: HomeDecisions | undefined;
  report: HomeReport;
  /** When this read finished, in epoch seconds. */
  readAt: number;
  /** When this read started, in epoch seconds. */
  readStartedAt: number;
  /** True when a record with this key is already saved. */
  saved: (key: string) => boolean;
  /** The topic a decision of `task` (raised by `origin`) belongs to. */
  topicOf: (task: string, origin: string) => string | null;
  /** What the board knows of its own answer to `task` that the home recorded as one of `answers`. */
  pageAnswer: (task: string, answers: string[]) => PageAnswer;
}

export interface DecisionStep {
  drafts: Draft[];
  next: HomeDecisions;
}

function oneLine(text: string): string {
  const line = (text.split("\n")[0] ?? "").trim();
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}…` : line;
}

/** Epoch seconds of a "Captain hold set:" stamp with a time; null for a date or nothing. */
export function holdSetSeconds(stamp: string | null): number | null {
  if (stamp === null || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(stamp)) return null;
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function named(title: string): string {
  const shown = oneLine(title);
  return shown === "" ? "待決事項" : `待決事項「${shown}」`;
}

/** The time of a record and, when the home did not say, the words that say it is a bound. */
function timing(at: number | null, readAt: number): { at: number; suffix: string } {
  if (at !== null) return { at, suffix: "" };
  return {
    at: readAt,
    suffix: `（最晚 ${shortTime(new Date(readAt * 1000).toISOString()) ?? ""}）`,
  };
}

function openKey(home: string, task: string, holdSet: string): string {
  return `hold.opened\t${home}\t${task}\t${holdSet}`;
}

function closeKey(home: string, task: string, digest: string): string {
  return `hold.closed\t${home}\t${task}\t${digest}`;
}

function openingOf(read: DecisionRead, hold: ReportHold): Draft {
  const when = timing(holdSetSeconds(hold.hold_set), read.readAt);
  const question = oneLine(hold.question);
  return {
    kind: "hold.opened",
    topic: read.topicOf(hold.id, hold.origin),
    home: read.home,
    task: hold.id,
    key: openKey(read.home, hold.id, hold.hold_set ?? ""),
    at: when.at,
    text: `${named(hold.title)}已開${question === "" ? "" : `：${question}`}${when.suffix}`,
  };
}

/** Where the answer came from, as the page says it. */
function viaWords(source: string): string {
  if (source === "") return "聊天";
  return source === PAGE_SOURCE ? "看板" : source;
}

const answeredWords = (said: string, via: string): string => `已回答${said}（經${via}）`;

/** What a close says happened, by the record's Resolution mode. */
const CLOSE_WORDS = new Map<string, (said: string, via: string) => string>([
  ["", answeredWords],
  ["answered", answeredWords],
  ["routed", answeredWords],
  ["repaired", (said, via) => `已回答${said}（經${via}，事後補記）`],
  ["released", (said, via) => `已回答並放行，工作繼續${said}（經${via}）`],
  ["reconciled", (said) => `已對帳結束，不必再答${said}`],
  ["forge-closed", (said) => `隨 PR 結束而關閉${said}`],
  ["forge-released", (said) => `隨 PR 結束而放行，工作繼續${said}`],
]);

function closeWords(closed: ClosedHold): string {
  const answer = oneLine(closed.label === "" ? closed.answer : closed.label);
  const said = answer === "" ? "" : `：${answer}`;
  const words = CLOSE_WORDS.get(closed.mode);
  return words === undefined
    ? `已結束（${closed.mode}）${said}`
    : words(said, viaWords(closed.source));
}

function closeOf(read: DecisionRead, closed: ClosedHold): Draft {
  const when = timing(closed.closed_at, read.readAt);
  return {
    kind: "hold.closed",
    topic: read.topicOf(closed.id, closed.origin),
    home: read.home,
    task: closed.id,
    key: closeKey(read.home, closed.id, closed.digest),
    at: when.at,
    outcome: closed.mode === "" ? "answered" : closed.mode,
    answer: closed.answer,
    source: closed.source === "" ? "chat" : closed.source,
    text: `${named(closed.title)}${closeWords(closed)}${when.suffix}`,
  };
}

function gapOpenKey(home: string, closed: ClosedHold): string {
  return `hold.opened\t${home}\t${closed.id}\t#${closed.digest}`;
}

/** The opening of a decision that opened and closed between two reads, when the home timed it. */
function gapOpeningOf(read: DecisionRead, closed: ClosedHold, at: number): Draft {
  return {
    kind: "hold.opened",
    topic: read.topicOf(closed.id, closed.origin),
    home: read.home,
    task: closed.id,
    key: gapOpenKey(read.home, closed),
    at,
    text: `${named(closed.title)}已開`,
  };
}

/**
 * Whether a hold was open at the last good read. On the same reader code a
 * hold is its task and its set time; a reader on other code may describe the
 * same hold differently (an older one reports no set time), so across a code
 * change a hold whose task was open then counts as seen, whatever its set time.
 */
function seenBefore(previous: HomeDecisions, sameCode: boolean): (hold: ReportHold) => boolean {
  const seen = new Set(
    sameCode ? previous.openSeen : previous.openSeen.map((key) => key.split("\t")[0] ?? key),
  );
  return (hold) => seen.has(sameCode ? `${hold.id}\t${hold.hold_set ?? ""}` : hold.id);
}

/**
 * Whether a hold unseen across a code change was set since the entry last
 * changed: one set earlier was there all along and only the new reader shows
 * it. Without an exact set time, or in an entry an older board wrote, nothing
 * tells, so that read keeps the baseline.
 */
function setSince(hold: ReportHold, since: number | null): boolean {
  const set = holdSetSeconds(hold.hold_set);
  return since !== null && set !== null && set >= since;
}

function openingsOf(read: DecisionRead): Draft[] {
  const { previous, report } = read;
  // A first read is where watching starts: what it shows was there before.
  if (previous === undefined) return [];
  const sameCode = previous.code_commit === report.code_commit;
  const seen = seenBefore(previous, sameCode);
  return report.holds
    .filter((hold) => !seen(hold))
    .filter((hold) => sameCode || setSince(hold, previous.seenAt))
    .filter((hold) => !read.saved(openKey(read.home, hold.id, hold.hold_set ?? "")))
    .map((hold) => openingOf(read, hold));
}

/** Whether a closed decision is new to the board: not seen at the last read and not saved. */
function isNewClose(read: DecisionRead, seen: Set<string>, closed: ClosedHold): boolean {
  if (seen.has(`${closed.id}\t${closed.digest}`)) return false;
  return !read.saved(closeKey(read.home, closed.id, closed.digest));
}

/** How the board knows of a close the page may have sent itself; "none" for any other source. */
function pageAnswerOf(read: DecisionRead, closed: ClosedHold): PageAnswer {
  if (closed.source !== PAGE_SOURCE) return "none";
  return read.pageAnswer(
    closed.id,
    [closed.answer, closed.label].filter((word) => word !== ""),
  );
}

interface Closes {
  drafts: Draft[];
  /** Closes of answers the page is still sending: read again next time, not remembered yet. */
  waiting: string[];
}

function closesOf(read: DecisionRead): Closes {
  const { previous, report } = read;
  // Without a cursor the read started at the present: every close it shows was there before.
  if (report.closed_cursor === null || previous === undefined || previous.cursor === null)
    return { drafts: [], waiting: [] };
  const seen = new Set(previous.closedSeen);
  const wasOpen = new Set(previous.openSeen.map((key) => key.split("\t")[0] ?? key));
  const result: Closes = { drafts: [], waiting: [] };
  for (const closed of report.closed_holds.filter((each) => isNewClose(read, seen, each))) {
    const page = pageAnswerOf(read, closed);
    if (page === "pending") result.waiting.push(`${closed.id}\t${closed.digest}`);
    if (page === "none") result.drafts.push(...closeDrafts(read, wasOpen, closed));
  }
  return result;
}

/** A close, after its opening when the decision opened and closed unseen and the home timed it. */
function closeDrafts(read: DecisionRead, wasOpen: Set<string>, closed: ClosedHold): Draft[] {
  const unseenOpen = !wasOpen.has(closed.id) && !read.saved(gapOpenKey(read.home, closed));
  if (closed.opened_at === null || !unseenOpen) return [closeOf(read, closed)];
  return [gapOpeningOf(read, closed, closed.opened_at), closeOf(read, closed)];
}

/**
 * The records one good read of a home leaves, and what to remember of it. A
 * hold not seen at the last read gets an opening at its set time; a closed
 * decision not seen before gets a close at the time the home's hold line
 * gives, or "at the latest" this read. A close the page sent itself (source
 * myshape) is its hold.answered record and leaves none; while that answer is
 * still being sent it waits, with the cursor kept, for a later read; when the
 * page has no record of it, the close is written like any other.
 */
export function decisionStep(read: DecisionRead): DecisionStep {
  const { report, previous } = read;
  const cursor = report.closed_cursor;
  const closes = closesOf(read);
  const waiting = new Set(closes.waiting);
  const kept = waiting.size > 0 && previous !== undefined ? previous.cursor : undefined;
  const seen = {
    code_commit: report.code_commit,
    cursor:
      kept ?? (cursor === null ? null : { offset: cursor.to_offset, sha: cursor.to_prefix_sha256 }),
    openSeen: report.holds.map((hold) => `${hold.id}\t${hold.hold_set ?? ""}`),
    closedSeen: report.closed_holds
      .map((closed) => `${closed.id}\t${closed.digest}`)
      .filter((key) => !waiting.has(key)),
  };
  return {
    drafts: [...openingsOf(read), ...closes.drafts],
    next: { ...seen, seenAt: seenAtOf(previous, seen, read.readStartedAt) },
  };
}

/** The entry's seenAt: kept while nothing it holds changed, else this read's start. */
function seenAtOf(
  previous: HomeDecisions | undefined,
  seen: Omit<HomeDecisions, "seenAt">,
  startedAt: number,
): number {
  if (previous === undefined || previous.seenAt === null) return startedAt;
  const { seenAt, ...before } = previous;
  return JSON.stringify(before) === JSON.stringify(seen) ? seenAt : startedAt;
}

function parseCursor(raw: unknown): HomeDecisions["cursor"] {
  if (!isRecord(raw)) return null;
  const sha = stringField(raw, "sha");
  const offset = raw["offset"];
  return typeof offset === "number" && sha !== null ? { offset, sha } : null;
}

function parseHome(raw: unknown): HomeDecisions | null {
  if (!isRecord(raw)) return null;
  return {
    code_commit: stringField(raw, "code_commit") ?? "",
    cursor: parseCursor(raw["cursor"]),
    openSeen: strings(raw["open_seen"]),
    closedSeen: strings(raw["closed_seen"]),
    seenAt: typeof raw["seen_at"] === "number" ? raw["seen_at"] : null,
  };
}

/**
 * data/myshape/decisions.json, the one place that keeps it. It is saved after
 * a read's records, so a crash in between reads that piece again and the
 * records' keys keep it from being recorded twice. A missing or unreadable
 * file is a board that has not watched any home yet.
 */
export class DecisionStore {
  private readonly homes = new Map<string, HomeDecisions>();

  constructor(private readonly file: string) {
    let raw: unknown = null;
    try {
      raw = readJsonFile(file);
    } catch {
      raw = null;
    }
    if (!isRecord(raw) || raw["v"] !== 1 || !isRecord(raw["homes"])) return;
    for (const [home, value] of Object.entries(raw["homes"])) {
      const parsed = parseHome(value);
      if (parsed !== null) this.homes.set(home, parsed);
    }
  }

  get(home: string): HomeDecisions | undefined {
    return this.homes.get(home);
  }

  /** Remembers a home's last read; the file is rewritten only when something changed. */
  set(home: string, value: HomeDecisions): void {
    if (JSON.stringify(this.homes.get(home)) === JSON.stringify(value)) return;
    this.homes.set(home, value);
    this.save();
  }

  /** Forgets a home, so its next read starts watching again. */
  forget(home: string): void {
    if (!this.homes.delete(home)) return;
    this.save();
  }

  private save(): void {
    const homes = Object.fromEntries(
      [...this.homes].map(([home, value]) => [
        home,
        {
          code_commit: value.code_commit,
          cursor: value.cursor,
          open_seen: value.openSeen,
          closed_seen: value.closedSeen,
          seen_at: value.seenAt,
        },
      ]),
    );
    writeFileAtomic(this.file, `${JSON.stringify({ v: 1, homes }, null, 2)}\n`, FILE_MODE);
  }
}
