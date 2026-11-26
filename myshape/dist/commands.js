// The only external programs the board service may run: the aggregator's feed
// and its deliverer, as the binding names them and binding.ts allows them
// right before each run (contracts section 7). The argument shapes are fixed
// here: the board adds "feed", "topics" or "deliver" and its own validated
// arguments; "topics" runs the feed's program.
// Every run is an argument array for execFile (no shell), with captain text
// only on stdin, and gets a short fixed environment, never the starter's.
import { execFile } from "node:child_process";
/**
 * The only names the board copies from its own environment into each
 * program's, when set; MYSHAPE_HOME is the board's own (contracts section 7).
 * A name a program turns out to need is added here, never by passing the
 * starter's whole environment.
 */
export const PROGRAM_ENV_NAMES = ["PATH", "HOME", "LANG", "TMPDIR"];
const HOME_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
/** A task id as every lookup checks it. */
export const TASK_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const SHA = /^(-|[0-9a-f]{64})$/;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export class CommandRefused extends Error {
}
function refuse(reason) {
    throw new CommandRefused(reason);
}
/**
 * Text handed to an agent. A receiver that types it into a terminal would run
 * one starting with '/' or '$' as a command, '!' is a harness composer's shell
 * escape, and a leading '-' reads as an option. None of the four may lead,
 * with or without whitespace in front.
 */
export function directTextProblem(text) {
    if (text.trim() === "")
        return "訊息不能是空的。";
    if (/^\s*[/$!-]/.test(text)) {
        return "以 /、$、! 或 - 開頭會被當成指令。要跑指令請到終端機，要傳文字請在開頭加字。";
    }
    return null;
}
function feedArgs(command) {
    if (!HOME_ID.test(command.home))
        refuse(`malformed home id: ${command.home}`);
    if (!Number.isInteger(command.offset) || command.offset < 0)
        refuse("offset must be a non-negative integer");
    if (!SHA.test(command.sha))
        refuse("prefix hash must be 64 hex characters or '-'");
    const args = ["feed", command.home, String(command.offset), command.sha];
    const { closed } = command;
    if (closed === undefined)
        return args;
    if (!Number.isInteger(closed.offset) || closed.offset < 0)
        refuse("closed offset must be a non-negative integer");
    if (!SHA.test(closed.sha))
        refuse("closed prefix hash must be 64 hex characters or '-'");
    return [...args, String(closed.offset), closed.sha];
}
function topicsArgs(command) {
    if (!HOME_ID.test(command.home))
        refuse(`malformed home id: ${command.home}`);
    if (command.tasks.length === 0)
        refuse("topics needs at least one task id");
    const bad = command.tasks.find((task) => !TASK_ID.test(task));
    if (bad !== undefined)
        refuse(`malformed task id: ${bad}`);
    return ["topics", command.home, ...command.tasks];
}
/** Turns an allowed command into the arguments to run; throws CommandRefused otherwise. */
export function invocationFor(command) {
    if (command.kind === "feed")
        return { args: feedArgs(command) };
    if (command.kind === "topics")
        return { args: topicsArgs(command) };
    if (/[\r\n]/.test(command.record))
        refuse("an action record must be one line");
    return { args: ["deliver"], stdin: `${command.record}\n` };
}
/** PATH without its empty and relative entries, which would search the working directory. */
export function absolutePath(value) {
    return value
        .split(":")
        .filter((entry) => entry.startsWith("/"))
        .join(":");
}
/**
 * The environment every program gets: the listed names the board has, with
 * the values whoever started the board gave them (PATH without empty or
 * relative entries), and MYSHAPE_HOME. Nothing else of the starter's passes.
 */
export function programEnv(own, home) {
    const env = {};
    for (const name of PROGRAM_ENV_NAMES) {
        const value = own[name];
        if (value !== undefined)
            env[name] = name === "PATH" ? absolutePath(value) : value;
    }
    env["MYSHAPE_HOME"] = home;
    return env;
}
/** Builds the runner bound to one home, whose programs `gate` allows. */
export function commandRunner(config, gate) {
    return (command, timeoutMs) => new Promise((resolve) => {
        let invocation;
        try {
            invocation = invocationFor(command);
        }
        catch (error) {
            resolve({ code: null, stdout: "", stderr: error.message });
            return;
        }
        const allowed = gate(command.kind === "deliver" ? "deliver" : "feed");
        if ("blocked" in allowed) {
            resolve({ code: null, stdout: "", stderr: "", blocked: allowed.blocked });
            return;
        }
        const child = execFile(allowed.program, invocation.args, {
            env: programEnv(process.env, config.home),
            timeout: timeoutMs,
            maxBuffer: MAX_OUTPUT_BYTES,
            encoding: "utf8",
        }, (error, stdout, stderr) => {
            const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
            resolve({
                code,
                stdout,
                stderr: error !== null && code === null ? `${stderr}${error.message}` : stderr,
            });
        });
        if (child.stdin !== null) {
            // A program that exits without reading its stdin closes the pipe
            // (EPIPE); its exit code and output already say how the run went.
            child.stdin.on("error", () => undefined);
            child.stdin.end(invocation.stdin);
        }
    });
}
