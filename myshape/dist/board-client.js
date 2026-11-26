// The node half of myshape.sh: makes sure the board service is running, sends
// it one request over the Unix socket, prints the answer, and exits with the
// code myshape.sh documents (0, 1, 2, 3, or 69).
//
// Usage (called only by myshape.sh):
//   board-client.js --home <dir> --root <dir> --commit <sha> --port <n>
//                   --state <dir> --data <dir> -- <subcommand> [args...]
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodedError, fileSize, isAlive, isRecord, readPidFile } from "./files.js";
import { boardPaths, parseConfigArgs } from "./layout.js";
import { REQUEST_TIMEOUT_MS } from "./protocol.js";
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;
const EXIT_UNKNOWN_OUTCOME = 3;
const EXIT_UNAVAILABLE = 69;
const HEALTH_TIMEOUT_MS = 3000;
const READY_TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 5000;
const POLL_MS = 200;
const LOCK_TIMEOUT_MS = 30_000;
const LOG_ROTATE_BYTES = 1024 * 1024;
const SERVER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "board-server.js");
class Exit extends CodedError {
}
function unavailable(reason, fix) {
    return new Exit(EXIT_UNAVAILABLE, `看板服務無法啟動：${reason}。${fix}。這次的要求沒有寫入。`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Sends one request. "silent" means the service accepted the connection but never answered. */
function exchange(socketPath, message, timeoutMs) {
    return new Promise((resolve) => {
        const connection = net.connect(socketPath);
        let received = "";
        let sent = false;
        let settled = false;
        const settle = (outcome) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            connection.destroy();
            resolve(outcome);
        };
        const timer = setTimeout(() => settle({ kind: "silent", sent }), timeoutMs);
        connection.setEncoding("utf8");
        connection.on("connect", () => {
            connection.write(`${JSON.stringify(message)}\n`, () => {
                sent = true;
            });
        });
        connection.on("data", (chunk) => {
            received += chunk;
        });
        connection.on("end", () => {
            const line = received.split("\n")[0] ?? "";
            try {
                settle({ kind: "answer", response: JSON.parse(line) });
            }
            catch {
                settle({ kind: "silent", sent: true });
            }
        });
        connection.on("error", (error) => {
            if (!sent && (error.code === "ENOENT" || error.code === "ECONNREFUSED"))
                settle({ kind: "absent" });
            else
                settle({ kind: "silent", sent });
        });
    });
}
function request(op, args = {}) {
    return { v: 1, op, args };
}
async function health(paths) {
    const outcome = await exchange(paths.socket, request("health"), HEALTH_TIMEOUT_MS);
    if (outcome.kind === "absent")
        return { kind: "absent" };
    if (outcome.kind === "silent" || !outcome.response.ok)
        return { kind: "hung" };
    return { kind: "running", data: outcome.response.data };
}
function lastLogLines(paths, count) {
    if (!fs.existsSync(paths.log))
        return "";
    return fs.readFileSync(paths.log, "utf8").trimEnd().split("\n").slice(-count).join("\n");
}
function prepareRuntimeDir(paths) {
    try {
        fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
        fs.chmodSync(paths.runtimeDir, 0o700);
        if (fileSize(paths.log) > LOG_ROTATE_BYTES)
            fs.renameSync(paths.log, `${paths.log}.1`);
        fs.rmSync(paths.startupError, { force: true });
        return fs.openSync(paths.log, "a", 0o600);
    }
    catch (error) {
        throw unavailable(`state/ 不可寫（${error.message}）`, "檢查 state/ 的權限");
    }
}
function readStartupError(paths) {
    if (!fs.existsSync(paths.startupError))
        return null;
    try {
        const { reason, fix } = JSON.parse(fs.readFileSync(paths.startupError, "utf8"));
        return unavailable(reason, fix);
    }
    catch {
        return null;
    }
}
/** Starts the service detached from this process and waits until it answers health. */
async function start(config, paths) {
    const logFd = prepareRuntimeDir(paths);
    const child = spawn(process.execPath, [
        SERVER_SCRIPT,
        ...["home", "root", "commit", "state", "data", "config", "binding"].flatMap((name) => [`--${name}`, config[name]]),
        "--exempt",
        config.exempt.length === 0 ? "-" : config.exempt.join(","),
        "--port",
        String(config.port),
    ], { detached: true, stdio: ["ignore", logFd, logFd], cwd: paths.runtimeDir });
    child.unref();
    fs.closeSync(logFd);
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await sleep(POLL_MS);
        const failure = readStartupError(paths);
        if (failure !== null)
            throw failure;
        const state = await health(paths);
        if (state.kind === "running")
            return state.data;
    }
    throw unavailable("10 秒內沒有就緒", `看 ${paths.log} 找原因，最後幾行：\n${lastLogLines(paths, 20)}\n修好後再試`);
}
function commandLineOf(pid) {
    try {
        return execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
    }
    catch {
        return "";
    }
}
async function terminate(pid) {
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + KILL_GRACE_MS;
    while (isAlive(pid) && Date.now() < deadline)
        await sleep(POLL_MS);
    if (isAlive(pid))
        process.kill(pid, "SIGKILL");
    while (isAlive(pid))
        await sleep(POLL_MS);
}
/** Kills the board recorded in the pid file, but only when that process really is this home's board. */
async function killHung(config, paths) {
    const pid = readPidFile(paths.pid);
    const commandLine = pid === null ? "" : commandLineOf(pid);
    if (pid === null ||
        !commandLine.includes("board-server.js") ||
        !commandLine.includes(config.state)) {
        throw unavailable("看板服務沒有回應，而且找不到它的程序", `確認沒有別的程式佔著 ${paths.socket} 之後刪掉它再試`);
    }
    await terminate(pid);
}
async function stopAndWait(paths) {
    await exchange(paths.socket, request("stop"), HEALTH_TIMEOUT_MS);
    const deadline = Date.now() + KILL_GRACE_MS;
    while (Date.now() < deadline) {
        if ((await health(paths)).kind === "absent")
            return;
        await sleep(POLL_MS);
    }
}
/**
 * Whether the running board is the one this command would start: the same
 * code, port and binding file. A board started before the binding was written,
 * or with another one, is replaced.
 */
