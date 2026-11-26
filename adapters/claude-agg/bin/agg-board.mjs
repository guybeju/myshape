#!/usr/bin/env node
// agg-board.mjs: the one program a board runs for claude-agg, as its feed
// (and topics) and its deliver, once the captain has confirmed it on the page
// (the board's contract, myshape/spec/contracts.markdown sections 4 and 7).
//
//   agg-board.mjs feed <home> <offset> <sha> [<closed-offset> <closed-sha>]
//   agg-board.mjs topics <home> <task>...
//   agg-board.mjs deliver            (one action record on stdin)
//
// It reads claude-agg's state under $MYSHAPE_HOME/agg/ (spec/state-files.markdown)
// and its own file, to name its version. feed and topics write nothing. deliver
// writes only a new file in agg/inbox/ or agg/answers/ (a temporary file linked
// to its final name, so nothing is overwritten) and appends one line to
// agg/tags/<task-id>. It reads one environment name, MYSHAPE_HOME, starts no
// process, opens no network connection, calls no model, and loads no file but
// Node's built-in fs, path and crypto modules: the confirmation on the page
// binds this file's SHA-256, so everything the board runs is in it.
//
// Exit codes: 0 done; 1 a state file could not be read (stderr says which);
// 2 bad arguments or a bad action record, and nothing was written; 4 (feed and
// topics) this home has no agg/ directory yet, with a one-line banner on stderr.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

const AGENT_NAME = "claude-agg";
const AGENT_LABEL = "Claude 派工員";
const HOME_ID = "main";
const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const OFFSET = /^(0|[1-9][0-9]{0,15})$/;
const SHA = /^([0-9a-fA-F]{64}|-)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const LEDGER_CHUNK = 256 * 1024;
const LEDGER_LINE_MAX = 3 * 1024 * 1024;
const RECORD_MAX = 1024 * 1024;
const FINISHED = new Set(["done", "failed"]);
const RESERVED_KIND = "secondmate";
const COMMAND_START = /^\s*[/$!-]/;
const COMMAND_TEXT = "以 /、$、! 或 - 開頭會被當成指令。要跑指令請到終端機，要傳文字請在開頭加字。";
const ENDED_TEXT = "這個 worker 已經結束，訊息沒有送出。";

/** An error that ends the run with its exit code and a one-line message on stderr. */
class Exit extends Error {
  /**
   * @param {number} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** @param {string} message */
const usage = (message) => new Exit(2, `agg-board: ${message}`);
/** @param {string} message */
const broken = (message) => new Exit(1, `agg-board: ${message}`);

/**
 * @typedef {{ [field: string]: unknown }} Fields
 * @typedef {{ outcome: "delivered" | "handled_elsewhere" | "retry" | "failed", error?: string }} Outcome
 */

/**
 * @param {string} value
 * @param {number} max
 */
function isName(value, max) {
  return value.length <= max && NAME.test(value);
}

/**
 * @param {string} what
 * @param {string | undefined} value
 * @param {number} max
 * @returns {string}
 */
function nameArg(what, value, max) {
  if (value === undefined || !isName(value, max))
    throw usage(`${what} 的格式不對：${String(value)}`);
  return value;
}

/** @param {string | undefined} home */
function homeArg(home) {
  const name = nameArg("home", home, 64);
  if (name !== HOME_ID) throw usage(`${AGENT_NAME} 沒有 home ${name}，只有 ${HOME_ID}`);
  return name;
}

/**
 * @param {string | undefined} offset
 * @param {string | undefined} sha
 * @returns {{ offset: number, sha: string }}
 */
function cursorArgs(offset, sha) {
  if (offset === undefined || !OFFSET.test(offset) || !Number.isSafeInteger(Number(offset)))
    throw usage(`offset 要是非負整數：${String(offset)}`);
  if (sha === undefined || !SHA.test(sha))
    throw usage(`sha 要是 64 位十六進位或 -：${String(sha)}`);
  return { offset: Number(offset), sha: sha.toLowerCase() };
}

/** The agent's state directory, from the one environment name it reads. */
function aggDir() {
  const home = process.env["MYSHAPE_HOME"];
  if (home === undefined || !isAbsolute(home))
    throw broken("MYSHAPE_HOME 要是 board home 的絕對路徑");
  return join(home, "agg");
}

/**
 * What is at `path`: "dir", "file", or null when nothing is.
 * @param {string} path
 * @returns {"dir" | "file" | null}
 */
function kindAt(path) {
  try {
    return statSync(path).isDirectory() ? "dir" : "file";
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return null;
    throw broken(`讀不了 ${path}：${String(error)}`);
  }
}

/** @param {string} path */
function isDir(path) {
  return kindAt(path) === "dir";
}

/** @param {string} agg */
function requireAgg(agg) {
  if (!isDir(agg)) throw new Exit(4, `${AGENT_NAME} 還沒在這個 home 設定好：找不到 ${agg}`);
}

/**
 * The text of a file, or null when there is none.
 * @param {string} path
 * @returns {string | null}
 */
function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return null;
    throw broken(`讀不了 ${path}：${String(error)}`);
  }
}

