// The topic board service. It runs in the main home, is the only writer of the
// topic files, and answers myshape.sh over a Unix socket.
//
// Started by board-client.js with the flags parseConfigArgs reads. Binding the
// TCP port decides which process is the board: only the process that holds the
// port may clear a stale socket file and bind the socket.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendLine, fileSize, isAlive, isRecord, readJsonFile, readPidFile, removeStaleTemps, stringField, writeFileAtomic, } from "./files.js";
import * as actions from "./actions.js";
import { createApi } from "./api.js";
import { ConfirmStore } from "./confirm.js";
import { serveBoard } from "./http.js";
import { ROLES, checkRole, readBinding, roleReason } from "./binding.js";
import { TASK_ID, commandRunner } from "./commands.js";
import { isConfirmed } from "./confirmations.js";
import { Journal, MAIN_HOME, Offsets, SUMMARY_KINDS, SUMMARY_MAX, Summaries } from "./journal.js";
import { boardPaths, parseConfigArgs } from "./layout.js";
import { MAX_REQUEST_BYTES } from "./protocol.js";
import { DispatchNotifier, fileStore } from "./notifier.js";
import { DEFAULT_TIMINGS, Poller } from "./poller.js";
import { DecisionStore, decisionStep } from "./decisions.js";
import { applyOperation, operationOf } from "./ops.js";
import { localLabel, machineTimeZone } from "./schedule-time.js";
import { TICK_MS, endedNotices, tick } from "./schedule-clock.js";
import { commitChange, loadBoard } from "./store.js";
import * as topics from "./topics.js";
import { buildView, placeTask } from "./view.js";
import { findLines } from "./lineage.js";
import { checkName, hashtagView, nameOfKey, topicsWith } from "./hashtags.js";
import { openKeys, scheduleView } from "./schedule-view.js";
import { scheduleOfTopic } from "./schedules.js";
import { beforeDeadline, findTasks, freshTags, knowHomes, lookupDeadline, reminderPrefix, } from "./lookup.js";
import { DEFAULT_WRITE_TIMINGS, WriteEngine } from "./writes.js";
import { deliveryRecord } from "./writes.js";
import { expiresAt } from "./writes.js";
const PRIVATE_FILE = 0o600;
const HEALTH_PROBE_MS = 3000;
const NOTIFY_DELAY_MS = 30_000;
const WRITE_HISTORY_MS = 24 * 60 * 60 * 1000;
const TEST_MODE = process.env["MYSHAPE_TEST"] === "1";
/** What the page and the board's texts call the agent side when its report names none. */
const DEFAULT_LABEL = "aggregator";
/** The account the service runs as, which must own every program it runs. */
const UID = process.getuid?.() ?? -1;
// sizeof(sun_path) minus the terminating NUL. Node silently truncates a longer
// path instead of failing, so the length is checked before listening.
const SOCKET_PATH_MAX = os.platform() === "darwin" ? 103 : 107;
function log(message) {
    process.stdout.write(`${new Date().toISOString()} ${process.pid} ${message}\n`);
}
function epochSeconds() {
    return Math.floor(Date.now() / 1000);
}
function now() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
/** Records why startup failed where the client can read it, then exits. */
function failStartup(paths, reason, fix) {
    log(`startup failed: ${reason}`);
    if (readPidFile(paths.pid) === process.pid)
        fs.rmSync(paths.pid, { force: true });
    try {
        writeFileAtomic(paths.startupError, `${JSON.stringify({ reason, fix })}\n`, PRIVATE_FILE);
    }
    catch (error) {
        log(`could not record the startup failure: ${error.message}`);
    }
    process.exit(1);
}
function refused(line) {
    return { ok: false, code: "refused", line };
}
function usage(line) {
    return { ok: false, code: "usage", line };
}
/** Where this service's commits go: its files and its journal. */
function commitTarget(service) {
    return {
        paths: service.paths,
        sink: {
            has: (rid) => service.journal.hasRecord(rid),
            append: (record) => service.journal.appendRecord(record),
        },
        nextRid: () => {
            service.records += 1;
            return `r-${service.bootId}-${service.records}`;
        },
        nowSeconds: epochSeconds,
    };
}
/** Hands the aggregator one notice about a hands-on item. */
function submitTodoNotice(service, notice) {
    const doc = service.board.topics.doc;
    const topic = notice.topic === null ? null : topics.resolveTopicId(doc, notice.topic);
    submitNotice(service, {
        kind: "notice",
        event: notice.event,
        text: notice.text,
        ...(topic === null ? {} : { topic: topicRef(service, topic) }),
        item: { id: notice.id, title: notice.title, ref: notice.ref },
        ...(notice.by === undefined ? {} : { by: notice.by }),
        ...(notice.words === undefined ? {} : { words: notice.words }),
    }, topic);
}
function healthData(service) {
    return {
        pid: process.pid,
        port: service.config.port,
        code_commit: service.config.commit,
        binding_sha256: service.config.binding,
        root: service.config.root,
        boot_id: service.bootId,
        started_at: service.startedAt,
    };
}
function statusData(service) {
    return {
        ...healthData(service),
        polling: service.poller.active,
        aggregator: aggregatorView(service),
        homes: service.poller.snapshots().map((home) => ({ id: home.id, version: home.version })),
        events_bytes: fileSize(service.paths.events),
        summaries_bytes: fileSize(service.paths.summaries),
        audit_bytes: fileSize(service.paths.audit),
    };
}
function resetToken(service) {
    writeFileAtomic(service.paths.token, `${crypto.randomBytes(32).toString("hex")}\n`, PRIVATE_FILE);
    return { ok: true, line: "ok reset-token 已重置，請重新跑 open" };
}
/**
 * The home a `--home` argument names, or a refusal when it is not a registered
 * secondmate. Its read of the root home counts against the request's `deadline`.
 */
