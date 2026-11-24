// The board's system records: what every change writes to events.jsonl, and
// who the board can attest made it. A change is a result that carries at
// least one record (topics.ts, todos.ts); store.ts commitChange is the only
// code that stamps and saves them.

/** Every kind of system record the board writes. */
export const RECORD_KINDS = [
  "topic.created",
  "topic.confirmed",
  "topic.merged",
  "topic.split",
  "topic.close_proposed",
  "topic.kept",
  "topic.archived",
  "topic.reopened",
  "topic.moved",
  "topic.renamed",
  "topic.goal_changed",
  "todo.opened",
  "todo.rewritten",
  "todo.claimed",
  "todo.rejected",
  "todo.obsolete",
  "todo.done",
  "todo.dropped",
  "todo.taken_down",
  "todo.marks_carried",
  "hold.opened",
  "hold.answered",
  "hold.closed",
  "agent.tagged",
  "program.confirmed",
  "writes.released",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/**
 * A record before it is saved. `text` is the line the page shows, with its
 * actor suffix when it has one; `item` names a hands-on item; `home` and
 * `task` name an agent; `outcome` and `reason` say how something ended or why.
 * A decision's records (decisions.ts) also carry `key`, which says what the
 * record is about so it is never written twice, `answer` and `source`, and
 * `at`, the time it happened when that is earlier than the save.
 */
export interface Draft {
  kind: RecordKind;
  topic: string | null;
  home?: string | null;
  task?: string | null;
  item?: string;
  outcome?: string;
  reason?: string;
  key?: string;
  answer?: string;
  source?: string;
  at?: number;
  text: string;
}

/** What a change must carry: one record at least. */
export type Records = readonly [Draft, ...Draft[]];

/**
 * Who made a change, as far as the board can attest: the holder of the page's
 * token (the captain), a local process through the socket (the aggregator,
 * by its label at the time), or the board itself at startup.
 */
export interface Actor {
  by: "captain" | "aggregator" | "board";
  label: string;
}

/** A saved record, as one `src: "board"` line of events.jsonl. */
export interface StoredRecord {
  src: "board";
  rid: string;
  ts: number;
  kind: string;
  topic: string | null;
  home: string | null;
  task: string | null;
  text: string;
  item?: string;
  by: string;
  label: string;
  outcome?: string;
  reason?: string;
  key?: string;
  answer?: string;
  source?: string;
}

/** The optional text fields a record may carry, in the order they are saved. */
export const OPTIONAL_TEXT_FIELDS = ["outcome", "reason", "key", "answer", "source"] as const;

/** Turns a draft into the record saved for it. */
export function stampRecord(draft: Draft, actor: Actor, rid: string, ts: number): StoredRecord {
  return {
    src: "board",
    rid,
    ts: draft.at ?? ts,
    kind: draft.kind,
    topic: draft.topic,
    home: draft.home ?? null,
    task: draft.task ?? null,
    ...(draft.item === undefined ? {} : { item: draft.item }),
    by: actor.by,
    label: actor.label,
    ...Object.fromEntries(
      OPTIONAL_TEXT_FIELDS.flatMap((name) =>
        draft[name] === undefined ? [] : [[name, draft[name]]],
      ),
    ),
    text: draft.text,
  };
}

/** A whole state, read only: only topics.ts, todos.ts and store.ts build the next one. */
export type Frozen<T> = T extends readonly (infer U)[]
  ? readonly Frozen<U>[]
  : T extends object
    ? { readonly [K in keyof T]: Frozen<T[K]> }
    : T;