/**
 * @param {unknown} value
 * @returns {value is Fields}
 */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A JSON state file's object under `key`, checked for `v` 1, or the empty value when there is no file.
 * @param {string} agg
 * @param {string} file
 * @param {string} key
 * @param {unknown} empty
 * @returns {unknown}
 */
function readStateFile(agg, file, key, empty) {
  const path = join(agg, file);
  const text = readText(path);
  if (text === null) return empty;
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw broken(`${path} 不是合法的 JSON：${String(error)}`);
  }
  if (!isObject(parsed) || parsed["v"] !== 1) throw broken(`${path} 要是 v 為 1 的物件`);
  const value = parsed[key];
  const shapeOk = Array.isArray(empty) ? Array.isArray(value) : isObject(value);
  if (!shapeOk) throw broken(`${path} 的 ${key} 格式不對`);
  return value;
}

/**
 * @param {string} path
 * @param {string} where
 * @param {Fields} entry
 * @param {string} field
 * @param {"string" | "boolean"} type
 * @param {boolean} required
 */
function checkField(path, where, entry, field, type, required) {
  const value = entry[field];
  if (value === undefined && !required) return;
  if (typeof value !== type) throw broken(`${path} 的 ${where} 的 ${field} 要是 ${type}`);
}

/**
 * @typedef {{ kind: string, state: string, detail?: string, unstarted?: boolean }} Task
 * @param {string} agg
 * @returns {Map<string, Task>}
 */
function readTasks(agg) {
  const path = join(agg, "tasks.json");
  const tasks = /** @type {Fields} */ (readStateFile(agg, "tasks.json", "tasks", {}));
  /** @type {Map<string, Task>} */
  const result = new Map();
  for (const [id, entry] of Object.entries(tasks)) {
    if (!isName(id, 128) || !isObject(entry)) throw broken(`${path} 的 task ${id} 格式不對`);
    checkField(path, id, entry, "kind", "string", true);
    checkField(path, id, entry, "state", "string", true);
    checkField(path, id, entry, "detail", "string", false);
    checkField(path, id, entry, "unstarted", "boolean", false);
    if (entry["kind"] === "" || entry["kind"] === RESERVED_KIND || entry["state"] === "")
      throw broken(`${path} 的 task ${id}：kind 不能是空的或 ${RESERVED_KIND}，state 不能是空的`);
    result.set(id, /** @type {Task} */ (entry));
  }
  return result;
}

/**
 * @typedef {{ state: string, title: string, question: string, on_answer: string, hold_set: string,
 *   origin?: string, hold_bucket?: string, hold_until?: string | null, unresolved_blocker_ids?: string[] }} Hold
 * @param {string} agg
 * @returns {Map<string, Hold>}
 */
function readHolds(agg) {
  const path = join(agg, "holds.json");
  const holds = /** @type {Fields} */ (readStateFile(agg, "holds.json", "holds", {}));
  /** @type {Map<string, Hold>} */
  const result = new Map();
  for (const [id, entry] of Object.entries(holds)) {
    if (!isName(id, 128) || !isObject(entry)) throw broken(`${path} 的 hold ${id} 格式不對`);
    for (const field of ["state", "title", "question", "on_answer", "hold_set"])
      checkField(path, id, entry, field, "string", true);
    checkField(path, id, entry, "origin", "string", false);
    checkField(path, id, entry, "hold_bucket", "string", false);
    result.set(id, /** @type {Hold} */ (entry));
  }
  return result;
}

/**
 * @param {string} agg
 * @returns {Fields[]}
 */
