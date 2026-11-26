// The schedule rows of the operation table (ops.ts OPERATIONS): how each
// request's arguments become a call into schedules.ts. Settings, locks,
// pausing everything, undoing a change and marking the aggregator's changes
// seen are the captain's own presses and run only from the page.
import { stringField } from "./files.js";
import { parseClock, parseDays } from "./schedule-time.js";
import * as schedules from "./schedules.js";
/** What a schedule operation knows besides the store. */
export function scheduleEnv(ctx) {
    const nowMs = Date.parse(ctx.now);
    return {
        topics: ctx.topics,
        nowMs,
        actor: { by: ctx.by, label: ctx.label },
        records: ctx.records,
        machineZone: ctx.zone,
    };
}
function usage(line) {
    return { ok: false, code: "usage", line };
}
function isRt(value) {
    return typeof value === "string" && schedules.RT_VALUES.includes(value);
}
function isProblem(value) {
    return typeof value === "object" && value !== null && "problem" in value;
}
/** The days a request names: --daily, or --weekly with weekdays; undefined when neither. */
function daysOf(args) {
    const weekly = args["weekly"];
    if (args["daily"] === true)
        return weekly === undefined ? "daily" : { problem: "--daily 和 --weekly 只能選一個" };
    if (weekly === undefined)
        return undefined;
    const days = typeof weekly === "string" ? parseDays(weekly) : null;
    return days === null ? { problem: "--weekly 要是星期的縮寫，用逗號分開，例如 mon,thu" } : days;
}
/** The time of day a request names with --at; undefined when it names none. */
function clockOf(args) {
    const at = args["at"];
    if (at === undefined)
        return undefined;
    const clock = typeof at === "string" ? parseClock(at) : null;
    return clock === null ? { problem: "--at 要是 HH:MM，例如 06:00" } : clock;
}
/** A whole number of minutes given as a flag's text (the command line) or a number (the page). */
function minutes(raw, flag) {
    if (raw === undefined)
        return undefined;
    const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
    return typeof value === "number" && Number.isInteger(value)
        ? value
        : { problem: `${flag} 要是整數（分鐘）` };
}
/** The parts of `schedule add` and `schedule edit` that may be left out, or why one is malformed. */
function options(args) {
    const days = daysOf(args);
    const at = clockOf(args);
    const duration = minutes(args["duration"], "--duration");
    const lead = minutes(args["lead"], "--lead");
    const zone = args["tz"];
    const rt = args["rt"];
    for (const part of [days, at, duration, lead])
        if (isProblem(part))
            return part;
    if (zone !== undefined && typeof zone !== "string")
        return { problem: "--tz 要是時區名稱" };
    if (rt !== undefined && !isRt(rt))
        return { problem: "--rt 只能是 soft-rt、hard-rt、none" };
    const given = { days, at, duration, lead, tz: zone, rt };
    return Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined));
}
/** What `schedule add` or `schedule edit` asks for, or why it is malformed. */
function scheduleInput(args) {
    const topic = stringField(args, "topic");
    if (topic === null)
        return "需要議題 id";
    const parts = options(args);
    return isProblem(parts) ? parts.problem : { topic, ...parts };
}
/** An operation on the schedule of the topic named by `topic`. */
function onTopic(apply) {
    return (ctx, args) => {
        const topic = stringField(args, "topic");
        return topic === null ? usage("需要議題 id。") : apply(ctx, scheduleEnv(ctx), topic);
    };
}
/** An operation on the occurrence named by `key`, with an optional one-line note. */
function onOccurrence(apply) {
    return (ctx, args) => {
        const key = stringField(args, "key");
        const note = args["note"];
        if (key === null)
            return usage("需要那一場的鍵，例如 weekly-sync:20261130T0200Z。");
        if (note !== undefined && typeof note !== "string")
            return usage("--note 要是一行文字。");
        return apply(ctx, scheduleEnv(ctx), key, note);
    };
}
function isOutcome(value) {
    return (typeof value === "string" && schedules.CLOSE_OUTCOMES.includes(value));
}
/** Every schedule operation, for the operation table. */
export const scheduleOperations = {
    "schedule-add": {
        channel: "both",
        commitFile: "schedules",
        run: (ctx, args) => {
            const input = scheduleInput(args);
            return typeof input === "string"
                ? usage(input)
                : schedules.addSchedule(ctx.schedules, scheduleEnv(ctx), input);
        },
    },
    "schedule-edit": {
        channel: "both",
        commitFile: "schedules",
        run: (ctx, args) => {
            const input = scheduleInput(args);
            return typeof input === "string"
                ? usage(input)
                : schedules.editSchedule(ctx.schedules, scheduleEnv(ctx), input);
        },
    },
    "schedule-pause": {
        channel: "both",
        commitFile: "schedules",
        run: onTopic((ctx, env, topic) => schedules.setPaused(ctx.schedules, env, topic, true)),
    },
    "schedule-resume": {
        channel: "both",
        commitFile: "schedules",
        run: onTopic((ctx, env, topic) => schedules.setPaused(ctx.schedules, env, topic, false)),
    },
    "schedule-skip": {
        channel: "both",
        commitFile: "schedules",
        run: onTopic((ctx, env, topic) => schedules.skipNext(ctx.schedules, env, topic)),
    },
    "schedule-rt": {
        channel: "both",
        commitFile: "schedules",
        run: (ctx, args) => {
            const rt = args["rt"];
            if (!isRt(rt))
                return usage("rt 只能是 soft-rt、hard-rt、none。");
            return onTopic((inner, env, topic) => schedules.setRt(inner.schedules, env, topic, rt))(ctx, args);
        },
    },
    "schedule-delete": {
        channel: "both",
        commitFile: "schedules",
        run: onTopic((ctx, env, topic) => schedules.deleteSchedule(ctx.schedules, env, topic)),
    },
    "schedule-take": {
        channel: "socket",
        commitFile: "schedules",
        run: onOccurrence((ctx, env, key, note) => schedules.takeOccurrence(ctx.schedules, env, key, note)),
    },
    "schedule-close": {
        channel: "both",
        commitFile: "schedules",
        run: (ctx, args) => {
            const outcome = args["outcome"];
            if (!isOutcome(outcome))
                return usage("結束要寫 done 或 skipped。");
            return onOccurrence((inner, env, key, note) => schedules.closeOccurrence(inner.schedules, env, key, outcome, note))(ctx, args);
        },
    },
    "schedule-settings": {
        channel: "page",
        commitFile: "schedules",
        run: (ctx, args) => schedules.updateSettings(ctx.schedules, scheduleEnv(ctx), args),
    },
    "schedule-lock": {
        channel: "page",
        commitFile: "schedules",
        run: (ctx, args) => {
            const which = args["lock"];
            const locked = args["locked"];
            if ((which !== "schedule" && which !== "rt") || typeof locked !== "boolean")
                return usage("schedule-lock 需要 lock（schedule 或 rt）與 locked（true 或 false）。");
            return onTopic((inner, env, topic) => schedules.setLock(inner.schedules, env, topic, which, locked))(ctx, args);
        },
    },
    "schedule-pause-all": {
        channel: "page",
        commitFile: "schedules",
        run: (ctx, args) => {
            const paused = args["paused"];
            if (typeof paused !== "boolean")
                return usage("schedule-pause-all 需要 paused（true 或 false）。");
            return schedules.setAllPaused(ctx.schedules, scheduleEnv(ctx), paused);
        },
    },
    "schedule-revert": {
        channel: "page",
        commitFile: "schedules",
        run: (ctx, args) => {
            const rid = stringField(args, "rid");
            if (rid === null)
                return usage("schedule-revert 需要紀錄的 rid。");
            return schedules.revertChange(ctx.schedules, scheduleEnv(ctx), rid);
        },
    },
    "schedule-seen": {
        channel: "page",
        commitFile: "schedules",
        run: (ctx) => schedules.markSeen(ctx.schedules, scheduleEnv(ctx)),
    },
};
