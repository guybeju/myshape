// Loads the board's state files and is their only writer. A change and its
// records are saved together: commitChange renames the change's commit file
// (topics.json, todos.json, confirmations.json or hashtags.json) with the
// records in its `outbox`, then appends them to events.jsonl,
// and every later commit (and every start) first saves any outbox record the
// journal still lacks.
import fs from "node:fs";
import { isRecord, readJsonFile, stringField, stringRecord, textField, writeFileAtomic, } from "./files.js";
import { OPTIONAL_TEXT_FIELDS, stampRecord } from "./records.js";
import { GOAL_MAX, HISTORY_ACTORS, HISTORY_KINDS, QUEUES, QUEUE_LABEL, TODO_STATES, emptyState, isQueue, oneLine, } from "./topics.js";
import { emptyConfirmations } from "./confirmations.js";
import { carryMarks, emptyTodos, isValidItemId, withProjection } from "./todos.js";
import { emptyHashtags, parseHashtags, reconcile } from "./hashtags.js";
const FILE_MODE = 0o644;
function parseCloseProposal(raw) {
    if (!isRecord(raw) || typeof raw["at"] !== "string" || typeof raw["reason"] !== "string")
        return undefined;
    return { at: raw["at"], reason: raw["reason"] };
}
function parseTopic(id, raw) {
    if (!isRecord(raw))
        throw new Error(`topic ${id} is not an object`);
    const { name, goal, status } = raw;
    if (typeof name !== "string" || typeof goal !== "string")
        throw new Error(`topic ${id} lacks name or goal`);
    if (status !== "proposed" && status !== "confirmed")
        throw new Error(`topic ${id} has an unknown status`);
    const topic = {
        name,
        goal,
        status: "confirmed",
        created_at: textField(raw, "created_at"),
    };
    const close = parseCloseProposal(raw["close_proposal"]);
    if (close !== undefined)
        topic.close_proposal = close;
    const suggested = raw["suggested_queue"];
    const proposedFor = status === "confirmed" ? null : isQueue(suggested) ? suggested : "normal";
    return { topic, proposedFor };
}
/** A queue holds topics that were already confirmed on disk, each once. */
function parseQueue(raw, confirmed) {
    if (!Array.isArray(raw))
        return [];
    return [...new Set(raw)].filter((id) => typeof id === "string" && confirmed.has(id));
}
function parseNextSeq(raw) {
    return typeof raw === "number" && Number.isInteger(raw) ? Math.max(1, raw) : 1;
}
function parseHistoryEntry(raw) {
    if (!isRecord(raw))
        return null;
    const kind = HISTORY_KINDS.find((name) => name === raw["kind"]);
    const at = stringField(raw, "at");
    const topic = stringField(raw, "topic");
    const name = stringField(raw, "name");
    if (kind === undefined || at === null || topic === null || name === null)
        return null;
    const entry = { at, kind, topic, name };
    const from = stringField(raw, "from");
    const fromName = stringField(raw, "from_name");
    if (from !== null)
        entry.from = from;
    if (fromName !== null)
        entry.from_name = fromName;
    // A reason someone edited into something that is not one line is dropped, not printed.
    const reason = oneLine(stringField(raw, "reason") ?? "", GOAL_MAX);
    const by = HISTORY_ACTORS.find((actor) => actor === raw["by"]);
    if (reason !== null)
        entry.reason = reason;
    if (by !== undefined)
        entry.by = by;
    return withPlace(entry, raw);
}
/** A move's queue and 1-based place, and a goal change's new goal, when the entry has them. */
function withPlace(entry, raw) {
    const position = raw["position"];
    const goal = oneLine(stringField(raw, "goal") ?? "", GOAL_MAX);
    if (isQueue(raw["queue"]))
        entry.queue = raw["queue"];
    if (typeof position === "number" && Number.isInteger(position) && position > 0)
        entry.position = position;
    if (goal !== null)
        entry.goal = goal;
    return entry;
}
function parseHistory(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw.map(parseHistoryEntry).filter((entry) => entry !== null);
}
function parseTodos(raw) {
    const todos = {};
    if (!isRecord(raw))
        return todos;
    for (const [task, value] of Object.entries(raw)) {
        if (!isRecord(value) || task === "__proto__")
            continue;
        const state = TODO_STATES.find((name) => name === value["state"]);
        const at = stringField(value, "at");
        if (state === undefined || at === null)
            continue;
        const reason = stringField(value, "reason");
        todos[task] = reason === null ? { state, at } : { state, at, reason };
    }
    return todos;
}
/**
 * Reads the live topics. A leftover proposal is confirmed here, at the end of
 * the queue it was proposed for, so no topic is ever left waiting.
 */