function readQueued(agg) {
  const path = join(agg, "queued.json");
  const queued = /** @type {unknown[]} */ (readStateFile(agg, "queued.json", "queued", []));
  return queued.map((entry, index) => {
    if (!isObject(entry) || typeof entry["id"] !== "string" || !isName(entry["id"], 128))
      throw broken(`${path} 的第 ${index + 1} 項格式不對`);
    checkField(path, entry["id"], entry, "kind", "string", true);
    checkField(path, entry["id"], entry, "title", "string", true);
    return {
      id: entry["id"],
      kind: entry["kind"],
      title: entry["title"],
      hold: entry["hold"] ?? null,
      captain: entry["captain"] ?? false,
      blockers: entry["blockers"] ?? [],
      topic_hint: entry["topic_hint"] ?? null,
    };
  });
}

/**
 * The answer landed for a task's hold, or null.
 * @param {string} agg
 * @param {string} task
 * @returns {Fields | null}
 */
function readAnswer(agg, task) {
  const path = join(agg, "answers", `${task}.json`);
  const text = readText(path);
  if (text === null) return null;
  try {
    const file = JSON.parse(text);
    if (isObject(file) && isObject(file["record"])) return file["record"];
  } catch {
    // Reported below with the file's name.
  }
  throw broken(`${path} 不是 deliver 寫的答案檔`);
}

/** @param {string} text */
function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * True when the answer in answers/ is for the hold's current question.
 * @param {string} agg
 * @param {string} task
 * @param {Hold} hold
 */
function isAnswered(agg, task, hold) {
  const answer = readAnswer(agg, task);
  return answer !== null && answer["question_sha256"] === sha256(hold.question);
}

/**
 * @param {string} agg
 * @param {Map<string, Hold>} holds
 * @param {number} now
 */
function reportHolds(agg, holds, now) {
  const open = [...holds].filter(
    ([task, hold]) => hold.state === "open" && !isAnswered(agg, task, hold),
  );
  return open.map(([task, hold]) => {
    const set = Date.parse(hold.hold_set);
    return {
      id: task,
      title: hold.title,
      question: hold.question,
      hold_bucket: hold.hold_bucket ?? "live",
      hold_until: hold.hold_until ?? null,
      unresolved_blocker_ids: hold.unresolved_blocker_ids ?? [],
      hold_age_days: Number.isNaN(set) ? 0 : Math.max(0, Math.floor((now - set) / 86_400_000)),
      origin: hold.origin ?? "",
      on_answer: hold.on_answer,
      hold_set: hold.hold_set,
    };
  });
}

/**
 * @param {string} agg
 * @param {string} task
 * @returns {string | null}
 */
function readTag(agg, task) {
  const text = readText(join(agg, "tags", task));
  if (text === null) return null;
  const trimmed = text.replace(/\n+$/, "");
  return trimmed === "" ? null : trimmed;
}

/**
 * Every tag file's text, by task id.
 * @param {string} agg
 * @param {string[] | null} only
 * @returns {Record<string, string>}
 */
function readTags(agg, only) {
  const dir = join(agg, "tags");
  const names = only ?? (isDir(dir) ? readdirSync(dir).filter((name) => isName(name, 128)) : []);
  /** @type {Record<string, string>} */
  const tags = {};
  for (const task of names.toSorted()) {
    const tag = readTag(agg, task);
    if (tag !== null) tags[task] = tag;
  }
  return tags;
}

const ABSENT = { status: "absent", to_offset: 0, to_prefix_sha256: "-", more: false, lines: [] };
const BROKEN = {
  status: "continuity-broken",
  to_offset: 0,
  to_prefix_sha256: "-",
  more: false,
  lines: [],
};

/**
 * @param {number} fd
 * @param {number} start
 * @param {number} length
 */
function readAt(fd, start, length) {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const read = readSync(fd, buffer, done, length - done, start + done);
    if (read === 0) break;
    done += read;
  }
  return buffer.subarray(0, done);
}

/**
 * Feeds bytes [0, end) of the file to the hash, a megabyte at a time.
 * @param {number} fd
 * @param {ReturnType<typeof createHash>} hash
 * @param {number} end
 */
function hashPrefix(fd, hash, end) {
  for (let at = 0; at < end; at += 1024 * 1024)
    hash.update(readAt(fd, at, Math.min(1024 * 1024, end - at)));
}

/**
 * The whole lines from `offset`: up to LEDGER_CHUNK bytes, or one longer line.
 * @param {number} fd
 * @param {number} offset
 * @param {number} size
 */
