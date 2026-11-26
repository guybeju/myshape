// Schedules (data/myshape/schedules.json): a daily or weekly rule attached to
// one open topic, the occurrences the board's clock opens (PR 2), the last
// ten that ended, the settings the captain tunes, and deleted schedules kept
// for thirty days. Pure: each operation takes the store and returns the next
// one with its records; store.ts commitChange saves them.
//
// The locks, the hourly cap and the first-ring rule are guard rails against a
// careless or misled aggregator, not a boundary against a deliberate program
// under the same account: the socket does not verify who is calling.
import * as oversight from "./oversight.js";
import { isRecord, stringField } from "./files.js";
import { describeRule, formatRule, isOccurrence, isTimeZone, isoSeconds, localLabel, minGapMinutes, occurrenceAfter, occurrenceKey, parseOccurrenceKey, parseRule, } from "./schedule-time.js";
import { GOAL_MAX, QUEUE_LABEL, isValidTopicId, oneLine, resolveTopicId } from "./topics.js";
export const RT_VALUES = ["none", "soft-rt", "hard-rt"];
export const SERIES_STATES = ["on", "paused"];
export const OCCURRENCE_STATES = ["upcoming", "due", "taken"];
export const MISSED_MODES = ["notice", "due", "record"];
export const CLOSE_OUTCOMES = ["done", "skipped"];
export const DEFAULT_SETTINGS = {
    lead_min: 15,
    duration_min: 60,
    max_open_min: 180,
    missed: "notice",
    late_after_min: 5,
    aggregator_may_create: true,
    aggregator_needs_enable: false,
    first_bell_min_ahead: 60,
    captain_locks_by_default: true,
    max_active: 20,
    aggregator_changes_per_hour: 10,
    aggregator_may_set_rt: true,
    default_rt: "none",
    default_tz: null,
    all_paused: false,
};
/** The whole-minute ranges of the settings (design section 5.1). */
export const RANGES = {
    lead_min: [0, 120],
    duration_min: [5, 480],
    max_open_min: [15, 1440],
    late_after_min: [1, 60],
    first_bell_min_ahead: [0, 1440],
    max_active: [1, 100],
    aggregator_changes_per_hour: [1, 100],
};
const BOOLEAN_SETTINGS = [
    "aggregator_may_create",
    "aggregator_needs_enable",
    "captain_locks_by_default",
    "aggregator_may_set_rt",
];
const RECENT_KEEP = 10;
const NOTE_MAX = GOAL_MAX;
const MINUTE_MS = 60_000;
/** How long a deleted schedule is kept so it can be undone. */
export const REVERT_DAYS = 30;
const REVERT_MS = REVERT_DAYS * 24 * 60 * MINUTE_MS;
/**
 * The schedule records the guard rails watch (oversight.ts): the aggregator's
 * changes, which its hourly cap counts and the captain may take back, the
 * captain's revert of one, and the captain's mark that every change so far
 * was seen.
 */
export const WATCHED = {
    changes: new Set([
        "schedule.created",
        "schedule.edited",
        "schedule.paused",
        "schedule.resumed",
        "schedule.skipped",
        "schedule.rt_changed",
        "schedule.deleted",
    ]),
    reverted: "schedule.reverted",
    seen: "schedule.seen",
};
/** Whether the aggregator made `series` and the captain has not marked it seen (shown as 新). */
export function isNew(series) {
    return series.by === "aggregator" && series.seen !== true;
}
const RT_WORDS = {
    none: "",
    "soft-rt": "（soft-rt）",
    "hard-rt": "（hard-rt）",
};
export function emptySchedules() {
    return {
        v: 1,
        settings: { ...DEFAULT_SETTINGS },
        series: {},
        occurrences: {},
        recent: {},
        removed: {},
    };
}
// ---------------------------------------------------------------- reading
function isRt(value) {
    return typeof value === "string" && RT_VALUES.includes(value);
}
function inRange(value, [low, high]) {
    return typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;
}
function oneOf(list, value, fallback) {
    return list.find((entry) => entry === value) ?? fallback;
}
/** The stored settings; a missing or out-of-range value reads as its default. */
function parseSettings(raw) {
    const given = isRecord(raw) ? raw : {};
    const settings = { ...DEFAULT_SETTINGS };
    for (const [name, range] of Object.entries(RANGES)) {
        if (inRange(given[name], range))
            settings[name] = given[name];
    }
    for (const name of [...BOOLEAN_SETTINGS, "all_paused"]) {
        if (typeof given[name] === "boolean")
            settings[name] = given[name];
    }
    settings.missed = oneOf(MISSED_MODES, given["missed"], DEFAULT_SETTINGS.missed);
    settings.default_rt = isRt(given["default_rt"])
        ? given["default_rt"]
        : DEFAULT_SETTINGS.default_rt;
    const zone = given["default_tz"];
    settings.default_tz = typeof zone === "string" && isTimeZone(zone) ? zone : null;
    return settings;
}
function optionalMinutes(raw, range) {
    if (raw === null || raw === undefined)
        return null;
    return inRange(raw, range) ? raw : undefined;
}
function stringMap(raw) {
    if (!isRecord(raw))
        return undefined;
    const map = {};
    for (const [name, value] of Object.entries(raw))
        if (typeof value === "string")
            map[name] = value;
    return map;
}
/** The string fields `names` of `raw`, or null when one is missing or not a string. */
function required(raw, names) {
    const found = {};
    for (const name of names) {
        const value = stringField(raw, name);
        if (value === null)
            return null;
        found[name] = value;
    }
    return found;
}
/** The string fields `names` of `raw` that are there; the clock writes some of them (PR 2). */
function present(raw, names) {
    const found = {};
    for (const name of names) {
        const value = stringField(raw, name);
        if (value !== null)
            found[name] = value;
    }
    return found;
}
/** The notice ids an occurrence or entry carries, when it carries any. */
function noticesOf(raw) {
    const notices = stringMap(raw["notices"]);
    return notices === undefined ? {} : { notices };
}
/** The minutes a stored schedule leaves to the settings (null) or sets, or null when out of range. */
function storedMinutes(raw) {
    const duration = optionalMinutes(raw["duration_min"], RANGES.duration_min);
    const lead = optionalMinutes(raw["lead_min"], RANGES.lead_min);
    return duration === undefined || lead === undefined
        ? null
        : { duration_min: duration, lead_min: lead };
}
/** One stored schedule, or null when it lacks what the board needs to run it. */
function parseSeries(raw) {
    if (!isRecord(raw))
        return null;
    const text = required(raw, ["topic", "title", "rule", "tz", "created_at"]);
    const minutes = storedMinutes(raw);
    if (text === null || minutes === null)
        return null;
    if (parseRule(text.rule) === null || !isTimeZone(text.tz))
        return null;
    const by = raw["by"] === "aggregator" ? "aggregator" : "captain";
    return {
        topic: text.topic,
        title: text.title,
        rule: text.rule,
        tz: text.tz,
        ...minutes,
        rt: isRt(raw["rt"]) ? raw["rt"] : "none",
        rt_locked: raw["rt_locked"] === true,
        state: oneOf(SERIES_STATES, raw["state"], "paused"),
        locked: raw["locked"] === true,
        by,
        ...(by === "aggregator" ? { seen: raw["seen"] === true } : {}),
        created_at: text.created_at,
        ...present(raw, ["checked_through"]),
    };
}
function parseOccurrence(raw) {
    if (!isRecord(raw))
        return null;
    const text = required(raw, ["series", "at", "opened_at", "closes_by"]);
    const state = OCCURRENCE_STATES.find((name) => name === raw["state"]);
    if (text === null || state === undefined)
        return null;
    return { ...text, state, ...present(raw, ["taken_at", "note"]), ...noticesOf(raw) };
}
function parseRecent(raw) {
    if (!isRecord(raw))
        return null;
    const text = required(raw, ["key", "outcome", "by"]);
    if (text === null)
        return null;
    const count = raw["count"];
    return {
        ...text,
        ...present(raw, ["note", "closed_at", "notice", "from", "to"]),
        ...noticesOf(raw),
        ...(typeof count === "number" && Number.isInteger(count) ? { count } : {}),
    };
}
function parseEntries(raw, parse, validId) {
    const entries = {};
    if (!isRecord(raw))
        return entries;
    for (const [id, value] of Object.entries(raw)) {
        const parsed = parse(value);
        if (parsed !== null && validId(id))
            entries[id] = parsed;
    }
    return entries;
}
/**
 * A usable schedule id: the topic-id grammar, at most 64 characters. The
 * clock's fixed notice ids (w-s-<id>-<UTC>-<phase>) and Firstmate's inbox
 * request ids (tb-<write id>, at most 128 of A-Za-z0-9._:-) depend on it.
 */