function matches(config, data) {
    return (data.code_commit === config.commit &&
        data.port === config.port &&
        data.binding_sha256 === config.binding);
}
/** Creates the lock directory; false when another client holds it. */
function tryLock(lock) {
    try {
        fs.mkdirSync(lock);
    }
    catch (error) {
        if (error.code === "EEXIST")
            return false;
        throw unavailable(`state/ 不可寫（${error.message}）`, "檢查 state/ 的權限");
    }
    fs.writeFileSync(path.join(lock, "pid"), `${process.pid}\n`);
    return true;
}
/**
 * Takes this home's start lock, so only one client at a time starts, kills, or
 * replaces the board. A lock whose owner has died is taken over.
 */
async function acquireStartLock(paths) {
    const lock = path.join(paths.runtimeDir, "start.lock");
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
    while (!tryLock(lock)) {
        const holder = readPidFile(path.join(lock, "pid"));
        const expired = Date.now() > deadline;
        if (holder === null ? expired : !isAlive(holder))
            fs.rmSync(lock, { recursive: true, force: true });
        else if (expired)
            throw unavailable("另一個指令正在啟動看板服務，等太久了", "稍後再試一次");
        else
            await sleep(POLL_MS);
    }
    return () => fs.rmSync(lock, { recursive: true, force: true });
}
/** Returns once a board running this code on the configured port answers health. */
async function ensureRunning(config, paths) {
    const first = await health(paths);
    if (first.kind === "running" && matches(config, first.data))
        return first.data;
    const release = await acquireStartLock(paths);
    try {
        // Another client may have fixed things while this one waited for the lock.
        const state = await health(paths);
        if (state.kind === "running" && matches(config, state.data))
            return state.data;
        if (state.kind === "hung")
            await killHung(config, paths);
        if (state.kind === "running")
            await stopAndWait(paths);
        return await start(config, paths);
    }
    finally {
        release();
    }
}
/** Records the flag at `args[index]` and returns the index of the last argument it took. */
function takeFlag(parsed, args, index, shape) {
    const arg = args[index];
    const name = arg.slice(2);
    const value = args[index + 1];
    if (Object.hasOwn(shape.repeated, name) && value !== undefined) {
        const list = shape.repeated[name];
        const values = parsed.flags.get(list);
        parsed.flags.set(list, [...(Array.isArray(values) ? values : []), value]);
        return index + 1;
    }
    if (shape.bare.includes(name)) {
        parsed.flags.set(name, true);
        return index;
    }
    if (shape.valued.includes(name) && value !== undefined) {
        parsed.flags.set(name, value);
        return index + 1;
    }
    throw new Exit(EXIT_USAGE, `不認得或缺值的參數：${arg}（myshape.sh --help 看用法）`);
}
/**
 * Splits arguments into positionals and the named flags; `valued` flags take
 * the next argument, and `repeated` ones (flag name to argument name) collect
 * every value they are given.
 */