function parseDoc(raw) {
    if (!isRecord(raw) || raw["v"] !== 1)
        throw new Error("expected an object with v: 1");
    const topics = raw["topics"];
    if (!isRecord(topics))
        throw new Error("topics is not an object");
    const doc = emptyState().doc;
    // Keyed by creation time, then id, so sorting the keys puts the oldest first.
    const waiting = new Map();
    const confirmed = new Set();
    for (const [id, value] of Object.entries(topics)) {
        const { topic, proposedFor } = parseTopic(id, value);
        doc.topics[id] = topic;
        if (proposedFor === null)
            confirmed.add(id);
        else
            waiting.set(`${topic.created_at}\u0000${id}`, { id, name: topic.name, queue: proposedFor });
    }
    const queues = isRecord(raw["queues"]) ? raw["queues"] : {};
    for (const queue of QUEUES)
        doc.queues[queue] = parseQueue(queues[queue], confirmed);
    const oldestFirst = [...waiting.keys()]
        .toSorted()
        .map((key) => waiting.get(key));
    for (const proposal of oldestFirst)
        doc.queues[proposal.queue].push(proposal.id);
    doc.merged = stringRecord(raw["merged"]);
    doc.history = parseHistory(raw["history"]);
    doc.todos = parseTodos(raw["todos"]);
    doc.next_seq = parseNextSeq(raw["next_seq"]);
    return { doc, confirmed: oldestFirst };
}
function parseArchive(raw) {
    if (!isRecord(raw) || raw["v"] !== 1 || !isRecord(raw["topics"])) {
        throw new Error("expected an object with v: 1 and topics");
    }
    const archive = { v: 1, topics: {} };
    const proposals = [];
    for (const [id, value] of Object.entries(raw["topics"])) {
        const { topic, proposedFor } = parseTopic(id, value);
        if (proposedFor !== null)
            proposals.push({ id, name: topic.name });
        const archived = {
            ...topic,
            archived_at: textField(value, "archived_at"),
        };
        archive.topics[id] = archived;
    }
    return { archive, proposals };
}
function readFile(file) {
    try {
        return readJsonFile(file);
    }
    catch (error) {
        throw new Error(`${file} 讀不懂：${error.message}`, { cause: error });
    }
}
function parseFile(file, raw, parse) {
    try {
        return parse(raw);
    }
    catch (error) {
        throw new Error(`${file} 讀不懂：${error.message}`, { cause: error });
    }
}
const OPTIONAL_RECORD_FIELDS = ["item", ...OPTIONAL_TEXT_FIELDS];
function parseRecord(raw) {
    if (!isRecord(raw) || raw["src"] !== "board")
        return null;
    const rid = stringField(raw, "rid");
    const kind = stringField(raw, "kind");
    const by = stringField(raw, "by");
    const ts = raw["ts"];
    if (rid === null || kind === null || by === null || typeof ts !== "number")
        return null;
    const record = {
        src: "board",
        rid,
        ts,
        kind,
        topic: stringField(raw, "topic"),
        home: stringField(raw, "home"),
        task: stringField(raw, "task"),
        by,
        label: textField(raw, "label"),
        text: textField(raw, "text"),
    };
    for (const name of OPTIONAL_RECORD_FIELDS) {
        const value = stringField(raw, name);
        if (value !== null)
            record[name] = value;
    }
    return record;
}
/** The records a commit file says it saved last; anything that is not a whole record is skipped. */
function parseOutbox(raw) {
    if (!isRecord(raw) || !Array.isArray(raw["outbox"]))
        return [];
    return raw["outbox"].flatMap((entry) => {
        const parsed = parseRecord(entry);
        return parsed === null ? [] : [parsed];
    });
}
function serialize(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}
/**
 * Writes `text` to `file` unless the file already holds exactly that; a
 * missing file counts as holding `absent`, the text of an empty one.
 */