export function isValidScheduleId(id) {
    return isValidTopicId(id);
}
function isOccurrenceKeyOf(key) {
    const parsed = parseOccurrenceKey(key);
    return parsed !== null && isValidScheduleId(parsed.series);
}
function parseRemoved(raw) {
    const series = parseSeries(raw);
    if (series === null || !isRecord(raw))
        return null;
    const removedAt = stringField(raw, "removed_at");
    const removedBy = stringField(raw, "removed_by");
    if (removedAt === null || removedBy === null)
        return null;
    return { ...series, removed_at: removedAt, removed_by: removedBy };
}
/**
 * Reads data/myshape/schedules.json. Entries that are not whole are skipped,
 * settings out of range read as their defaults, and fields the clock writes
 * (checked_through, notices, missed counts) are kept as they are.
 */
export function parseSchedules(raw) {
    if (!isRecord(raw) || raw["v"] !== 1)
        throw new Error("expected an object with v: 1");
    const recent = {};
    if (isRecord(raw["recent"])) {
        for (const [id, list] of Object.entries(raw["recent"])) {
            if (!Array.isArray(list) || !isValidScheduleId(id))
                continue;
            recent[id] = list.flatMap((entry) => {
                const parsed = parseRecent(entry);
                return parsed === null ? [] : [parsed];
            });
        }
    }
    return {
        v: 1,
        settings: parseSettings(raw["settings"]),
        series: parseEntries(raw["series"], parseSeries, isValidScheduleId),
        occurrences: parseEntries(raw["occurrences"], parseOccurrence, isOccurrenceKeyOf),
        recent,
        removed: parseEntries(raw["removed"], parseRemoved, isValidScheduleId),
    };
}
// ---------------------------------------------------------------- reading the model
/** The rule of a stored schedule; parseSchedules only keeps schedules whose rule reads. */
export function ruleOf(series) {
    const rule = parseRule(series.rule);
    if (rule === null)
        throw new Error(`排程的規則讀不懂：${series.rule}`);
    return rule;
}
/** The lead, duration and longest open time that apply to `series`. */
export function effective(series, settings) {
    return {
        lead: series.lead_min ?? settings.lead_min,
        duration: series.duration_min ?? settings.duration_min,
        maxOpen: settings.max_open_min,
    };
}
/** The schedule on `topic` (merges followed on both sides), with its id. */
export function scheduleOfTopic(store, topics, topic) {
    const wanted = resolveTopicId(topics.doc, topic);
    for (const [id, series] of Object.entries(store.series)) {
        if (resolveTopicId(topics.doc, series.topic) === wanted)
            return { id, series };
    }
    return null;
}
/** The occurrence of `id` that is in the file, open or past its closes_by, with its key. */
function openOf(store, id) {
    for (const [key, occurrence] of Object.entries(store.occurrences)) {
        if (occurrence.series === id)
            return { key, occurrence };
    }
    return null;
}
/** Whether an occurrence has ended: every reader treats one past its closes_by as ended. */
export function hasEnded(occurrence, nowMs) {
    return Date.parse(occurrence.closes_by) <= nowMs;
}
/** The instant an occurrence key names; keys that do not parse sort first. */
export function instantOf(key) {
    return parseOccurrenceKey(key)?.at ?? Number.NEGATIVE_INFINITY;
}
/**
 * The next occurrence of schedule `id` that has neither been handled nor is
 * open: after `nowMs`, after every occurrence already handled or open (so a
 * clock that went back never offers one again), and opening no earlier than
 * an open occurrence's closes_by (a rule change applies after it).
 */
export function nextOccurrence(store, id, nowMs) {
    const series = store.series[id] ?? store.removed[id];
    if (series === undefined)
        throw new Error(`沒有排程 ${id}`);
    const rule = ruleOf(series);
    const { lead } = effective(series, store.settings);
    const open = openOf(store, id);
    const handled = (store.recent[id] ?? []).map((entry) => instantOf(entry.key));
    if (open !== null)
        handled.push(Date.parse(open.occurrence.at));
    let at = occurrenceAfter(rule, series.tz, Math.max(nowMs, ...handled));
    const opensAfter = open === null ? Number.NEGATIVE_INFINITY : Date.parse(open.occurrence.closes_by);
    while (at - lead * MINUTE_MS < opensAfter)
        at = occurrenceAfter(rule, series.tz, at);
    return at;
}
/**
 * Why `rule` with these minutes could have two occurrences open at once, or
 * null: an occurrence opens `lead` minutes before its time and stays open at
 * most the longer of `duration` and `maxOpen`, and the next one must not open
 * before that.
 */