async function homeArg(service, args, deadline) {
    const home = args["home"];
    if (home === undefined)
        return MAIN_HOME;
    if (typeof home !== "string")
        return usage("--home 要是 home 的 id。");
    // A board started just now has never read the root home, so it does not know the further homes yet.
    await knowHomes(service.poller, deadline);
    return service.poller.knows(home) && home !== MAIN_HOME
        ? home
        : refused(`--home ${home} 不是看板讀的 home。`);
}
function lookupHost(service) {
    return { poller: service.poller, topics: () => service.board.topics };
}
function taskArg(args) {
    const task = stringField(args, "task");
    return task !== null && TASK_ID.test(task) ? task : null;
}
/** The text of a summary, or a refusal when it is empty or too long. */
function summaryText(args) {
    const text = stringField(args, "text")?.trim() ?? "";
    const length = [...text].length;
    return length === 0 || length > SUMMARY_MAX
        ? refused(`摘要要有內容，而且最多 ${SUMMARY_MAX} 個字（這次是 ${length} 個）。`)
        : text;
}
/** The summary a `summary` or `retract` request describes, or the response that turns it down. */
async function summaryArg(service, op, args, deadline) {
    const task = taskArg(args);
    const kind = SUMMARY_KINDS.find((name) => name === args["kind"]);
    if (task === null || kind === undefined)
        return usage(`${op} 需要 task id 與 ready、report、failed、landed 其中一種。`);
    const text = summaryText(args);
    if (typeof text !== "string")
        return text;
    const home = await homeArg(service, args, deadline);
    if (typeof home !== "string")
        return home;
    return { ts: epochSeconds(), home, task, kind, text };
}
async function summary(service, args) {
    const deadline = lookupDeadline();
    const wanted = await summaryArg(service, "summary", args, deadline);
    if ("ok" in wanted)
        return wanted;
    if (service.summaries.add(wanted))
        service.version += 1;
    const line = await reminderPrefix(lookupHost(service), wanted.home, wanted.task, deadline);
    return { ok: true, line };
}
/** Takes a summary that turned out wrong off the board; the request's text is the reason. */
async function retract(service, args) {
    const wanted = await summaryArg(service, "retract", args, lookupDeadline());
    if ("ok" in wanted)
        return wanted;
    const gone = service.summaries.retract(wanted);
    if (gone === null)
        return refused(`${wanted.task} 沒有可以撤回的 ${wanted.kind} 摘要。`);
    service.version += 1;
    return { ok: true, line: `ok 已撤回 ${wanted.task} 的 ${wanted.kind} 摘要：${gone.text}` };
}
async function which(service, args) {
    const task = taskArg(args);
    if (task === null)
        return usage("which 需要 task id。");
    const deadline = lookupDeadline();
    const home = await homeArg(service, args, deadline);
    if (typeof home !== "string")
        return home;
    return { ok: true, line: await reminderPrefix(lookupHost(service), home, task, deadline) };
}
/**
 * Where a topic or task is now and how it got there. The main home is read
 * afresh first, like `which`; other homes answer from their last read.
 */
/** The hashtag `query` names, with the topics that carry it, or null when the board has none such. */
function taggedBy(service, query) {
    const checked = checkName(query);
    if (typeof checked === "string")
        return null;
    const name = nameOfKey(service.board.hashtags, checked.key);
    return name === undefined ? null : { name, topics: topicsWith(service.board.hashtags, name) };
}
/** The topics that carry the hashtag `name`; none when the board has no such hashtag. */
function hashtagTopics(service, name) {
    return taggedBy(service, name)?.topics ?? [];
}
/**
 * Where a topic, hashtag or task is now and how it got there. The main home is
 * read afresh first, like `which`; other homes answer from their last read. A
 * keyword that is a hashtag the board has is not looked up as a task: that
 * lookup can fall back to reading the whole home when the topics call fails.
 */