function wholeLines(fd, offset, size) {
  const window = readAt(fd, offset, Math.min(size - offset, LEDGER_CHUNK));
  const end = window.lastIndexOf(0x0a) + 1;
  if (end > 0 || window.length < LEDGER_CHUNK) return window.subarray(0, end);
  const long = readAt(fd, offset, Math.min(size - offset, LEDGER_LINE_MAX));
  const lineEnd = long.indexOf(0x0a) + 1;
  if (lineEnd === 0 && long.length === LEDGER_LINE_MAX)
    throw broken(`ledger.jsonl 在位元組 ${offset} 的那一行超過 ${LEDGER_LINE_MAX} 位元組`);
  return long.subarray(0, lineEnd);
}

/**
 * The ledger from the board's cursor: a byte offset and the SHA-256 of every byte before it.
 * @param {string} agg
 * @param {{ offset: number, sha: string }} cursor
 */
function readLedger(agg, { offset, sha }) {
  const path = join(agg, "ledger.jsonl");
  /** @type {number} */
  let fd;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return ABSENT;
    throw broken(`讀不了 ${path}：${String(error)}`);
  }
  try {
    const size = fstatSync(fd).size;
    if (offset > size) return BROKEN;
    const hash = createHash("sha256");
    hashPrefix(fd, hash, offset);
    if (offset > 0 && hash.copy().digest("hex") !== sha) return BROKEN;
    const chunk = wholeLines(fd, offset, size);
    hash.update(chunk);
    const to = offset + chunk.length;
    const lines = chunk
      .toString("utf8")
      .split("\n")
      .filter((line) => line !== "");
    const more = size - offset > LEDGER_CHUNK && to < size;
    return { status: "delta", to_offset: to, to_prefix_sha256: hash.digest("hex"), more, lines };
  } finally {
    closeSync(fd);
  }
}

/** This program's version: the start of the SHA-256 of its own bytes. */
function codeCommit() {
  return `agg-board-${createHash("sha256")
    .update(readFileSync(import.meta.filename))
    .digest("hex")
    .slice(0, 16)}`;
}

/** @param {string[]} args */
function feed(args) {
  if (args.length !== 3 && args.length !== 5)
    throw usage("feed <home> <offset> <sha> [<closed-offset> <closed-sha>]");
  homeArg(args[0]);
  const cursor = cursorArgs(args[1], args[2]);
  if (args.length === 5) cursorArgs(args[3], args[4]);
  const agg = aggDir();
  requireAgg(agg);
  const tasks = [...readTasks(agg)].map(([id, task]) => ({
    id,
    kind: task.kind,
    state: task.state,
    source: "tasks.json",
    detail: task.detail ?? "",
    unstarted: task.unstarted ?? false,
  }));
  const report = {
    schema: 1,
    code_commit: codeCommit(),
    ledger_enabled: true,
    tasks,
    queued: readQueued(agg),
    holds: reportHolds(agg, readHolds(agg), Date.now()),
    status_decisions: [],
    topics: readTags(agg, null),
    ledger: readLedger(agg, cursor),
    aggregator: { name: AGENT_NAME, label: AGENT_LABEL },
    secondmates: [],
  };
  return `${JSON.stringify(report)}\n`;
}

/** @param {string[]} args */
function topics(args) {
  if (args.length < 2) throw usage("topics <home> <task>...");
  homeArg(args[0]);
  const tasks = args.slice(1).map((task) => nameArg("task", task, 128));
  const agg = aggDir();
  requireAgg(agg);
  return `${JSON.stringify({ topics: readTags(agg, tasks) })}\n`;
}

/** The one line on stdin. */
function readRecordLine() {
  const input = readFileSync(0);
  if (input.length > RECORD_MAX) throw usage(`動作紀錄超過 ${RECORD_MAX} 位元組`);
  const text = input.toString("utf8").replace(/\r?\n$/, "");
  if (text === "" || text.includes("\n")) throw usage("stdin 要是一行動作紀錄");
  return text;
}

/**
 * @param {Fields} record
 * @param {string} field
 */
function textField(record, field) {
  const value = record[field];
  if (typeof value !== "string") throw usage(`動作紀錄的 ${field} 要是字串`);
  return value;
}

/**
 * @param {Fields} record
 * @param {string} field
 * @param {number} max
 */
