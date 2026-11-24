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
];
/** The optional text fields a record may carry, in the order they are saved. */
export const OPTIONAL_TEXT_FIELDS = ["outcome", "reason", "key", "answer", "source"];
/** Turns a draft into the record saved for it. */
export function stampRecord(draft, actor, rid, ts) {
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
        ...Object.fromEntries(OPTIONAL_TEXT_FIELDS.flatMap((name) => draft[name] === undefined ? [] : [[name, draft[name]]])),
        text: draft.text,
    };
}