async function find(service, args) {
    const query = topics.oneLine(stringField(args, "query") ?? "", topics.NAME_MAX);
    if (query === null)
        return usage(`find 需要一行關鍵字，最多 ${topics.NAME_MAX} 個字。`);
    const tagged = taggedBy(service, query);
    const isTask = tagged === null && taskArg({ task: query }) !== null;
    const tasks = isTask ? await findTasks(service.poller, query, lookupDeadline()) : [];
    const everything = args["all"] === true;
    const lines = findLines(service.board.topics, query, tasks, everything, tagged);
    return { ok: true, line: lines.join("\n") };
}
function writeView(record) {
    return {
        id: record.id,
        kind: record.action.kind,
        home: record.home,
        task: record.task,
        topic: record.topic,
        text: record.text,
        state: record.state,
        error: record.error,
        attempt: record.attempt,
        next_at: record.nextAt,
        created_at: record.createdAt,
    };
}
/** Writes worth showing: everything from the last day, plus anything still unsettled. */
function visibleWrites(service) {
    const settled = ["delivered", "handled_elsewhere", "ignored", "expired"];
    const cutoff = Date.now() - WRITE_HISTORY_MS;
    return [...service.writes.records.values()]
        .filter((record) => record.createdAt >= cutoff || !settled.includes(record.state))
        .map(writeView);
}
function actionContext(service) {
    return {
        topics: service.board.topics,
        homes: service.poller.snapshots(),
        writes: service.writes,
    };
}
/**
 * What a viewer compares to learn that the board changed. A home going stale is
 * a change no read announces, so each home's staleness is part of the version.
 */
function viewVersion(service) {
    const nowMs = Date.now();
    const stale = service.poller
        .snapshots()
        .map((home) => home.lastOkAt === null || nowMs - home.lastOkAt > service.timings.staleMs ? "1" : "0");
    // A program changing on disk is a change no write announces either, and an
    // occurrence passing its closes_by is one even when the clock saves nothing.
    const open = openKeys(service.board.schedules, nowMs);
    const reach = crypto
        .createHash("sha256")
        .update(JSON.stringify([blockedReasons(service), programsToConfirm(service), open]))
        .digest("hex")
        .slice(0, 12);
    return `${service.version}-${stale.join("")}-${reach}`;
}
/** The name the board's texts use for the agent side. */
function labelOf(service) {
    return service.aggregator?.label ?? DEFAULT_LABEL;
}
/**
 * What the binding and the program allow for one role right now. The binding
 * and the program are read again on every call, so a change to either takes
 * effect at the next run.
 */