export function overlapProblem(rule, minutes) {
    const longest = Math.max(minutes.duration, minutes.maxOpen);
    const gap = minGapMinutes(rule);
    if (minutes.lead + longest <= gap)
        return null;
    return (`這樣設的話，${describeRule(rule)} 會同時開著兩場：提前 ${minutes.lead} 分加上最長開 ${longest} 分，` +
        `不能超過兩場之間最短的 ${gap} 分`);
}
/** How many schedules are switched on. */
export function activeCount(store) {
    return Object.values(store.series).filter((series) => series.state === "on").length;
}
// ---------------------------------------------------------------- results
function refused(line) {
    return { ok: false, code: "refused", line };
}
function usage(line) {
    return { ok: false, code: "usage", line };
}
function unchanged(store, line) {
    return { ok: true, changed: false, store, line };
}
function changed(store, line, records, closed) {
    return {
        ok: true,
        changed: true,
        store,
        line,
        records,
        ...(closed === undefined ? {} : { closed }),
    };
}
function clone(store) {
    return structuredClone(store);
}
function suffix(env) {
    return env.actor.by === "captain" ? "（你在頁面上）" : `（${env.actor.label} 用指令）`;
}
/** A skip made before its occurrence came: what skip-next and the first-ring rule leave. */
function isAdvanceSkip(entry) {
    return (entry.outcome === "skipped" &&
        entry.closed_at !== undefined &&
        Date.parse(entry.closed_at) < instantOf(entry.key));
}
function snapshot(store, id) {
    const series = store.series[id] ?? null;
    const skips = (store.recent[id] ?? []).filter(isAdvanceSkip);
    const shown = { id, series: series === null ? null : comparable(series), skips };
    return JSON.stringify(shown);
}
/**
 * A schedule without what the clock and the captain's look change behind a
 * change's back, its fields always in the same order so two can be compared
 * as text.
 */
function comparable(series) {
    return {
        topic: series.topic,
        title: series.title,
        rule: series.rule,
        tz: series.tz,
        duration_min: series.duration_min,
        lead_min: series.lead_min,
        rt: series.rt,
        rt_locked: series.rt_locked,
        state: series.state,
        locked: series.locked,
        by: series.by,
        created_at: series.created_at,
    };
}
/** One record about schedule `id`, with the schedule on each side of the change. */
function record(kind, before, after, id, text, topic) {
    return {
        kind,
        topic,
        before: snapshot(before, id),
        after: snapshot(after, id),
        text,
    };
}
/**
 * Starts the clock's count for `series` at `nowMs`, never earlier than it
 * was: a change that switches a schedule back on or moves when it rings
 * leaves nothing before it for the clock to open or report missed.
 */
export function restartCount(series, nowMs) {
    if (Date.parse(series.checked_through ?? "") > nowMs)
        return;
    series.checked_through = isoSeconds(nowMs);
}
/** Adds an entry to a schedule's last ten. */
export function pushRecent(store, id, entry) {
    store.recent[id] = [...(store.recent[id] ?? []), entry].slice(-RECENT_KEEP);
}
/** The topic id a schedule shows under now. */
function topicOf(env, series) {
    return resolveTopicId(env.topics.doc, series.topic);
}
/** A time as the replies print it: 11-30（一）10:00 in the schedule's zone. */
function when(series, ms) {
    return localLabel(series.tz, ms);
}
/** Why the aggregator may not make this change to `series`, or null. The captain always may. */
function gateProblem(store, env, series, needs) {
    if (env.actor.by === "captain")
        return null;
    if (series.locked)
        return `排程「${series.title}」上了鎖，${env.actor.label} 不能改；請 captain 在頁面上改或解鎖`;
    if (needs.own === true && series.by !== "aggregator")
        return `排程「${series.title}」是 captain 建的，${env.actor.label} 只能刪自己建的排程`;
    if (needs.rt === true) {
        if (series.rt_locked)
            return `排程「${series.title}」的 rt 上了鎖；請 captain 在頁面上改或解鎖`;
        if (!store.settings.aggregator_may_set_rt)
            return `captain 關掉了 ${env.actor.label} 設 rt；請 captain 在頁面上設`;
    }
    return null;
}
/** The hourly cap, checked once a change is known to change something. */
function capProblem(store, env) {
    if (env.actor.by === "captain")
        return null;
    const cap = store.settings.aggregator_changes_per_hour;
    return oversight.capProblem(env.records, WATCHED, Math.floor(env.nowMs / 1000), cap);
}
/** A change, unless the hourly cap refuses it. */
function capped(before, env, result) {
    if (!result.ok || !result.changed)
        return result;
    const problem = capProblem(before, env);
    return problem === null ? result : refused(problem);
}
// ---------------------------------------------------------------- the first-ring rule
/**
 * After the aggregator makes or retimes a schedule, the occurrences whose
 * first notice would ring within first_bell_min_ahead minutes are skipped in
 * advance (kept in `recent`), so a schedule cannot pull a topic to the top
 * sooner than that. The captain's changes are not held back.
 */