function nameField(record, field, max) {
  const value = textField(record, field);
  if (!isName(value, max)) throw usage(`動作紀錄的 ${field} 格式不對：${value}`);
  return value;
}

/** @param {unknown} topic */
function checkTopicRef(topic) {
  if (!isObject(topic)) throw usage("動作紀錄的 topic 要是 {id, name}");
  nameField(topic, "id", 64);
  textField(topic, "name");
}

/** @type {Record<string, (record: Fields) => void>} */
const RECORD_SHAPES = {
  message(record) {
    checkTopicRef(record["topic"]);
    textField(record, "text");
  },
  notice(record) {
    if (textField(record, "event") === "") throw usage("notice 的 event 不能是空的");
    textField(record, "text");
  },
  direct(record) {
    nameField(record, "home", 64);
    nameField(record, "task", 128);
    textField(record, "text");
  },
  answer(record) {
    nameField(record, "home", 64);
    nameField(record, "task", 128);
    textField(record, "answer");
    textField(record, "label");
    if (record["mode"] !== "done" && record["mode"] !== "release")
      throw usage("answer 的 mode 要是 done 或 release");
    if (!HEX64.test(textField(record, "question_sha256")))
      throw usage("answer 的 question_sha256 要是 64 位十六進位");
    if (record["topic"] !== null) checkTopicRef(record["topic"]);
  },
  tag(record) {
    nameField(record, "home", 64);
    nameField(record, "task", 128);
    nameField(record, "topic", 64);
    textField(record, "last_tag_line");
  },
};

/**
 * Parses and checks one action record (contract section 7.1).
 * @param {string} line
 * @returns {Fields}
 */
function parseRecord(line) {
  /** @type {unknown} */
  let record;
  try {
    record = JSON.parse(line);
  } catch (error) {
    throw usage(`動作紀錄不是合法的 JSON：${String(error)}`);
  }
  if (!isObject(record) || record["v"] !== 1) throw usage("動作紀錄要是 v 為 1 的物件");
  nameField(record, "id", 200);
  if (!Number.isSafeInteger(record["attempt"]) || /** @type {number} */ (record["attempt"]) < 0)
    throw usage("動作紀錄的 attempt 要是非負整數");
  const kind = textField(record, "kind");
  const check = Object.hasOwn(RECORD_SHAPES, kind) ? RECORD_SHAPES[kind] : undefined;
  if (check === undefined) throw usage(`不認得的動作 kind：${kind}`);
  check(record);
  return record;
}

/**
 * Writes `content` as dir/name unless that name exists: a temporary file, synced, linked to the
 * name (which fails when the name exists), then removed. Returns false when the name existed.
 * @param {string} dir
 * @param {string} name
 * @param {string} content
 */
function writeOnce(dir, name, content) {
  const temporary = join(dir, `.tmp-${name}-${process.pid}`);
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, join(dir, name));
    return true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "EEXIST") return false;
    throw error;
  } finally {
    unlinkSync(temporary);
  }
}

/**
 * @param {Fields} record
 * @param {number} now
 */
function landed(record, now) {
  return `${JSON.stringify({ v: 1, received_ms: now, record })}\n`;
}

/**
 * @param {string} agg
 * @param {string} id
 */
function hasLanded(agg, id) {
  const name = `${id}.json`;
  return (
    kindAt(join(agg, "inbox", name)) !== null ||
    kindAt(join(agg, "inbox", "handled", name)) !== null
  );
}

/** @type {Outcome} */
const DELIVERED = { outcome: "delivered" };
/** @type {Outcome} */
const ELSEWHERE = { outcome: "handled_elsewhere" };

/**
 * @param {string} agg
 * @param {Fields} record
 * @param {number} now
 * @returns {Outcome}
 */
function landInInbox(agg, record, now) {
  writeOnce(join(agg, "inbox"), `${String(record["id"])}.json`, landed(record, now));
  return DELIVERED;
}

/** @param {Fields} record */
function otherHome(record) {
  return record["home"] !== HOME_ID;
}

/** @param {string} home */
function noHome(home) {
  return /** @type {Outcome} */ ({
    outcome: "failed",
    error: `${AGENT_NAME} 沒有 home ${home}，沒有送出。`,
  });
}

/**
 * @param {string} agg
 * @param {Fields} record
 * @param {number} now
 * @returns {Outcome}
 */