function roleCheck(service, role) {
    const read = readBinding(service.paths.binding, UID);
    const input = {
        root: service.config.root,
        uid: UID,
        exempt: (written) => read.kind === "ok" &&
            read.sha256 === service.config.binding &&
            service.config.exempt.includes(written),
        confirmed: (program, sha256) => read.kind === "ok" && isConfirmed(service.board.confirmations, program, sha256, read.sha256),
    };
    return checkRole(read, role, input);
}
/** The gate the runner asks right before every run. */
function programGate(service) {
    return (role) => {
        const check = roleCheck(service, role);
        const reason = roleReason(check);
        if (reason !== null || check.kind !== "program")
            return { blocked: reason ?? "" };
        return { program: check.check.path };
    };
}
/** The programs waiting for the captain's confirmation, one entry per program. */
function programsToConfirm(service) {
    const read = readBinding(service.paths.binding, UID);
    if (read.kind !== "ok")
        return [];
    const found = new Map();
    for (const role of ROLES) {
        const check = roleCheck(service, role);
        if (check.kind !== "program" || check.check.ok || check.check.confirm === null)
            continue;
        const { path: program, confirm } = check.check;
        const entry = found.get(program) ?? {
            path: program,
            sha256: confirm.sha256,
            binding_sha256: read.sha256,
            roles: [],
        };
        entry.roles.push(role);
        found.set(program, entry);
    }
    return [...found.values()];
}
/** Why the board cannot reach the aggregator now, one reason per problem; empty when it can. */
function blockedReasons(service) {
    const reasons = ROLES.map((role) => roleReason(roleCheck(service, role)));
    return [...new Set(reasons.filter((reason) => reason !== null))];
}
function aggregatorView(service) {
    const reasons = blockedReasons(service);
    const read = readBinding(service.paths.binding, UID);
    return {
        connected: reasons.length === 0,
        unavailable: reasons.length === 0 ? null : reasons.join("；"),
        binding: read.kind === "ok" ? read.binding : null,
        confirm: programsToConfirm(service).map(({ path: program, sha256, roles }) => ({
            path: program,
            sha256,
            roles,
        })),
        name: service.aggregator?.name ?? null,
        label: labelOf(service),
        update_hint: service.aggregator?.update_hint ?? null,
    };
}
/** The board's saved records, oldest first, as the hashtag rails and the page read them. */
function boardRecords(service) {
    return service.journal.events.flatMap((event) => (event.src === "board" ? [event] : []));
}
function boardView(service) {
    return {
        hashtags: hashtagView(service.board.hashtags, boardRecords(service)),
        schedules: scheduleView(service.board.schedules, service.board.topics, boardRecords(service), Date.now()),
        boot_id: service.bootId,
        code_commit: service.config.commit,
        aggregator: aggregatorView(service),
        version: viewVersion(service),
        polling: service.poller.active,
        writes: visibleWrites(service),
        ...buildView({
            topics: service.board.topics,
            todos: service.board.todos,
            homes: service.poller.snapshots(),
            events: service.journal.events,
            summaries: service.summaries.all,
            nowMs: Date.now(),
            staleMs: service.timings.staleMs,
            label: labelOf(service),
        }),
    };
}
/** Test-only: the whole board state, as the page will get it. Counts as a viewer. */
async function dump(service, args) {
    service.poller.touch();
    if (args["refresh"] === true)
        await service.poller.refreshAll();
    return { ok: true, line: "ok", data: boardView(service) };
}
function actionResponse(result) {
    return result.ok
        ? { ok: true, line: `ok ${result.write.id}`, data: { write_id: result.write.id } }
        : refused(result.line);
}
/** Test-only: submit a write the way the browser API will. */
async function testWrite(service, args) {
    const context = actionContext(service);
    const field = (name) => stringField(args, name) ?? "";
    switch (args["kind"]) {
        case "message":
            return actionResponse(actions.message(context, field("topic"), field("text"), "socket"));
        case "direct":
            return actionResponse(actions.direct(context, field("home"), field("task"), field("text"), "socket"));
        case "tag":
            return actionResponse(actions.tagAgent(context, field("home"), field("task"), field("topic"), "socket"));
        case "answer": {
            const input = {
                home: field("home"),
                task: field("task"),
                answer: field("answer"),
                label: field("label"),
            };
            return actionResponse(actions.answer(context, input, "socket"));
        }
        default:
            return usage("不認得的寫入種類。");
    }
}
async function testResend(service, args) {
    const problem = service.writes.resend(stringField(args, "write_id") ?? "", args["confirmed"] === true);
    return problem === null ? { ok: true, line: "ok" } : refused(problem);
}
async function testIgnore(service, args) {
    const problem = service.writes.ignore(stringField(args, "write_id") ?? "");
    return problem === null ? { ok: true, line: "ok" } : refused(problem);
}
const SERVICE_HANDLERS = {
    health: async (service) => ({ ok: true, line: "ok", data: { ...healthData(service) } }),
    status: async (service) => ({ ok: true, line: "ok", data: statusData(service) }),
    stop: async () => ({ ok: true, line: "ok stop 看板服務已停止" }),
    "reset-token": async (service) => resetToken(service),
    summary,
    retract,
    which,
    find,
    "schedule-tick": async (service) => runClock(service),
    ...(TEST_MODE
        ? { dump, "test-write": testWrite, "test-resend": testResend, "test-ignore": testIgnore }
        : {}),
};
async function handle(service, request) {
    const serviceHandler = Object.hasOwn(SERVICE_HANDLERS, request.op)
        ? SERVICE_HANDLERS[request.op]
        : undefined;
    if (serviceHandler !== undefined)
        return serviceHandler(service, request.args);
    // The records a command writes name the agent side; a board that never read
    // the root home asks it once, so they do not say "aggregator" for Firstmate.
    // A hands-on op never waits for a read: the aggregator may be asking from inside one.
    const commitFile = operationOf(request.op)?.commitFile;
    const reads = commitFile === "topics" || commitFile === "hashtags" || commitFile === "schedules";
    if (service.aggregator === null && reads)
        await beforeDeadline(lookupDeadline(), false, () => service.poller.readNow(MAIN_HOME));
    return topicOp(service, request.op, request.args);
}
function parseRequest(line) {
    let raw;
    try {
        raw = JSON.parse(line);
    }
    catch {
        return null;
    }
    if (!isRecord(raw) || raw["v"] !== 1)
        return null;
    const { op, args } = raw;
    if (typeof op !== "string" || !isRecord(args))
        return null;
    return { v: 1, op, args };
}
function shutdown(service) {
    log("stopping");
    if (service.clock !== undefined && service.clock !== null)
        clearInterval(service.clock);
    service.poller?.stop();
    service.writes?.stop();
    service.notifier?.stop();
    service.ipc?.close();
    service.web.close();
    for (const file of [service.paths.socket, service.paths.pid]) {
        fs.rmSync(file, { force: true });
    }
    process.exit(0);
}
async function respond(service, connection, line) {
    const request = parseRequest(line);
    let response;
    try {
        response = request === null ? usage("要求不是合法的 JSON。") : await handle(service, request);
    }
    catch (error) {
        log(`request failed: ${error.stack ?? String(error)}`);
        response = refused(`看板服務處理這個要求時出錯：${error.message}`);
    }
    connection.end(`${JSON.stringify(response)}\n`, () => {
        if (request?.op === "stop" && response.ok)
            shutdown(service);
    });
}
function serveConnection(service, connection) {
    let buffered = "";
    let answered = false;
    connection.setEncoding("utf8");
    connection.on("error", (error) => log(`connection error: ${error.message}`));
    connection.on("data", (chunk) => {
        if (answered)
            return;
        buffered += chunk;
        const newline = buffered.indexOf("\n");
        if (newline === -1 && Buffer.byteLength(buffered) <= MAX_REQUEST_BYTES)
            return;
        answered = true;
        if (newline === -1) {
            connection.end(`${JSON.stringify(usage("要求太大。"))}\n`);
            return;
        }
        void respond(service, connection, buffered.slice(0, newline));
    });
}
/** A positive MYSHAPE_<name>_MS from the environment, else `fallback`. */
function override(name, fallback) {
    const value = Number(process.env[`MYSHAPE_${name}_MS`]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}
/** Test runs may shorten the poll timings through MYSHAPE_*_MS variables. */
function pollTimings() {
    if (!TEST_MODE)
        return DEFAULT_TIMINGS;
    return {
        ...DEFAULT_TIMINGS,
        readMs: override("READ", DEFAULT_TIMINGS.readMs),
        idleMs: override("IDLE", DEFAULT_TIMINGS.idleMs),
        staleMs: override("STALE", DEFAULT_TIMINGS.staleMs),
    };
}
/** Test runs may shorten the write timings through MYSHAPE_RETRY_MS and _RESUME_MS. */
function writeTimings() {
    if (!TEST_MODE)
        return DEFAULT_WRITE_TIMINGS;
    const delays = (process.env["MYSHAPE_RETRY_MS"] ?? "").split(",").map(Number);
    const resume = Number(process.env["MYSHAPE_RESUME_MS"]);
    return {
        ...DEFAULT_WRITE_TIMINGS,
        ...(delays.every((delay) => Number.isFinite(delay) && delay > 0)
            ? { retryDelaysMs: delays }
            : {}),
        ...(Number.isFinite(resume) && resume > 0 ? { resumeWindowMs: resume } : {}),
    };
}
function notifyDelay() {
    const configured = Number(process.env["MYSHAPE_NOTIFY_MS"]);
    return TEST_MODE && Number.isFinite(configured) && configured > 0 ? configured : NOTIFY_DELAY_MS;
}
/**
 * Hands the aggregator one notice about something that happened on the
 * board; under a fixed id, handing it in again does nothing.
 */
function submitNotice(service, notice, topic, fixed) {
    service.writes.submit({ channel: "auto", home: MAIN_HOME, task: null, topic, text: notice.text, action: notice }, fixed);
}
function submitScheduleNotice(service, notice) {
    submitNotice(service, notice.action, notice.topic, notice.fixed);
}
/** Gives up on the not yet handed over notices of occurrences that have ended. */
function voidEndedNotices(service) {
    for (const id of endedNotices(service.board.schedules))
        service.writes.expire(id, "沒送：這一場已經結束");
}
/**
 * One check of the schedule clock (schedule-clock.ts): saves what it changed
 * with records by the board, then hands over its notices. When the change
 * cannot be saved nothing is handed over, and the next check tries again.
 * It never reads a home.
 */
function runClock(service) {
    const result = tick(service.board.schedules, {
        topics: service.board.topics,
        nowMs: Date.now(),
    });
    if (result.change !== null) {
        const change = {
            file: "schedules",
            next: result.change.store,
            records: result.change.records,
        };
        const saved = commitChange(commitTarget(service), service.board, change, {
            by: "board",
            label: labelOf(service),
        });
        if (!saved.ok) {
            log(`schedule clock could not save: ${saved.line}`);
            return refused(saved.line);
        }
        service.board = saved.board;
        service.version += 1;
        if (saved.appendError !== null)
            log(`records wait in the outbox: ${saved.appendError}`);
    }
    voidEndedNotices(service);
    service.writes.expireOverdue();
    for (const notice of result.notices)
        submitScheduleNotice(service, notice);
    return { ok: true, line: result.line };
}
/** Runs the clock every 30 seconds; a failed check is logged and the next one runs as usual. */
function startClock(service) {
    const check = () => {
        try {
            runClock(service);
        }
        catch (error) {
            log(`schedule clock failed: ${error.stack ?? String(error)}`);
        }
    };
    check();
    service.clock = setInterval(check, TICK_MS);
}
/** Records that a notice expired unsent, under its topic. */
function recordExpired(service, record) {
    const at = expiresAt(record.action);
    const until = at === null ? "" : `（期限 ${localLabel(machineTimeZone(), at)}）`;
    const text = `${record.error ?? "沒送"}${until}：${record.text}`;
    saveRecords(service, [{ kind: "writes.expired", topic: record.topic, text }], "board");
}
function topicRef(service, id) {
    const name = service.board.topics.doc.topics[id]?.name ?? service.board.topics.archive.topics[id]?.name;
    return { id, name: name ?? id };
}
/**
 * Says which topics just became dispatchable and where they now stand, one
 * notice each. It reports what happened, never what to run.
 */
function notifyDispatchable(service, ready) {
    for (const { id, reason } of ready) {
        const queue = topics.QUEUES.find((name) => service.board.topics.doc.queues[name].includes(id));
        if (queue === undefined || queue === "later")
            continue;
        const list = service.board.topics.doc.queues[queue];
        const index = list.indexOf(id);
        const place = index === list.length - 1 ? "最後" : `第 ${index + 1}`;
        const ref = topicRef(service, id);
        const what = reason === "reopened" ? "重開" : "離開「待辦」";
        const text = `議題「${ref.name}」${what}，排在「${topics.QUEUE_LABEL[queue]}」${place}，現在可派`;
        submitNotice(service, { kind: "notice", event: "topic.dispatchable", text, topic: ref }, id);
    }
}
/**
 * Saves records only, through the same commit as every change; a failure is
 * logged, not thrown. Returns whether they were saved.
 */
function saveRecords(service, records, by) {
    const change = { file: "topics", next: service.board.topics, records };
    const saved = commitChange(commitTarget(service), service.board, change, {
        by,
        label: labelOf(service),
    });
    if (!saved.ok) {
        log(`could not save a record: ${saved.line}`);
        return false;
    }
    service.board = saved.board;
    if (saved.appendError !== null)
        log(`records wait in the outbox: ${saved.appendError}`);
    service.version += 1;
    return true;
}
/** The record of handing the waiting writes over, oldest first, saved before they go. */
function recordRelease(service, ids) {
    const name = readBinding(service.paths.binding, UID);
    const who = name.kind === "ok" ? name.binding.name : labelOf(service);
    const text = `接上 ${who}，依序送出等著的 ${ids.length} 筆：${ids.join("、")}`;
    return saveRecords(service, [{ kind: "writes.released", topic: null, text }], "board");
}
/** After the captain confirmed a program: waiting writes go, and reading starts again. */
function programConfirmed(service) {
    service.writes.releaseWaiting();
    service.poller.touch();
    void service.poller.readNow(MAIN_HOME);
    service.version += 1;
}
/** The states of a page write that is still being sent. */
const SENDING = ["waiting", "sending", "retrying"];
/**
 * What the board knows of its own answer to `home`/`task`: its hold.answered
 * record (whose outcome is the answer or its label), a write still being
 * sent, or neither.
 */
function pageAnswerState(service, home, task, answers) {
    const recorded = service.journal.events.some((event) => event.src === "board" &&
        event.kind === "hold.answered" &&
        event.home === home &&
        event.task === task &&
        answers.includes(event.outcome ?? ""));
    if (recorded)
        return "recorded";
    const sending = [...service.writes.records.values()].some((write) => write.action.kind === "answer" &&
        write.home === home &&
        write.task === task &&
        SENDING.includes(write.state));
    return sending ? "pending" : "none";
}
/**
 * Records the decisions one good read of `home` opened or closed, then
 * remembers what the read showed. Records first, memory second: a crash in
 * between reads the same piece again, and the records' keys keep it once.
 */
function recordDecisions(service, home, report, readStartedAt) {
    const homes = service.poller.snapshots();
    const step = decisionStep({
        home,
        previous: service.decisions.get(home),
        report,
        readAt: epochSeconds(),
        readStartedAt,
        saved: (key) => service.journal.hasKey(key),
        topicOf: (task, origin) => {
            const own = placeTask(service.board.topics, homes, home, task).topic;
            if (own !== null || origin === "")
                return own;
            return placeTask(service.board.topics, homes, home, origin).topic;
        },
        pageAnswer: (task, answers) => pageAnswerState(service, home, task, answers),
    });
    const [first, ...rest] = step.drafts;
    if (first !== undefined) {
        const before = service.board;
        saveRecords(service, [first, ...rest], "board");
        // A record that could not be saved is read again next time, so nothing is remembered yet.
        if (service.board === before)
            return;
    }
    service.decisions.set(home, step.next);
}
/** Records how a page write that changes another home ended, and re-reads that home. */
function recordFinished(service, record) {
    const draft = deliveryRecord(record);
    if (draft === null)
        return;
    saveRecords(service, [draft], record.state === "delivered" ? "captain" : "board");
    void service.poller.readNow(record.home);
}
/**
 * Returns `task`'s tag text in `home` from a read that starts now ("" when it
 * has none), or null when the read failed. A board that has not read the root
 * home since it started does not know the further homes yet, so it reads the
 * root home first.
 */
async function readTags(service, home, task) {
    if (!service.poller.knows(home))
        await service.poller.readNow(MAIN_HOME);
    const tags = await freshTags(service.poller, home, task);
    if (tags === null)
        return null;
    return Object.hasOwn(tags, task) ? tags[task] : "";
}
/** The aggregator block kept from an earlier start, or null. */
function loadAggregator(file) {
    let raw = null;
    try {
        raw = readJsonFile(file);
    }
    catch {
        return null;
    }
    if (!isRecord(raw))
        return null;
    return {
        name: stringField(raw, "name"),
        label: stringField(raw, "label"),
        update_hint: stringField(raw, "update_hint"),
    };
}
/** Keeps the root report's aggregator block, so texts written before the next read can use it. */
function rememberAggregator(service, aggregator) {
    if (JSON.stringify(aggregator) === JSON.stringify(service.aggregator))
        return;
    service.aggregator = aggregator;
    if (aggregator === null)
        fs.rmSync(service.paths.aggregator, { force: true });
    else
        writeFileAtomic(service.paths.aggregator, `${JSON.stringify(aggregator)}\n`, 0o644);
    service.version += 1;
}
/** Loads everything the board keeps on disk and returns the running service's state. */
function loadService(boot) {
    const { paths } = boot;
    fs.mkdirSync(paths.boardDataDir, { recursive: true });
    for (const dir of [paths.runtimeDir, paths.dataDir, paths.boardDataDir]) {
        for (const name of removeStaleTemps(dir))
            log(`removed stale temp file ${name} in ${dir}`);
    }
    const timings = pollTimings();
    const journal = new Journal(paths.events);
    const aggregator = loadAggregator(paths.aggregator);
    const starting = { ...boot, journal, records: 0 };
    const loaded = loadBoard(commitTarget(starting), aggregator?.label ?? DEFAULT_LABEL);
    for (const problem of loaded.appendErrors)
        log(`records wait in the outbox: ${problem}`);
    const run = commandRunner(boot.config, (role) => programGate(service)(role));
    const bump = () => {
        service.version += 1;
    };
    const decisions = new DecisionStore(paths.decisions);
    const service = {
        ...boot,
        board: loaded.board,
        decisions,
        journal,
        records: starting.records,
        summaries: new Summaries(paths.summaries),
        timings,
        version: 1,
        ipc: null,
        clock: null,
        aggregator,
        poller: new Poller(run, journal, new Offsets(paths), timings, {
            onChange: bump,
            onAggregator: (reported) => rememberAggregator(service, reported),
            closedCursor: (home) => decisions.get(home)?.cursor ?? null,
            onReport: (home, report, startedAt) => {
                recordDecisions(service, home, report, startedAt);
                // A deliverer that may run again without a start or a confirmation
                // (a binding put back as it was) hands its waiting writes over here.
                if (home === MAIN_HOME)
                    service.writes.releaseWaiting();
            },
            onCursorRefused: (home) => decisions.forget(home),
        }, () => roleReason(roleCheck(service, "feed"))),
        confirm: new ConfirmStore(),
        notifier: new DispatchNotifier(notifyDelay(), fileStore(paths.notifyPending), (ready) => notifyDispatchable(service, ready)),
        writes: new WriteEngine(paths.audit, {
            run,
            blocked: () => roleReason(roleCheck(service, "deliver")),
            onRelease: (ids) => recordRelease(service, ids),
            readTags: (home, task) => readTags(service, home, task),
            onChange: bump,
            onFinished: (record) => recordFinished(service, record),
            onExpired: (record) => recordExpired(service, record),
        }, writeTimings()),
    };
    const reasons = blockedReasons(service);
    if (reasons.length > 0)
        log(`not connected to an aggregator: ${reasons.join("; ")}`);
    service.writes.resumeUnfinished();
    announceConfirmed(service, loaded.confirmed);
    service.notifier.start(service.board.topics);
    startClock(service);
    return service;
}
/**
 * Tells the agent side which leftover proposals this start confirmed (their
 * records were saved with the change); it may still be waiting for the
 * captain to confirm them.
 */
function announceConfirmed(service, confirmed) {
    if (confirmed.length === 0)
        return;
    const lines = confirmed.map((proposal) => `議題「${proposal.name}」已確認，排在「${topics.QUEUE_LABEL[proposal.queue]}」最後（id：${proposal.id}）`);
    const text = `看板不再等確認，還在提議中的議題已確認：${lines.join("；")}`;
    submitNotice(service, { kind: "notice", event: "topic.confirmed", text }, null);
}
/**
 * Tells the agent side what the captain decided on the page. The agent
 * proposes closings and then waits; without this it would learn the outcome
 * only by asking.
 */
function notifyDecision(service, notices) {
    for (const notice of notices) {
        const text = `使用者在看板上：${notice.line}`;
        submitNotice(service, {
            kind: "notice",
            event: notice.event,
            text,
            ...(notice.topic === null ? {} : { topic: topicRef(service, notice.topic) }),
        }, notice.topic);
    }
}
/**
 * Runs one operation from the table (ops.ts). `fromPage` is true for the
 * browser API: only then is the agent side told what the captain decided,
 * since over the socket it is the agent itself asking. Once a change is
 * saved it is in effect, so its notices go out even when its records could
 * not be appended yet.
 */
function topicOp(service, op, args, fromPage = false) {
    const before = service.board;
    const who = {
        label: labelOf(service),
        agent: service.aggregator?.name ?? DEFAULT_LABEL,
        now: now(),
        records: boardRecords(service),
        zone: machineTimeZone(),
    };
    const applied = applyOperation(commitTarget(service), before, { op, args, fromPage }, who);
    if (applied.committed !== null) {
        if (applied.committed === "topics")
            service.notifier.observe(before.topics, applied.board.topics, applied.dispatchable);
        service.board = applied.board;
        service.version += 1;
        if (applied.appendError !== null)
            log(`records wait in the outbox: ${applied.appendError}`);
    }
    notifyDecision(service, applied.decisions);
    for (const notice of applied.notices)
        submitTodoNotice(service, notice);
    for (const notice of applied.scheduleNotices)
        submitScheduleNotice(service, notice);
    if (applied.committed !== null)
        voidEndedNotices(service);
    return applied.response;
}
/** Starts answering browser requests on the port this process already holds. */
function serveBrowser(service) {
    const dist = path.dirname(fileURLToPath(import.meta.url));
    const publicDir = path.join(dist, "..", "public");
    serveBoard(service.web, {
        port: service.config.port,
        tokenFile: service.paths.token,
        assetDirs: [publicDir, path.join(dist, "page")],
        indexFile: path.join(publicDir, "index.html"),
        api: createApi({
            bootId: service.bootId,
            version: () => viewVersion(service),
            view: () => boardView(service),
            touch: () => service.poller.touch(),
            refresh: () => service.poller.refreshAll(),
            topicOp: (op, args) => topicOp(service, op, args, true),
            actionContext: () => actionContext(service),
            writes: service.writes,
            confirm: service.confirm,
            programToConfirm: (role) => {
                const found = programsToConfirm(service).find((entry) => entry.roles.includes(role));
                return found ?? roleReason(roleCheck(service, role)) ?? "這支程式不需要確認。";
            },
            programConfirmed: () => programConfirmed(service),
            hashtagTopics: (name) => hashtagTopics(service, name),
            scheduleOf: (topic) => scheduleOfTopic(service.board.schedules, service.board.topics, topic)?.id ?? null,
        }),
        // Only the path is recorded: a query string could carry a token someone pasted into the URL.
        onRejected: (reason, request) => {
            const entry = {
                ts: new Date().toISOString(),
                rejected: reason,
                host: request.headers.host ?? null,
                origin: request.headers.origin ?? null,
                path: (request.url ?? "").split("?")[0] ?? null,
            };
            appendLine(service.paths.audit, JSON.stringify(entry), PRIVATE_FILE);
        },
    });
}
function bindSocket(service) {
    const { paths } = service;
    fs.rmSync(paths.socket, { force: true });
    const ipc = net.createServer((connection) => serveConnection(service, connection));
    ipc.on("error", (error) => failStartup(paths, `socket 綁不起來（${error.message}）`, "檢查 state/myshape 的權限"));
    const previousMask = process.umask(0o177);
    ipc.listen(paths.socket, () => {
        process.umask(previousMask);
        service.ipc = ipc;
        serveBrowser(service);
        fs.rmSync(paths.startupError, { force: true });
        log(`ready on port ${service.config.port}, commit ${service.config.commit}`);
    });
}
function becomeTheBoard(boot) {
    const { paths, config } = boot;
    // Claim the pid file before the slow part of startup: a second board started
    // meanwhile reads it to learn the port is held by a board, not a stranger.
    writeFileAtomic(paths.pid, `${process.pid}\n`, PRIVATE_FILE);
    let service;
    try {
        service = loadService(boot);
    }
    catch (error) {
        failStartup(paths, error.message, "修好或移開那個檔之後再試");
    }
    if (!fs.existsSync(paths.token)) {
        writeFileAtomic(paths.token, `${crypto.randomBytes(32).toString("hex")}\n`, PRIVATE_FILE);
    }
    writeFileAtomic(paths.port, `${config.port}\n`, PRIVATE_FILE);
    process.removeAllListeners("SIGTERM").on("SIGTERM", () => shutdown(service));
    process.removeAllListeners("SIGINT").on("SIGINT", () => shutdown(service));
    bindSocket(service);
}
/** The port is taken: exit quietly if a board already answers, else report who holds it. */
function yieldOrFail(boot) {
    const { paths, config } = boot;
    const holderIsNotBoard = () => failStartup(paths, `埠 ${config.port} 被別的程式佔用`, "在 config/myshape-port 寫另一個埠號");
    const holder = readPidFile(paths.pid);
    if (holder !== null && holder !== process.pid && isAlive(holder)) {
        log(`board ${holder} already holds the port; exiting`);
        process.exit(0);
    }
    const probe = net.connect(paths.socket);
    const timer = setTimeout(holderIsNotBoard, HEALTH_PROBE_MS);
    probe.on("connect", () => probe.write(`${JSON.stringify({ v: 1, op: "health", args: {} })}\n`));
    probe.on("data", () => {
        clearTimeout(timer);
        log("another board already holds the port; exiting");
        process.exit(0);
    });
    probe.on("error", () => {
        clearTimeout(timer);
        holderIsNotBoard();
    });
}
function main() {
    const { config } = parseConfigArgs(process.argv.slice(2));
    const paths = boardPaths(config);
    const socketBytes = Buffer.byteLength(paths.socket);
    if (socketBytes > SOCKET_PATH_MAX) {
        failStartup(paths, `socket 路徑太長（${socketBytes} 位元組，上限 ${SOCKET_PATH_MAX}）`, "home 的路徑太深，請把 home 搬到較短的路徑");
    }
    const web = http.createServer((_request, response) => {
        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("not found\n");
    });
    const boot = {
        config,
        paths,
        bootId: crypto.randomBytes(8).toString("hex"),
        startedAt: now(),
        web,
    };
    web.once("error", (error) => {
        if (error.code === "EADDRINUSE")
            yieldOrFail(boot);
        else
            failStartup(paths, `埠 ${config.port} 綁不起來（${error.message}）`, "在 config/myshape-port 寫另一個埠號");
    });
    web.listen(config.port, "127.0.0.1", () => becomeTheBoard(boot));
    process.on("SIGTERM", () => shutdown(boot));
    process.on("SIGINT", () => shutdown(boot));
}
main();