function holdBackFirstRing(store, id, env) {
    const series = store.series[id];
    const rule = ruleOf(series);
    const { lead, duration } = effective(series, store.settings);
    const earliestBell = env.nowMs + store.settings.first_bell_min_ahead * MINUTE_MS;
    let skipped = 0;
    for (let at = occurrenceAfter(rule, series.tz, env.nowMs - duration * MINUTE_MS);;) {
        // One whose bell has passed would open at once, so it rings now.
        if (Math.max(at - lead * MINUTE_MS, env.nowMs) >= earliestBell)
            break;
        const key = occurrenceKey(id, at);
        const handled = (store.recent[id] ?? []).some((entry) => entry.key === key);
        if (!handled && store.occurrences[key] === undefined) {
            pushRecent(store, id, {
                key,
                outcome: "skipped",
                by: "board",
                note: `${env.actor.label} 建立或改時間後 ${store.settings.first_bell_min_ahead} 分鐘內不響`,
                closed_at: isoSeconds(env.nowMs),
            });
            skipped += 1;
        }
        at = occurrenceAfter(rule, series.tz, at);
    }
    return skipped;
}
/** Drops advance skips that are not occurrences of the schedule's rule any more. */
function dropStaleSkips(store, id) {
    const series = store.series[id];
    const rule = ruleOf(series);
    const kept = (store.recent[id] ?? []).filter((entry) => !isAdvanceSkip(entry) || isOccurrence(rule, series.tz, instantOf(entry.key)));
    if (kept.length > 0)
        store.recent[id] = kept;
    else
        delete store.recent[id];
}
/** The reply's tail: the earliest occurrence, and how many the first-ring rule skipped. */
function earliestLine(store, id, env, held) {
    const series = store.series[id];
    const first = when(series, nextOccurrence(store, id, env.nowMs));
    if (held === 0)
        return `最快的一場是 ${first}`;
    return `${store.settings.first_bell_min_ahead} 分鐘內的 ${held} 場略過，最快的一場是 ${first}`;
}
/** The input's problem with the ranges, or null. */
function inputProblem(input) {
    if (input.tz !== undefined && !isTimeZone(input.tz))
        return `--tz 要是 IANA 時區名稱，例如 Asia/Taipei：${input.tz}`;
    if (input.duration !== undefined && !inRange(input.duration, RANGES.duration_min))
        return `--duration 要是 ${RANGES.duration_min[0]} 到 ${RANGES.duration_min[1]} 的整數（分鐘）`;
    if (input.lead !== undefined && !inRange(input.lead, RANGES.lead_min))
        return `--lead 要是 ${RANGES.lead_min[0]} 到 ${RANGES.lead_min[1]} 的整數（分鐘）；0 表示不送「快到了」`;
    return null;
}
function ruleFrom(input, current) {
    const days = input.days ??
        (current === null ? undefined : current.kind === "daily" ? "daily" : current.days);
    const at = input.at ?? (current === null ? undefined : { hour: current.hour, minute: current.minute });
    if (days === undefined || at === undefined)
        return null;
    return days === "daily" ? { kind: "daily", ...at } : { kind: "weekly", days: [...days], ...at };
}
/** A fresh schedule id for `topic`: the topic id, else with -2, -3; never one used in series or removed. */
function mintId(store, topic) {
    const free = (id) => store.series[id] === undefined && store.removed[id] === undefined && isValidScheduleId(id);
    if (free(topic))
        return topic;
    const base = topic.slice(0, 60);
    for (let n = 2;; n += 1) {
        if (free(`${base}-${n}`))
            return `${base}-${n}`;
    }
}
/** The live topic `raw` names and its queue, or why a schedule cannot go on it. */
function laterTopic(env, raw) {
    const id = resolveTopicId(env.topics.doc, raw);
    const topic = env.topics.doc.topics[id];
    if (topic === undefined)
        return env.topics.archive.topics[id] === undefined
            ? `沒有 ${raw} 這個議題。用 list --all 看有哪些。`
            : `議題 ${id} 已封存，要先 reopen。`;
    if (!env.topics.doc.queues.later.includes(id))
        return `議題 ${id} 不在「${QUEUE_LABEL.later}」：先把議題移到待辦（新議題可以用 create --queue later），排程議題平常存在待辦`;
    return { id, name: topic.name };
}
// ---------------------------------------------------------------- operations
/** Whether the aggregator may make one more schedule, or why not. */
function createProblem(store, env, input) {
    if (env.actor.by === "captain")
        return null;
    const { settings } = store;
    if (!settings.aggregator_may_create)
        return `captain 關掉了 ${env.actor.label} 建立排程；請 captain 在頁面上建立`;
    const active = activeCount(store);
    if (active >= settings.max_active)
        return `啟用中的排程已有 ${active} 筆（上限 ${settings.max_active}）；captain 在頁面上仍可建立，或調高上限`;
    if (input.rt !== undefined && !settings.aggregator_may_set_rt)
        return `captain 關掉了 ${env.actor.label} 設 rt；不帶 --rt 再建一次`;
    return null;
}
/** Whether `input` asks for what `series` already is. */
function sameSchedule(series, rule, input) {
    return (series.rule === formatRule(rule) &&
        series.tz === (input.tz ?? series.tz) &&
        (input.duration === undefined || series.duration_min === input.duration) &&
        (input.lead === undefined || series.lead_min === input.lead) &&
        (input.rt === undefined || series.rt === input.rt));
}
/**
 * Puts a schedule on a topic in 待辦. A topic has at most one schedule; the
 * same schedule again changes nothing. The captain's schedules are locked by
 * default, the aggregator's are not and wait to be seen (新).
 */
export function addSchedule(store, env, input) {
    const problem = inputProblem(input);
    if (problem !== null)
        return usage(problem);
    const rule = ruleFrom(input, null);
    if (rule === null)
        return usage("schedule add 需要 --daily 或 --weekly <星期>，與 --at HH:MM");
    const topic = placeFor(store, env, input, rule);
    if ("ok" in topic)
        return topic;
    const next = clone(store);
    const id = mintId(store, topic.id);
    next.series[id] = newSeries(store, env, input, rule, topic);
    const held = env.actor.by === "aggregator" ? holdBackFirstRing(next, id, env) : 0;
    const series = next.series[id];
    const what = `${describeRule(rule)}（${series.tz}）${RT_WORDS[series.rt]}`;
    const tail = earliestLine(next, id, env, held);
    const text = `議題「${topic.name}」加了排程：${what}，${tail}${suffix(env)}`;
    return capped(store, env, changed(next, `ok ${topic.id} 已排程：${what}，${tail}`, [
        record("schedule.created", store, next, id, text, topic.id),
    ]));
}
/**
 * The topic a new schedule goes on, or what to answer instead: a refusal, or
 * "already there" when the topic has this very schedule.
 */
function placeFor(store, env, input, rule) {
    const topic = laterTopic(env, input.topic);
    if (typeof topic === "string")
        return refused(topic);
    const existing = scheduleOfTopic(store, env.topics, topic.id);
    if (existing !== null) {
        if (sameSchedule(existing.series, rule, input))
            return unchanged(store, `ok ${topic.id} 本來就有這筆排程：${describeRule(rule)}`);
        return refused(`議題 ${topic.id} 已經有排程；一個議題最多一筆排程，要改用 schedule edit`);
    }
    const blocked = createProblem(store, env, input);
    if (blocked !== null)
        return refused(blocked);
    const minutes = effective({ lead_min: input.lead ?? null, duration_min: input.duration ?? null }, store.settings);
    const overlap = overlapProblem(rule, minutes);
    return overlap === null ? topic : refused(overlap);
}
/** A new schedule as the asker makes it: the captain's locked by default, the aggregator's new. */
function newSeries(store, env, input, rule, topic) {
    const byAggregator = env.actor.by === "aggregator";
    return {
        topic: topic.id,
        title: topic.name,
        rule: formatRule(rule),
        tz: input.tz ?? store.settings.default_tz ?? env.machineZone,
        duration_min: input.duration ?? null,
        lead_min: input.lead ?? null,
        rt: input.rt ?? store.settings.default_rt,
        rt_locked: false,
        state: "on",
        locked: byAggregator ? false : store.settings.captain_locks_by_default,
        by: env.actor.by,
        ...(byAggregator ? { seen: false } : {}),
        created_at: isoSeconds(env.nowMs),
    };
}
/** The schedule on `raw`, or a refusal. */
function scheduleOn(store, env, raw) {
    const schedule = scheduleOfTopic(store, env.topics, raw);
    if (schedule === null)
        return refused(`議題 ${raw} 沒有排程。`);
    return schedule;
}
/**
 * Changes a schedule's rule, time, zone, duration or lead. An open occurrence
 * is left alone and the new rule applies after it; skips made in advance that
 * the new rule no longer has are dropped. The aggregator's retime is held to
 * the first-ring rule.
 */
