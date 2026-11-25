// Small file helpers shared by the service and the client. Everything is
// synchronous: the service handles one request at a time, so a write is
// finished before the next request is read.
import fs from "node:fs";
import path from "node:path";
const TEMP_SUFFIX = /\.tmp-\d+$/;
/** Replaces `file` with `data` through a temp file and rename, so readers never see a partial file. */
export function writeFileAtomic(file, data, mode) {
    const temp = `${file}.tmp-${process.pid}`;
    const fd = fs.openSync(temp, "w", mode);
    try {
        fs.writeSync(fd, data);
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
}
/** Deletes leftover atomic-write temp files in `dir` and returns their names. */
export function removeStaleTemps(dir) {
    if (!fs.existsSync(dir))
        return [];
    const stale = fs.readdirSync(dir).filter((name) => TEMP_SUFFIX.test(name));
    for (const name of stale)
        fs.unlinkSync(path.join(dir, name));
    return stale;
}
export function readJsonFile(file) {
    if (!fs.existsSync(file))
        return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
}
/**
 * Returns the complete lines of an append-only file. A final line with no
 * newline was cut off mid-write by a crash, so it is truncated away first.
 */
export function readCompleteLines(file) {
    if (!fs.existsSync(file))
        return [];
    const content = fs.readFileSync(file);
    const end = content.lastIndexOf(0x0a) + 1;
    if (end !== content.length)
        fs.truncateSync(file, end);
    if (end === 0)
        return [];
    return content
        .subarray(0, end - 1)
        .toString("utf8")
        .split("\n");
}
export function appendLine(file, line, mode) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${line}\n`, { mode });
}
/** Appends one line and waits until it is on disk, so a record saved is a record kept. */
export function appendLineDurable(file, line, mode) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, "a", mode);
    try {
        fs.writeSync(fd, `${line}\n`);
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
}
export function fileSize(file) {
    return fs.existsSync(file) ? fs.statSync(file).size : 0;
}
/**
 * The pid stored in `file`, or null when the file is missing or malformed. A
 * file deleted between the existence check and the read counts as missing.
 */
export function readPidFile(file) {
    if (!fs.existsSync(file))
        return null;
    let content;
    try {
        content = fs.readFileSync(file, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
    const pid = Number(content.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}
export function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/** True for a plain JSON object: not null, not an array. */
export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** The string stored under `name`, or null when it is absent or not a string. */
export function stringField(record, name) {
    const value = record[name];
    return typeof value === "string" ? value : null;
}
/** The string-valued members of a JSON object; anything else yields an empty record. */
export function stringRecord(raw) {
    const result = {};
    if (!isRecord(raw))
        return result;
    for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "string")
            result[key] = value;
    }
    return result;
}
/** An error that carries the exit code or HTTP status to finish with. */
export class CodedError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/** The string stored under `name`, or "" when it is absent or not a string. */
export function textField(record, name) {
    const value = stringField(record, name);
    return value === null ? "" : value;
}
/** Turns "absent" into null, for values that are shown as JSON. */
export function orNull(value) {
    return value === undefined ? null : value;
}