function writeIfChanged(file, text, absent) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : absent;
    if (current !== text)
        writeFileAtomic(file, text, FILE_MODE);
}
const EMPTY_ARCHIVE = serialize(emptyState().archive);
const EMPTY_DOC = serialize({ ...emptyState().doc, outbox: [] });
/** Appends every outbox record the journal lacks; returns why it could not, or null. */
function flushOutbox(sink, outbox) {
    const waiting = [...outbox.topics, ...outbox.todos, ...outbox.confirmations, ...outbox.hashtags];
    for (const record of waiting) {
        if (sink.has(record.rid))
            continue;
        try {
            sink.append(record);
        }
        catch (error) {
            return error.message;
        }
    }
    return null;
}
/**
 * Writes the files of a topic change. topics.json is the commit point: the
 * archive is written before it unless the change takes a topic out of the
 * archive (a reopen), so a crash before the commit point leaves the topic
 * live and nothing recorded, and one after it leaves a copy the loader drops.
 */
function writeTopics(paths, previous, next, outbox) {
    const archiveText = serialize(next.archive);
    const losesTopic = Object.keys(previous.archive.topics).some((id) => next.archive.topics[id] === undefined);
    if (!losesTopic)
        writeIfChanged(paths.archive, archiveText, EMPTY_ARCHIVE);
    writeFileAtomic(paths.topics, serialize({ ...next.doc, outbox }), FILE_MODE);
    if (losesTopic)
        writeIfChanged(paths.archive, archiveText, EMPTY_ARCHIVE);
}
/**
 * Writes the files of a hands-on change. todos.json is the commit point;
 * topics.json's projection of it is written first and rebuilt from todos.json
 * at load, so a crash between the two leaves no change and nothing recorded.
 * topics.json keeps the outbox of the last topic change.
 */
function writeTodos(paths, board, next, outbox) {
    const topics = withProjection(board.topics, next);
    writeIfChanged(paths.topics, serialize({ ...topics.doc, outbox: board.outbox.topics }), EMPTY_DOC);
    fs.mkdirSync(paths.boardDataDir, { recursive: true });
    writeFileAtomic(paths.todos, serialize({ ...next, outbox }), FILE_MODE);
    return topics;
}
/**
 * Writes a file that is its own commit point: the captain's confirmations, or
 * the hashtags. A topic change with a follow-up in hashtags.json writes it
 * after topics.json, so a crash between the two leaves the topic change made
 * and recorded and the follow-up neither: a topic without its hashtags, never
 * a hashtag on a topic that is not there.
 */
function writeOwnFile(paths, file, next, outbox) {
    fs.mkdirSync(paths.boardDataDir, { recursive: true });
    writeFileAtomic(paths[file], serialize({ ...next, outbox }), FILE_MODE);
}
/** Saves a change's files and returns the board after it. */
function writeChange(paths, board, change, stamp) {
    const records = stamp(change.records);
    if (change.file === "todos") {
        const topics = writeTodos(paths, board, change.next, records);
        return {
            board: { ...board, topics, todos: change.next, outbox: { ...board.outbox, todos: records } },
            records,
        };
    }
    if (change.file === "confirmations") {
        writeOwnFile(paths, "confirmations", change.next, records);
        const outbox = { ...board.outbox, confirmations: records };
        return { board: { ...board, confirmations: change.next, outbox }, records };
    }
    if (change.file === "hashtags") {
        writeOwnFile(paths, "hashtags", change.next, records);
        return {
            board: { ...board, hashtags: change.next, outbox: { ...board.outbox, hashtags: records } },
            records,
        };
    }
    writeTopics(paths, board.topics, change.next, records);
    const next = { ...board, topics: change.next, outbox: { ...board.outbox, topics: records } };
    if (change.hashtags === undefined)
        return { board: next, records };
    const follow = stamp(change.hashtags.records);
    writeOwnFile(paths, "hashtags", change.hashtags.next, follow);
    return {
        board: {
            ...next,
            hashtags: change.hashtags.next,
            outbox: { ...next.outbox, hashtags: follow },
        },
        records: [...records, ...follow],
    };
}
/**
 * The only writer of the board's state files. First saves every earlier
 * record still waiting in an outbox, and refuses the change when it cannot.
 * Then saves the change with its records in the commit file's outbox, in the
 * same rename, and appends them to the journal. A failed append after the
 * rename does not undo the change: its records wait in the outbox for the
 * next commit or start.
 */