export function editSchedule(store, env, input) {
    const problem = inputProblem(input);
    if (problem !== null)
        return usage(problem);
    if (input.rt !== undefined)
        return usage("rt 用 schedule rt 改");
    const schedule = scheduleOn(store, env, input.topic);
    if ("ok" in schedule)
        return schedule;
    const { id, series } = schedule;
    const rule = ruleFrom(input, ruleOf(series));
    if (sameSchedule(series, rule, input))
        return unchanged(store, `ok ${topicOf(env, series)} 排程沒有變`);
    const gate = gateProblem(store, env, series, {});
    if (gate !== null)
        return refused(gate);
    const updated = edited(series, rule, input);
    const overlap = overlapProblem(rule, effective(updated, store.settings));
    if (overlap !== null)
        return refused(overlap);
    const next = clone(store);
    next.series[id] = updated;
    dropStaleSkips(next, id);
    const held = isRetime(series, updated) ? retimed(next, id, env) : 0;
    const what = `${describeRule(rule)}（${updated.tz}）`;
    const tail = earliestLine(next, id, env, held);
    const topic = topicOf(env, series);
    return capped(store, env, changed(next, `ok ${topic} 排程已改：${what}，${tail}`, [
        record("schedule.edited", store, next, id, `排程「${series.title}」改成 ${what}，${tail}${suffix(env)}`, topic),
    ]));
}
/** `series` with the parts `input` names changed. */
function edited(series, rule, input) {
    return {
        ...structuredClone(series),
        rule: formatRule(rule),
        tz: input.tz ?? series.tz,
        duration_min: input.duration ?? series.duration_min,
        lead_min: input.lead ?? series.lead_min,
    };
}
/**
 * After a retime the clock counts from now, and the aggregator's retime is
 * held to the first-ring rule; returns how many occurrences that skipped.
 */
function retimed(next, id, env) {
    restartCount(next.series[id], env.nowMs);
    return env.actor.by === "aggregator" ? holdBackFirstRing(next, id, env) : 0;
}
/** Whether an edit moves when the schedule rings: its rule, zone or lead. */
function isRetime(before, after) {
    return before.rule !== after.rule || before.tz !== after.tz || before.lead_min !== after.lead_min;
}
/** Pauses or resumes one schedule. An open occurrence stays open: it ends at its closes_by. */
export function setPaused(store, env, raw, paused) {
    const schedule = scheduleOn(store, env, raw);
    if ("ok" in schedule)
        return schedule;
    const { id, series } = schedule;
    const topic = topicOf(env, series);
    const state = paused ? "paused" : "on";
    const word = paused ? "暫停" : "恢復";
    if (series.state === state)
        return unchanged(store, `ok ${topic} 排程本來就${paused ? "暫停了" : "開著"}`);
    const blocked = pauseProblem(store, env, series, paused);
    if (blocked !== null)
        return refused(blocked);
    const next = clone(store);
    next.series[id].state = state;
    if (!paused)
        restartCount(next.series[id], env.nowMs);
    return capped(store, env, changed(next, `ok ${topic} 排程已${word}`, [
        record(paused ? "schedule.paused" : "schedule.resumed", store, next, id, `排程「${series.title}」已${word}${suffix(env)}`, topic),
    ]));
}
/** Why the aggregator may not pause or resume `series`, or null. */
function pauseProblem(store, env, series, paused) {
    const gate = gateProblem(store, env, series, {});
    if (gate !== null || paused)
        return gate;
    return resumeProblem(store, env, series);
}
/** Why the aggregator may not switch `series` on again, or null. */
function resumeProblem(store, env, series) {
    if (env.actor.by === "captain")
        return null;
    if (store.settings.aggregator_needs_enable && isNew(series))
        return `排程「${series.title}」要等 captain 在頁面上按啟用`;
    const active = activeCount(store);
    if (active >= store.settings.max_active)
        return `啟用中的排程已有 ${active} 筆（上限 ${store.settings.max_active}）；請 captain 在頁面上調`;
    return null;
}
/** A skip someone asked for (skip next), as opposed to one the first-ring rule made. */
function isAskedSkip(entry) {
    return isAdvanceSkip(entry) && entry.by !== "board";
}
/**
 * Skips the schedule's next occurrence: it will not open, and the one after
 * it is next. Asking again while that skip stands changes nothing.
 */