function parseArgs(args, valued, bare = [], repeated = {}) {
    const parsed = { positional: [], flags: new Map() };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg.startsWith("--"))
            index = takeFlag(parsed, args, index, { valued, bare, repeated });
        else
            parsed.positional.push(arg);
    }
    return parsed;
}
function withFlags(base, parsed) {
    return { ...base, ...Object.fromEntries(parsed.flags) };
}
/** schedule add and edit: the topic, then the rule's parts, each optional for edit. */
const SCHEDULE_SHAPE = {
    positional: ["topic"],
    valued: ["weekly", "at", "tz", "duration", "lead", "rt"],
    bare: ["daily"],
};
const TOPIC_COMMANDS = {
    create: {
        positional: ["name"],
        valued: ["goal", "id", "queue"],
        repeated: { hashtag: "hashtags" },
        required: ["goal"],
    },
    merge: { positional: ["from", "into"], valued: ["reason"] },
    "close-propose": { positional: ["id"], valued: ["reason"], required: ["reason"] },
    move: { positional: ["id", "queue"], valued: ["before"], bare: ["first"] },
    rename: { positional: ["id", "value"] },
    split: {
        positional: ["from", "name"],
        valued: ["goal", "id", "reason"],
        bare: ["dry"],
        required: ["goal"],
    },
    goal: { positional: ["id", "value"] },
    archive: { positional: ["id"] },
    reopen: { positional: ["id"], valued: ["queue"] },
    "reset-token": { positional: [] },
    which: { positional: ["task"], valued: ["home"] },
    find: { positional: ["query"], bare: ["all"] },
    "todo-done": { positional: ["task"] },
    "todo-failed": { positional: ["task"], valued: ["reason"], required: ["reason"] },
    "todo-obsolete": { positional: ["task"], valued: ["reason"], required: ["reason"] },
    "schedule-add": SCHEDULE_SHAPE,
    "schedule-edit": SCHEDULE_SHAPE,
    "schedule-pause": { positional: ["topic"] },
    "schedule-resume": { positional: ["topic"] },
    "schedule-skip": { positional: ["topic"] },
    "schedule-rt": { positional: ["topic", "rt"] },
    "schedule-delete": { positional: ["topic"] },
    "schedule-take": { positional: ["key"], valued: ["note"] },
    "schedule-close": { positional: ["key", "outcome"], valued: ["note"] },
    "schedule-tick": { positional: [] },
};
function buildTopicRequest(sub, shape, args) {
    const parsed = parseArgs(args, shape.valued ?? [], shape.bare ?? [], shape.repeated ?? {});
    const missingFlag = (shape.required ?? []).find((name) => !parsed.flags.has(name));
    if (parsed.positional.length !== shape.positional.length || missingFlag !== undefined) {
        const wanted = [
            ...shape.positional.map((name) => `<${name}>`),
            ...(shape.required ?? []).map((name) => `--${name} <…>`),
        ].join(" ");
        throw new Exit(EXIT_USAGE, `${sub} 的用法：myshape.sh ${sub} ${wanted}（myshape.sh --help 看用法）`);
    }
    const named = Object.fromEntries(shape.positional.map((name, index) => [name, parsed.positional[index]]));
    return request(sub, withFlags(named, parsed));
}
function finish(response) {
    if (response.ok) {
        process.stdout.write(`${response.line}\n`);
        process.exit(0);
    }
    throw new Exit(response.code === "usage" ? EXIT_USAGE : EXIT_REFUSED, response.line);
}
/** Sends a request to a board known to be running and maps the outcome to an exit. */
async function send(config, paths, message) {
    let outcome = await exchange(paths.socket, message, REQUEST_TIMEOUT_MS);
    if (outcome.kind === "absent") {
        // The board went away between the health check and the request; nothing was sent.
        await ensureRunning(config, paths);
        outcome = await exchange(paths.socket, message, REQUEST_TIMEOUT_MS);
    }
    if (outcome.kind === "answer")
        return outcome.response;
    if (outcome.kind === "silent" && outcome.sent) {
        throw new Exit(EXIT_UNKNOWN_OUTCOME, "結果不明：要求已送出，但沒有收到回應。可以原樣重做一次。");
    }
    throw unavailable("看板服務沒有回應", "跑 myshape.sh status 看狀況");
}
const VERSION_LABEL = {
    same: "相同",
    different: "版本不同",
    incompatible: "版本不相容",
    unreported: "無法回報",
    unknown: "還沒讀到",
};
/** Whether the service reaches the agent side, and why not; then the binding it runs. */
function aggregatorLines(raw) {
    const aggregator = isRecord(raw) ? raw : {};
    const binding = isRecord(aggregator["binding"]) ? aggregator["binding"] : null;
    const reach = aggregator["connected"] === true
        ? `aggregator：已接上（${String(aggregator["label"])}）`
        : `aggregator：沒有接上（${String(aggregator["unavailable"] ?? "看板沒有回報原因")}）`;
    if (binding === null)
        return [reach];
    return [
        reach,
        `aggregator 設定：${String(binding["name"])}，feed ${String(binding["feed"])}，deliver ${String(binding["deliver"])}`,
    ];
}
/** One line per home with how its code version compares to the main home's. */
function homeLines(homes) {
    if (!Array.isArray(homes))
        return [];
    return homes.map((home) => `home ${home.id}：${VERSION_LABEL[home.version] ?? home.version}`);
}
function describeFiles(paths) {
    return [
        `events.jsonl：${fileSize(paths.events)} 位元組`,
        `summaries.jsonl：${fileSize(paths.summaries)} 位元組`,
        `audit.jsonl：${fileSize(paths.audit)} 位元組`,
    ];
}
function readTrimmed(file) {
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "（沒有）";
}
async function status(config, paths) {
    const state = await health(paths);
    const lines = [];
    if (state.kind === "running") {
        const outcome = await exchange(paths.socket, request("status"), HEALTH_TIMEOUT_MS);
        const data = outcome.kind === "answer" ? (outcome.response.data ?? {}) : {};
        lines.push("看板服務：在跑", `pid：${state.data.pid}`, `埠：${state.data.port}`, `程式版本：${state.data.code_commit}`, `程式目錄：${state.data.root}`, ...(state.data.code_commit === config.commit
            ? []
            : [`目前的程式是 ${config.commit}；下一個指令或 restart 會換成新版`]), ...(state.data.binding_sha256 === config.binding
            ? []
            : [`config/myshape-aggregator.json 和看板啟動時不同；下一個指令或 restart 會換上它`]), `啟動時間：${state.data.started_at}`, `輪詢：${data["polling"] === true ? "進行中" : "沒在跑"}`, ...aggregatorLines(data["aggregator"]), ...homeLines(data["homes"]));
    }
    else {
        lines.push(state.kind === "hung" ? "看板服務：沒有回應" : "看板服務：沒在跑", `上次的 pid：${readTrimmed(paths.pid)}`, `上次的埠：${readTrimmed(paths.port)}`);
    }
    process.stdout.write(`${[...lines, ...describeFiles(paths)].join("\n")}\n`);
    process.exit(0);
}
async function stop(paths) {
    const state = await health(paths);
    if (state.kind === "absent")
        finish({ ok: true, line: "ok stop 看板服務本來就沒在跑" });
    const outcome = await exchange(paths.socket, request("stop"), HEALTH_TIMEOUT_MS);
    if (outcome.kind === "answer")
        finish(outcome.response);
    throw new Exit(EXIT_REFUSED, "看板服務沒有回應 stop。跑 myshape.sh restart 會把它換掉。");
}
async function restart(config, paths) {
    if ((await health(paths)).kind === "running")
        await stopAndWait(paths);
    await ensureRunning(config, paths);
    return finish({ ok: true, line: "ok restart 看板服務已重啟" });
}
async function open(config, paths) {
    const running = await ensureRunning(config, paths);
    return finish({
        ok: true,
        line: `http://127.0.0.1:${running.port}/#t=${readTrimmed(paths.token)}`,
    });
}
/** summary and retract read their text from stdin: `<op> [--home <id>] <task-id> <kind> -`. */
async function summaryCommand(config, paths, [op, ...args]) {
    const parsed = parseArgs(args, ["home"]);
    const [task, kind, dash] = parsed.positional;
    if (parsed.positional.length !== 3 || dash !== "-") {
        throw new Exit(EXIT_USAGE, `${op} 的用法：myshape.sh ${op} [--home <id>] <task-id> <kind> -（本文走 stdin）`);
    }
    const text = fs.readFileSync(0, "utf8");
    await ensureRunning(config, paths);
    return finish(await send(config, paths, request(String(op), withFlags({ task, kind, text }, parsed))));
}
/** todo-add reads the item, one JSON object built by myshape.sh, from stdin. */
async function todoAdd(config, paths, args) {
    let item = null;
    try {
        item = JSON.parse(fs.readFileSync(0, "utf8"));
    }
    catch {
        item = null;
    }
    if (!isRecord(item) || args.length !== 1 || args[0] !== "-")
        throw new Exit(EXIT_USAGE, "todo-add 的項目要是一個 JSON 物件，從 stdin 讀（myshape.sh todo add 會組好）");
    await ensureRunning(config, paths);
    return finish(await send(config, paths, request("todo-add", item)));
}
const HASHTAG_USAGE = "hashtag 的用法：myshape.sh hashtag <議題 id> +<名稱>，或 myshape.sh hashtag <議題 id> --remove <名稱>（myshape.sh --help 看用法）";
/** The name in a `+NAME` argument, or null when the argument is not one. */
function addedName(change) {
    return change !== undefined && /^\+./u.test(change) ? change.slice(1) : null;
}
/** `hashtag <topic> +NAME` puts a hashtag on, `hashtag <topic> --remove NAME` takes it off. */
function hashtagRequest(args) {
    const parsed = parseArgs(args, ["remove"]);
    const [id, change, ...rest] = parsed.positional;
    const remove = parsed.flags.get("remove");
    const name = remove === undefined ? addedName(change) : change === undefined ? remove : null;
    if (id === undefined || rest.length > 0 || typeof name !== "string")
        throw new Exit(EXIT_USAGE, HASHTAG_USAGE);
    return request(remove === undefined ? "hashtag-add" : "hashtag-remove", { id, name });
}
async function topicCommand(config, paths, sub, args) {
    const shape = TOPIC_COMMANDS[sub];
    if (sub !== "hashtag" && shape === undefined)
        throw new Exit(EXIT_USAGE, `不認得的子命令：${sub}（myshape.sh --help 看用法）`);
    const message = shape === undefined ? hashtagRequest(args) : buildTopicRequest(sub, shape, args);
    await ensureRunning(config, paths);
    return finish(await send(config, paths, message));
}
const LIFECYCLE = {
    status,
    stop: (_config, paths) => stop(paths),
    restart,
    open,
};
async function run() {
    const { config, rest } = parseConfigArgs(process.argv.slice(2));
    const paths = boardPaths(config);
    const [sub = "", ...args] = rest;
    if (sub === "summary" || sub === "retract")
        return summaryCommand(config, paths, [sub, ...args]);
    if (sub === "todo-add")
        return todoAdd(config, paths, args);
    const lifecycle = LIFECYCLE[sub];
    return lifecycle === undefined
        ? topicCommand(config, paths, sub, args)
        : lifecycle(config, paths);
}
run().catch((error) => {
    if (error instanceof Exit) {
        process.stderr.write(`${error.message}\n`);
        process.exit(error.code);
    }
    process.stderr.write(`myshape.sh: ${error.stack ?? String(error)}\n`);
    process.exit(EXIT_REFUSED);
});