export function commitChange(target, board, change, actor) {
    const unsaved = flushOutbox(target.sink, board.outbox);
    if (unsaved !== null)
        return { ok: false, line: `看板寫不進紀錄（${unsaved}），這次的修改沒有做` };
    const ts = target.nowSeconds();
    const stamp = (drafts) => drafts.map((draft) => stampRecord(draft, actor, target.nextRid(), ts));
    fs.mkdirSync(target.paths.dataDir, { recursive: true });
    const saved = writeChange(target.paths, board, change, stamp);
    return {
        ok: true,
        board: saved.board,
        records: saved.records,
        appendError: flushOutbox(target.sink, saved.board.outbox),
    };
}
/** The hashtags as they apply to the topics read with them; none when the file is missing. */
function readHashtags(paths, raw, state) {
    if (raw === null)
        return emptyHashtags();
    return reconcile(parseFile(paths.hashtags, raw, parseHashtags), state);
}
/**
 * Reads the state files without writing anything. A crash between the two
 * writes of an archive or reopen can leave a topic in both topic files; the
 * live copy wins (an interrupted archive is simply redone, an interrupted
 * reopen is already complete). topics.json's marks are rebuilt from
 * todos.json when it exists. Hashtags follow merges and are dropped from
 * topics the board no longer has (hashtags.ts reconcile).
 */
export function readBoard(paths) {
    const empty = emptyState();
    const rawTopics = readFile(paths.topics);
    const rawArchive = readFile(paths.archive);
    const rawTodos = readFile(paths.todos);
    const rawConfirmations = readFile(paths.confirmations);
    const rawHashtags = readFile(paths.hashtags);
    const live = rawTopics === null
        ? { doc: empty.doc, confirmed: [] }
        : parseFile(paths.topics, rawTopics, parseDoc);
    const gone = rawArchive === null
        ? { archive: empty.archive, proposals: [] }
        : parseFile(paths.archive, rawArchive, parseArchive);
    for (const id of Object.keys(gone.archive.topics)) {
        if (live.doc.topics[id] !== undefined)
            delete gone.archive.topics[id];
    }
    const state = { doc: live.doc, archive: gone.archive };
    const store = rawTodos === null ? null : parseFile(paths.todos, rawTodos, parseTodoStore);
    const confirmations = rawConfirmations === null
        ? emptyConfirmations()
        : parseFile(paths.confirmations, rawConfirmations, parseConfirmations);
    return {
        board: {
            topics: store === null ? state : withProjection(state, store),
            todos: store ?? emptyTodos(),
            confirmations,
            hashtags: readHashtags(paths, rawHashtags, state),
            outbox: {
                topics: parseOutbox(rawTopics),
                todos: parseOutbox(rawTodos),
                confirmations: parseOutbox(rawConfirmations),
                hashtags: parseOutbox(rawHashtags),
            },
        },
        hasTodos: store !== null,
        confirmed: live.confirmed,
        archivedProposals: gone.proposals,
    };
}
/** The records of confirming leftover proposals, live and archived; null when there are none. */
function confirmRecords(read) {
    const drafts = [
        ...read.confirmed.map((proposal) => ({
            kind: "topic.confirmed",
            topic: proposal.id,
            text: `議題「${proposal.name}」已確認，排在「${QUEUE_LABEL[proposal.queue]}」最後`,
        })),
        ...read.archivedProposals.map((proposal) => ({
            kind: "topic.confirmed",
            topic: proposal.id,
            text: `議題「${proposal.name}」已確認，留在已封存`,
        })),
    ];
    const [first, ...rest] = drafts;
    return first === undefined ? null : [first, ...rest];
}
function afterCommit(result, errors) {
    if (!result.ok)
        throw new Error(result.line);
    if (result.appendError !== null)
        errors.push(result.appendError);
    return result.board;
}
/**
 * Loads the board at startup. Saves every outbox record the journal lacks
 * (throwing when it cannot, since no change could be made), then makes the
 * start's own changes through commitChange as the board itself: leftover
 * proposals are confirmed, and the first start of a board that keeps items
 * carries topics.json's marks into todos.json.
 */