export function skipNext(store, env, raw) {
    const schedule = scheduleOn(store, env, raw);
    if ("ok" in schedule)
        return schedule;
    const { id, series } = schedule;
    const recent = store.recent[id] ?? [];
    const withoutAsked = {
        ...store,
        recent: { ...store.recent, [id]: recent.filter((entry) => !isAskedSkip(entry)) },
    };
    const at = nextOccurrence(withoutAsked, id, env.nowMs);
    const key = occurrenceKey(id, at);
    const topic = topicOf(env, series);
    if (recent.some((entry) => entry.key === key && isAskedSkip(entry)))
        return unchanged(store, `ok ${topic} 本來就已跳過 ${when(series, at)} 那一場`);
    const gate = gateProblem(store, env, series, {});
    if (gate !== null)
        return refused(gate);
    const next = clone(store);
    pushRecent(next, id, {
        key,
        outcome: "skipped",
        by: env.actor.by,
        closed_at: isoSeconds(env.nowMs),
    });
    const after = when(series, nextOccurrence(next, id, env.nowMs));
    const text = `排程「${series.title}」跳過 ${when(series, at)} 那一場，下一場是 ${after}`;
    return capped(store, env, changed(next, `ok ${topic} 跳過 ${when(series, at)} 那一場，下一場是 ${after}`, [
        record("schedule.skipped", store, next, id, `${text}${suffix(env)}`, topic),
    ]));
}
/** Sets the schedule's rt, which orders the 現在 strip and appears in its notices. */
export function setRt(store, env, raw, rt) {
    const schedule = scheduleOn(store, env, raw);
    if ("ok" in schedule)
        return schedule;
    const { id, series } = schedule;
    const topic = topicOf(env, series);
    if (series.rt === rt)
        return unchanged(store, `ok ${topic} rt 本來就是 ${rt}`);
    const gate = gateProblem(store, env, series, { rt: true });
    if (gate !== null)
        return refused(gate);
    const next = clone(store);
    next.series[id].rt = rt;
    return capped(store, env, changed(next, `ok ${topic} rt 改為 ${rt}`, [
        record("schedule.rt_changed", store, next, id, `排程「${series.title}」的 rt 從 ${series.rt} 改為 ${rt}${suffix(env)}`, topic),
    ]));
}
/** Ends the open occurrence of schedule `id` as skipped, for a reason; nothing when none is open. */
function closeOpen(next, id, env, why) {
    const open = openOf(next, id);
    if (open === null)
        return [];
    delete next.occurrences[open.key];
    pushRecent(next, id, endedEntry(open.key, open.occurrence, "skipped", why, env));
    return [
        {
            kind: "occurrence.closed",
            topic: null,
            outcome: "skipped",
            text: `排程的 ${open.key} 那一場結束：${why}${suffix(env)}`,
        },
    ];
}
/** Drops deleted schedules kept longer than thirty days; done whenever `removed` is written. */
function forgetOldRemoved(store, nowMs) {
    for (const [id, removed] of Object.entries(store.removed)) {
        if (Date.parse(removed.removed_at) < nowMs - REVERT_MS)
            delete store.removed[id];
    }
}
/**
 * Deletes a schedule; the topic becomes an ordinary topic in 待辦. The schedule
 * is kept for thirty days so the page can undo it. The aggregator may delete
 * only schedules it made and that are not locked.
 */
export function deleteSchedule(store, env, raw) {
    const schedule = scheduleOn(store, env, raw);
    if ("ok" in schedule) {
        const wanted = resolveTopicId(env.topics.doc, raw);
        const gone = Object.values(store.removed).some((entry) => resolveTopicId(env.topics.doc, entry.topic) === wanted);
        return gone ? unchanged(store, `ok ${wanted} 排程本來就已刪除`) : schedule;
    }
    const { id, series } = schedule;
    const gate = gateProblem(store, env, series, { own: true });
    if (gate !== null)
        return refused(gate);
    const next = clone(store);
    const topic = topicOf(env, series);
    const closed = closeOpen(next, id, env, "排程已刪除").map((draft) => ({ ...draft, topic }));
    delete next.series[id];
    forgetOldRemoved(next, env.nowMs);
    next.removed[id] = {
        ...structuredClone(series),
        removed_at: isoSeconds(env.nowMs),
        removed_by: env.actor.by,
    };
    const text = `排程「${series.title}」已刪除，議題留在「${QUEUE_LABEL.later}」；${REVERT_DAYS} 天內可以在頁面上撤回`;
    return capped(store, env, changed(next, `ok ${topic} 排程已刪除`, [
        record("schedule.deleted", store, next, id, `${text}${suffix(env)}`, topic),
        ...closed,
    ]));
}
/** How occurrence `key` ended, when it is no longer open and is among the last ten. */
function endedAs(store, key) {
    if (Object.hasOwn(store.occurrences, key))
        return null;
    const entry = Object.values(store.recent)
        .flat()
        .find((recent) => recent.key === key);
    return entry?.outcome ?? null;
}
/** The entry an occurrence leaves in the last ten when it ends; its notices go with it. */
function endedEntry(key, occurrence, outcome, note, env) {
    const savedNote = note ?? occurrence.note;
    return {
        key,
        outcome,
        by: env.actor.by,
        ...(savedNote === undefined ? {} : { note: savedNote }),
        closed_at: isoSeconds(env.nowMs),
        ...(occurrence.notices === undefined ? {} : { notices: { ...occurrence.notices } }),
    };
}
/** The open occurrence `key` names, or a refusal. */
function openOccurrence(store, key) {
    const occurrence = Object.hasOwn(store.occurrences, key) ? store.occurrences[key] : undefined;
    const series = occurrence === undefined ? undefined : store.series[occurrence.series];
    if (occurrence === undefined || series === undefined) {
        const outcome = endedAs(store, key);
        if (outcome !== null)
            return refused(`${key} 那一場已經結束（${outcome}）。`);
        return refused(`${key} 不是開著的一場。用 list 看開著的場次。`);
    }
    return { occurrence, series };
}
function noteOf(raw) {
    if (raw === undefined)
        return undefined;
    return oneLine(raw, NOTE_MAX);
}
/**
 * The aggregator's report that it took an open occurrence. Allowed on a
 * locked schedule: it is a report, not a change to the schedule. A taken
 * occurrence stays open until the aggregator closes it, at most until its
 * time plus the longest open time.
 */