function deliverDirect(agg, record, now) {
  if (otherHome(record)) return noHome(String(record["home"]));
  if (COMMAND_START.test(String(record["text"]))) return { outcome: "failed", error: COMMAND_TEXT };
  const task = readTasks(agg).get(String(record["task"]));
  if (task === undefined)
    return {
      outcome: "failed",
      error: `沒有這個 worker（${String(record["task"])}），訊息沒有送出。`,
    };
  if (FINISHED.has(task.state)) return { outcome: "failed", error: ENDED_TEXT };
  return landInInbox(agg, record, now);
}

/**
 * @param {Fields} answer
 * @param {Fields} record
 */
function sameAnswer(answer, record) {
  return ["answer", "label", "mode"].every((field) => answer[field] === record[field]);
}

/**
 * @param {string} agg
 * @param {Fields} record
 * @param {number} now
 * @returns {Outcome}
 */
function deliverAnswer(agg, record, now) {
  if (otherHome(record)) return noHome(String(record["home"]));
  const task = String(record["task"]);
  const hold = readHolds(agg).get(task);
  if (
    hold === undefined ||
    hold.state !== "open" ||
    sha256(hold.question) !== record["question_sha256"]
  )
    return ELSEWHERE;
  const existing = readAnswer(agg, task);
  if (existing === null) {
    if (!writeOnce(join(agg, "answers"), `${task}.json`, landed(record, now)))
      return { outcome: "retry", error: `${task} 的答案剛好同時寫進來，再送一次。` };
    return landInInbox(agg, record, now);
  }
  if (existing["question_sha256"] !== record["question_sha256"])
    return {
      outcome: "retry",
      error: `${task} 上一個待決事項的答案還在 answers/，等 supervisor 收走。`,
    };
  return sameAnswer(existing, record) ? landInInbox(agg, record, now) : ELSEWHERE;
}

/**
 * @param {string} agg
 * @param {Fields} record
 * @param {number} now
 * @returns {Outcome}
 */
function deliverTag(agg, record, now) {
  if (otherHome(record)) return noHome(String(record["home"]));
  const task = String(record["task"]);
  const topic = String(record["topic"]);
  const path = join(agg, "tags", task);
  const text = readText(path) ?? "";
  const last = text.trimEnd().split("\n").at(-1) ?? "";
  if (last !== "" && last.split(" ")[0] === topic) return landInInbox(agg, record, now);
  if (last !== String(record["last_tag_line"]).trim()) return ELSEWHERE;
  const at = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
  const lead = text === "" || text.endsWith("\n") ? "" : "\n";
  appendFileSync(path, `${lead}${topic} ${at}\n`, { mode: 0o600 });
  return landInInbox(agg, record, now);
}

/** @type {Record<string, (agg: string, record: Fields, now: number) => Outcome>} */
const DELIVER = {
  message: landInInbox,
  notice: landInInbox,
  direct: deliverDirect,
  answer: deliverAnswer,
  tag: deliverTag,
};

/** @param {string[]} args */
function deliver(args) {
  if (args.length !== 0) throw usage("deliver 不收參數，動作紀錄從 stdin 來");
  const record = parseRecord(readRecordLine());
  const agg = aggDir();
  const missing = ["", "inbox", "answers", "tags"]
    .map((dir) => join(agg, dir))
    .find((dir) => !isDir(dir));
  /** @type {Outcome} */
  let outcome;
  if (missing !== undefined) {
    outcome = {
      outcome: "retry",
      error: `${missing} 不存在：${AGENT_NAME} 還沒在這個 home 設定好。`,
    };
  } else if (hasLanded(agg, String(record["id"]))) {
    outcome = DELIVERED;
  } else {
    outcome = /** @type {(agg: string, record: Fields, now: number) => Outcome} */ (
      DELIVER[String(record["kind"])]
    )(agg, record, Date.now());
  }
  return `${JSON.stringify(outcome)}\n`;
}

/** @type {Record<string, (args: string[]) => string>} */
const COMMANDS = { feed, topics, deliver };

/** @param {string[]} argv */
function main(argv) {
  const [command, ...args] = argv;
  const run =
    command !== undefined && Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (run === undefined) throw usage("用法：agg-board.mjs feed|topics|deliver …");
  return run(args);
}

try {
  process.stdout.write(main(process.argv.slice(2)));
} catch (error) {
  const exit =
    error instanceof Exit ? error : broken(error instanceof Error ? error.message : String(error));
  process.stderr.write(`${exit.message}\n`);
  process.exitCode = exit.code;
}