export function loadBoard(target, label) {
    const read = readBoard(target.paths);
    const unsaved = flushOutbox(target.sink, read.board.outbox);
    if (unsaved !== null)
        throw new Error(`看板寫不進紀錄（${unsaved}）`);
    const actor = { by: "board", label };
    const errors = [];
    let board = read.board;
    const confirms = confirmRecords(read);
    if (confirms !== null) {
        const change = { file: "topics", next: board.topics, records: confirms };
        board = afterCommit(commitChange(target, board, change, actor), errors);
    }
    if (!read.hasTodos) {
        const carried = carryMarks(board.topics.doc.todos);
        if (carried.ok && carried.changed) {
            const change = { file: "todos", next: carried.store, records: carried.records };
            board = afterCommit(commitChange(target, board, change, actor), errors);
        }
    }
    return { board, confirmed: read.confirmed, appendErrors: errors };
}
const ITEM_STATES = ["open", ...TODO_STATES];
function stringList(raw) {
    return Array.isArray(raw) && raw.every((value) => typeof value === "string") ? raw : null;
}
/** One stored item, or null when it lacks what the page needs to show it. */
function parseItem(raw) {
    if (!isRecord(raw))
        return null;
    const title = stringField(raw, "title");
    const action = stringField(raw, "action");
    const state = ITEM_STATES.find((name) => name === raw["state"]);
    const commands = stringList(raw["commands"]);
    const topic = raw["topic"];
    if (title === null || action === null || state === undefined || commands === null)
        return null;
    if (topic !== null && typeof topic !== "string")
        return null;
    return {
        title,
        topic,
        action,
        guidance: textField(raw, "guidance"),
        commands,
        state,
        reason: stringField(raw, "reason"),
        at: textField(raw, "at"),
        by: textField(raw, "by"),
        ref: textField(raw, "ref"),
        captain_closes: raw["captain_closes"] === true,
        created_at: textField(raw, "created_at"),
    };
}
function parseTodoStore(raw) {
    if (!isRecord(raw) || raw["v"] !== 1)
        throw new Error("expected an object with v: 1");
    const store = emptyTodos();
    const items = isRecord(raw["items"]) ? raw["items"] : {};
    for (const [id, value] of Object.entries(items)) {
        const item = parseItem(value);
        if (item !== null && isValidItemId(id))
            store.items[id] = item;
    }
    store.marks = parseTodos(raw["marks"]);
    return store;
}
const SHA256 = /^[0-9a-f]{64}$/;
/** One stored confirmation, or null when it is not a whole one: then it confirms nothing. */
function parseConfirmation(raw) {
    if (!isRecord(raw))
        return null;
    const program = stringField(raw, "path");
    const sha256 = stringField(raw, "sha256");
    const bindingSha256 = stringField(raw, "binding_sha256");
    if (program === null || !program.startsWith("/"))
        return null;
    if (sha256 === null || !SHA256.test(sha256))
        return null;
    if (bindingSha256 === null || !SHA256.test(bindingSha256))
        return null;
    return { path: program, sha256, binding_sha256: bindingSha256, at: textField(raw, "at") };
}
function parseConfirmations(raw) {
    if (!isRecord(raw) || raw["v"] !== 1)
        throw new Error("expected an object with v: 1");
    const entries = Array.isArray(raw["entries"]) ? raw["entries"] : [];
    return {
        v: 1,
        entries: entries.flatMap((entry) => {
            const parsed = parseConfirmation(entry);
            return parsed === null ? [] : [parsed];
        }),
    };
}