export function takeOccurrence(store, env, key, rawNote) {
    const note = noteOf(rawNote);
    if (note === null)
        return usage(`--note 要是一行，最多 ${NOTE_MAX} 個字`);
    const open = openOccurrence(store, key);
    if ("ok" in open)
        return open;
    const { occurrence, series } = open;
    if (hasEnded(occurrence, env.nowMs))
        return refused(`${key} 那一場已在 ${occurrence.closes_by} 結束。`);
    const topic = topicOf(env, series);
    if (occurrence.state === "taken" && (note === undefined || occurrence.note === note))
        return unchanged(store, `ok ${key} 本來就已接下`);
    const next = clone(store);
    const taken = takenOccurrence(occurrence, effective(series, store.settings), note, env.nowMs);
    next.occurrences[key] = taken;
    const at = Date.parse(occurrence.at);
    const said = note === undefined ? "" : `：${note}`;
    const text = `排程「${series.title}」${when(series, at)} 那一場，${env.actor.label} 接了${said}`;
    const latest = when(series, Date.parse(taken.closes_by));
    return changed(next, `ok ${key} 已接下，最晚 ${latest} 結束`, [
        { kind: "occurrence.taken", topic, text: `${text}${suffix(env)}` },
    ]);
}
/** An occurrence once taken: it stays open up to its time plus the longer of the two limits. */
function takenOccurrence(occurrence, minutes, note, nowMs) {
    const at = Date.parse(occurrence.at);
    return {
        ...structuredClone(occurrence),
        state: "taken",
        taken_at: occurrence.taken_at ?? isoSeconds(nowMs),
        ...(note === undefined ? {} : { note }),
        closes_by: isoSeconds(at + Math.max(minutes.duration, minutes.maxOpen) * MINUTE_MS),
    };
}
/** Ends an open occurrence as done or skipped; the aggregator's report, or the captain's press. */
export function closeOccurrence(store, env, key, outcome, rawNote) {
    const note = noteOf(rawNote);
    if (note === null)
        return usage(`--note 要是一行，最多 ${NOTE_MAX} 個字`);
    if (endedAs(store, key) === outcome)
        return unchanged(store, `ok ${key} 本來就已結束（${outcome}）`);
    const open = openOccurrence(store, key);
    if ("ok" in open)
        return open;
    const { occurrence, series } = open;
    const next = clone(store);
    delete next.occurrences[key];
    pushRecent(next, occurrence.series, endedEntry(key, occurrence, outcome, note, env));
    const words = outcome === "done" ? "結束" : "跳過";
    const said = note === undefined ? "" : `：${note}`;
    const text = `排程「${series.title}」${when(series, Date.parse(occurrence.at))} 那一場${words}${said}`;
    return changed(next, `ok ${key} 已${words}`, [
        {
            kind: "occurrence.closed",
            topic: topicOf(env, series),
            outcome,
            text: `${text}${suffix(env)}`,
        },
    ], { key, occurrence, outcome });
}
// ---------------------------------------------------------------- the captain's page only
const SETTING_LABEL = {
    lead_min: "提前幾分鐘送第一則",
    duration_min: "時段長度",
    max_open_min: "接了之後最長開多久",
    missed: "錯過的場次",
    late_after_min: "晚多久才標「晚了」",
    aggregator_may_create: "aggregator 可以建立排程",
    aggregator_needs_enable: "aggregator 建的排程要 captain 先按啟用",
    first_bell_min_ahead: "aggregator 新建或改時間後，最快多久才響",
    captain_locks_by_default: "captain 建的排程預設上鎖",
    max_active: "啟用中的排程最多幾筆",
    aggregator_changes_per_hour: "aggregator 每小時最多改幾次排程",
    aggregator_may_set_rt: "aggregator 可以設 rt",
    default_rt: "新排程的 rt",
    default_tz: "新排程的時區",
};
function isSettingName(name) {
    return Object.hasOwn(SETTING_LABEL, name);
}
const isMinutes = (range) => (raw) => inRange(raw, range);
const isBoolean = (raw) => typeof raw === "boolean";
const isZoneOrNull = (raw) => raw === null || (typeof raw === "string" && isTimeZone(raw));
/** What each setting accepts, and how its refusal says so. */
const SETTING_CHECKS = {
    ...Object.fromEntries(Object.entries(RANGES).map(([name, range]) => [
        name,
        { check: isMinutes(range), wanted: `${range[0]} 到 ${range[1]} 的整數` },
    ])),
    ...Object.fromEntries(BOOLEAN_SETTINGS.map((name) => [name, { check: isBoolean, wanted: "true 或 false" }])),
    missed: {
        check: (raw) => MISSED_MODES.includes(raw),
        wanted: MISSED_MODES.join("、"),
    },
    default_rt: { check: isRt, wanted: RT_VALUES.join("、") },
    default_tz: { check: isZoneOrNull, wanted: "IANA 時區名稱，或 null（這台機器的時區）" },
};
/** The settings with `changes` applied, or why one of them is not allowed. */
function nextSettings(current, changes) {
    const settings = { ...current };
    for (const [name, raw] of Object.entries(changes)) {
        if (!isSettingName(name))
            return `不認得的設定：${name}`;
        const { check, wanted } = SETTING_CHECKS[name];
        if (!check(raw))
            return `${SETTING_LABEL[name]}要是 ${wanted}`;
        Object.assign(settings, { [name]: raw });
    }
    return settings;
}
/** Changes the captain's settings. Every schedule must still never have two occurrences open at once. */
export function updateSettings(store, env, changes) {
    const settings = nextSettings(store.settings, changes);
    if (typeof settings === "string")
        return usage(settings);
    const changedNames = Object.keys(SETTING_LABEL).filter((name) => settings[name] !== store.settings[name]);
    if (changedNames.length === 0)
        return unchanged(store, "ok 排程設定沒有變");
    for (const series of Object.values(store.series)) {
        const overlap = overlapProblem(ruleOf(series), effective(series, settings));
        if (overlap !== null)
            return refused(`排程「${series.title}」${overlap}`);
    }
    const next = clone(store);
    next.settings = settings;
    if (store.settings.aggregator_needs_enable && !settings.aggregator_needs_enable)
        for (const series of Object.values(next.series))
            if (isNew(series))
                restartCount(series, env.nowMs);
    const said = changedNames
        .map((name) => `${SETTING_LABEL[name]} ${String(store.settings[name])} → ${String(settings[name])}`)
        .join("；");
    return changed(next, "ok 排程設定已改", [
        {
            kind: "schedule.settings_changed",
            topic: null,
            before: JSON.stringify(store.settings),
            after: JSON.stringify(settings),
            text: `排程設定：${said}${suffix(env)}`,
        },
    ]);
}
/** Pauses every schedule at once, or lifts it; open occurrences stay open. */
export function setAllPaused(store, env, paused) {
    if (store.settings.all_paused === paused)
        return unchanged(store, `ok 排程本來就${paused ? "全部暫停了" : "沒有全部暫停"}`);
    const next = clone(store);
    next.settings.all_paused = paused;
    if (!paused)
        for (const series of Object.values(next.series))
            restartCount(series, env.nowMs);
    const text = paused ? "所有排程暫停：不開新時段、不送排程通知" : "所有排程恢復";
    return changed(next, `ok ${text}`, [
        { kind: "schedule.all_paused", topic: null, text: `${text}${suffix(env)}` },
    ]);
}
/** Locks or unlocks a schedule, or only its rt, against the aggregator's changes. */
export function setLock(store, env, raw, which, locked) {
    const schedule = scheduleOn(store, env, raw);
    if ("ok" in schedule)
        return schedule;
    const { id, series } = schedule;
    const field = which === "schedule" ? "locked" : "rt_locked";
    const what = which === "schedule" ? "排程" : "rt";
    const word = locked ? "上鎖" : "解鎖";
    const topic = topicOf(env, series);
    if (series[field] === locked)
        return unchanged(store, `ok ${topic} ${what}本來就已${word}`);
    const next = clone(store);
    next.series[id][field] = locked;
    return changed(next, `ok ${topic} ${what}已${word}`, [
        record("schedule.locked", store, next, id, `排程「${series.title}」的${what}已${word}${suffix(env)}`, topic),
    ]);
}
/**
 * The captain has seen the aggregator's schedule changes so far: the seen
 * mark (oversight.ts) that the 最近改了 list counts from, and every schedule
 * the aggregator made is no longer 新.
 */
export function markSeen(store, env) {
    const unseen = oversight.unseenChanges(env.records, WATCHED).length;
    const fresh = Object.keys(store.series).filter((id) => isNew(store.series[id]));
    if (unseen === 0 && fresh.length === 0)
        return unchanged(store, "ok 沒有還沒看過的排程改動");
    const next = clone(store);
    for (const id of fresh) {
        next.series[id].seen = true;
        restartCount(next.series[id], env.nowMs);
    }
    const text = `看過 ${env.actor.label} 最近的排程改動（${unseen} 筆，新的排程 ${fresh.length} 筆）`;
    return changed(next, `ok ${text}`, [
        { kind: "schedule.seen", topic: null, text: `${text}${suffix(env)}` },
    ]);
}
function readSnapshot(text) {
    try {
        const raw = JSON.parse(text);
        if (!isRecord(raw) || typeof raw["id"] !== "string" || !Array.isArray(raw["skips"]))
            return null;
        const series = raw["series"] === null ? null : parseSeries(raw["series"]);
        if (raw["series"] !== null && series === null)
            return null;
        const skips = raw["skips"].flatMap((entry) => {
            const parsed = parseRecent(entry);
            return parsed === null ? [] : [parsed];
        });
        return { id: raw["id"], series, skips };
    }
    catch {
        return null;
    }
}
/** Why a schedule cannot be put back on its topic now, or null. */
function restoreProblem(store, env, id, series) {
    const topic = laterTopic(env, series.topic);
    if (typeof topic === "string")
        return topic;
    const other = scheduleOfTopic(store, env.topics, topic.id);
    if (other !== null && other.id !== id)
        return `議題 ${topic.id} 現在有另一筆排程；先刪掉其中一筆排程`;
    return null;
}
/**
 * Takes back one of the aggregator's changes from its record (oversight.ts),
 * only while the schedule is still as that change left it; a deleted schedule
 * only while it is kept in `removed`. Taking it back again changes nothing.
 */
export function revertChange(store, env, rid) {
    const found = oversight.revertable(env.records, WATCHED, rid);
    if ("reverted" in found)
        return unchanged(store, `ok ${rid} 本來就已撤回`);
    if ("problem" in found)
        return refused(found.problem);
    const undo = undoOf(store, env, found.record, rid);
    if (typeof undo === "string")
        return refused(undo);
    const { before, after } = undo;
    const { id } = before;
    const next = clone(store);
    restoreSnapshot(next, before, store.series[id], env);
    const name = (before.series ?? after.series)?.title ?? id;
    const topic = before.series ?? after.series;
    const text = `排程「${name}」撤回了 ${env.actor.label} 的改動（${rid}）`;
    return changed(next, `ok 已撤回 ${rid}`, [
        {
            ...record("schedule.reverted", store, next, id, `${text}${suffix(env)}`, null),
            topic: topic === null ? null : resolveTopicId(env.topics.doc, topic.topic),
            ref: rid,
        },
    ]);
}
/**
 * The schedule on each side of the change `source` records, when it can be
 * taken back now: the schedule is still as the change left it, a deleted one
 * is still kept, and it can go back on its topic.
 */
function undoOf(store, env, source, rid) {
    const afterText = source.after ?? "";
    const before = readSnapshot(source.before ?? "");
    const after = readSnapshot(afterText);
    if (before === null || after === null)
        return `紀錄 ${rid} 的改前改後讀不懂，沒有撤回。`;
    const problem = changedSince(store, before, after, afterText);
    if (problem !== null)
        return problem;
    const restore = before.series === null ? null : restoreProblem(store, env, before.id, before.series);
    return restore ?? { before, after };
}
/** Why the schedule is no longer as the change left it, or null when it is. */
function changedSince(store, before, after, afterText) {
    if (after.id !== before.id || snapshot(store, before.id) !== afterText)
        return `排程 ${before.id} 在那之後又改過；先撤回較新的改動。`;
    if (after.series === null && store.removed[before.id] === undefined)
        return `排程 ${before.id} 刪掉已經超過 ${REVERT_DAYS} 天，不能撤回。`;
    return null;
}
/** Puts schedule `before.id` back as `before` says, with its advance skips. */
function restoreSnapshot(next, before, current, env) {
    const { id } = before;
    const others = (next.recent[id] ?? []).filter((entry) => !isAdvanceSkip(entry));
    const recent = [...others, ...before.skips.map((entry) => structuredClone(entry))];
    if (recent.length > 0)
        next.recent[id] = recent.slice(-RECENT_KEEP);
    else
        delete next.recent[id];
    forgetOldRemoved(next, env.nowMs);
    if (before.series === null) {
        delete next.series[id];
        if (current !== undefined)
            next.removed[id] = {
                ...structuredClone(current),
                removed_at: isoSeconds(env.nowMs),
                removed_by: env.actor.by,
            };
        return;
    }
    const kept = current === undefined || current.seen === undefined ? {} : { seen: current.seen };
    const restored = { ...structuredClone(before.series), ...kept };
    if (current?.checked_through !== undefined)
        restored.checked_through = current.checked_through;
    restartCount(restored, env.nowMs);
    next.series[id] = restored;
    delete next.removed[id];
}
// ---------------------------------------------------------------- the queue rules
/**
 * What archiving `topic` does to its schedule: pauses it and ends an open
 * occurrence, each with a record. Null when the topic has no schedule or it
 * is already paused with nothing open.
 */
export function pauseForArchive(store, env, topic) {
    const schedule = scheduleOfTopic(store, env.topics, topic);
    if (schedule === null)
        return null;
    const { id, series } = schedule;
    if (series.state === "paused" && openOf(store, id) === null)
        return null;
    const next = clone(store);
    const closed = closeOpen(next, id, env, "議題已封存");
    next.series[id].state = "paused";
    const paused = series.state === "paused"
        ? []
        : [
            record("schedule.paused", store, next, id, `議題封存，排程「${series.title}」已暫停${suffix(env)}`, topic),
        ];
    const records = [...paused, ...closed.map((draft) => ({ ...draft, topic }))];
    return { store: next, records: records };
}
