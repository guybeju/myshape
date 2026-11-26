// The time maths of schedules: a daily or weekly HH:MM rule in an IANA time
// zone, the UTC instants it falls on, and the keys and labels of those
// instants. Pure apart from Node's built-in Intl time zone data.
//
// Daylight saving: a local time that happens twice counts its first instance;
// a local time that does not happen moves forward by the length of the gap
// (02:30 in a 02:00 to 03:00 jump is 03:30). Each local date has at most one
// occurrence, so a rule falls at most once a day.
export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEKDAY_LABEL = {
    sun: "日",
    mon: "一",
    tue: "二",
    wed: "三",
    thu: "四",
    fri: "五",
    sat: "六",
};
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/**
 * The most a day can be shorter than 24 hours. Antarctica/Troll moves its
 * clock two hours at once; every other zone in use moves one hour or less.
 */
const LARGEST_SHIFT_MIN = 120;
// Longer than a week plus a skipped day, so every weekly rule is found.
const SEARCH_DAYS = 10;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
function isWeekday(value) {
    return WEEKDAYS.includes(value);
}
/** The hour and minute of "HH:MM", or null when it is not a time of day. */
export function parseClock(text) {
    const match = CLOCK.exec(text);
    if (match === null)
        return null;
    return { hour: Number(match[1]), minute: Number(match[2]) };
}
/** The weekdays of "mon,thu", in week order, or null when one is not a weekday or none is given. */
export function parseDays(text) {
    const names = text.split(",").map((name) => name.trim().toLowerCase());
    if (names.length === 0 || !names.every(isWeekday))
        return null;
    const days = WEEKDAYS.filter((day) => names.includes(day));
    return days.length === 0 ? null : days;
}
/** The rule a stored text such as "daily 06:00" or "weekly mon,thu 10:00" says, or null. */
export function parseRule(text) {
    const parts = text.split(" ");
    if (parts[0] === "daily" && parts.length === 2) {
        const clock = parseClock(parts[1]);
        return clock === null ? null : { kind: "daily", ...clock };
    }
    if (parts[0] === "weekly" && parts.length === 3) {
        const days = parseDays(parts[1]);
        const clock = parseClock(parts[2]);
        if (days === null || clock === null || days.join(",") !== parts[1])
            return null;
        return { kind: "weekly", days, ...clock };
    }
    return null;
}
function pad(value) {
    return String(value).padStart(2, "0");
}
function clockText(rule) {
    return `${pad(rule.hour)}:${pad(rule.minute)}`;
}
/** The rule as it is stored: "daily 06:00" or "weekly mon,thu 10:00". */
export function formatRule(rule) {
    if (rule.kind === "daily")
        return `daily ${clockText(rule)}`;
    return `weekly ${rule.days.join(",")} ${clockText(rule)}`;
}
/** The rule in words, for the page and the replies: 每天 06:00 or 每週一、四 10:00. */
export function describeRule(rule) {
    if (rule.kind === "daily")
        return `每天 ${clockText(rule)}`;
    return `每週${rule.days.map((day) => WEEKDAY_LABEL[day]).join("、")} ${clockText(rule)}`;
}
const formatters = new Map();
function formatter(zone) {
    let found = formatters.get(zone);
    if (found === undefined) {
        found = new Intl.DateTimeFormat("en-US", {
            timeZone: zone,
            hourCycle: "h23",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
        formatters.set(zone, found);
    }
    return found;
}
/** Whether Node knows `zone` as an IANA time zone. */
export function isTimeZone(zone) {
    if (zone === "" || zone.length > 64)
        return false;
    try {
        formatter(zone);
        return true;
    }
    catch {
        return false;
    }
}
/** This machine's time zone. */
export function machineTimeZone() {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}
/** The wall clock in `zone` at the instant `ms`, written as if it were a UTC instant. */
export function wallClock(zone, ms) {
    const parts = {};
    for (const part of formatter(zone).formatToParts(ms)) {
        if (part.type !== "literal")
            parts[part.type] = Number(part.value);
    }
    const { year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0 } = parts;
    return Date.UTC(year, month - 1, day, hour, minute, second);
}
function offsetAt(zone, ms) {
    return wallClock(zone, ms) - Math.floor(ms / 1000) * 1000;
}
/**
 * The UTC instant of a local date and time in `zone`. A repeated local time
 * gives its first instance, a skipped one moves forward by the gap.
 */
export function zonedInstant(zone, local) {
    const before = offsetAt(zone, local - DAY_MS);
    const after = offsetAt(zone, local + DAY_MS);
    const valid = [local - before, local - after]
        .filter((candidate) => wallClock(zone, candidate) === local)
        .toSorted((a, b) => a - b);
    return valid[0] ?? local - before;
}
function fallsOn(rule, weekday) {
    return rule.kind === "daily" || rule.days.includes(WEEKDAYS[weekday]);
}
/** The first instant of `rule` in `zone` strictly after `afterMs`. */
export function occurrenceAfter(rule, zone, afterMs) {
    const today = wallClock(zone, afterMs);
    const start = new Date(today - DAY_MS);
    for (let step = 0; step <= SEARCH_DAYS; step += 1) {
        const date = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + step, rule.hour, rule.minute);
        if (!fallsOn(rule, new Date(date).getUTCDay()))
            continue;
        const instant = zonedInstant(zone, date);
        if (instant > afterMs)
            return instant;
    }
    throw new Error(`no occurrence of ${formatRule(rule)} in ${zone} after ${afterMs}`);
}
/** Every instant of `rule` in `zone` in (fromMs, toMs], oldest first. */
export function occurrencesBetween(rule, zone, fromMs, toMs) {
    const found = [];
    for (let at = occurrenceAfter(rule, zone, fromMs); at <= toMs;) {
        found.push(at);
        at = occurrenceAfter(rule, zone, at);
    }
    return found;
}
/** Whether `ms` is an instant of `rule` in `zone`. */
export function isOccurrence(rule, zone, ms) {
    return occurrenceAfter(rule, zone, ms - 1) === ms;
}
/**
 * The least time, in minutes, between two instants of `rule` in any zone: the
 * shortest run of days between two of its weekdays, less the largest clock
 * shift a day can have.
 */
export function minGapMinutes(rule) {
    const indexes = rule.kind === "daily" ? [0, 1, 2, 3, 4, 5, 6] : rule.days.map(dayIndex);
    let days = 7;
    for (const [position, index] of indexes.entries()) {
        const next = indexes[(position + 1) % indexes.length];
        const gap = (next - index + 7) % 7;
        days = Math.min(days, gap === 0 ? 7 : gap);
    }
    return days * 24 * 60 - LARGEST_SHIFT_MIN;
}
function dayIndex(day) {
    return WEEKDAYS.indexOf(day);
}
function compactUtc(ms) {
    const date = new Date(ms);
    return (`${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
        `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}Z`);
}
/** An occurrence's key: the schedule id and the UTC time, e.g. weekly-sync:20261130T0200Z. */
export function occurrenceKey(series, ms) {
    return `${series}:${compactUtc(ms)}`;
}
const KEY = /^(.+):(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/;
/** The schedule id and instant of an occurrence key, or null when it is not one. */
export function parseOccurrenceKey(key) {
    const match = KEY.exec(key);
    if (match === null)
        return null;
    const [, series, year, month, day, hour, minute] = match.map(String);
    const at = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
    return occurrenceKey(series, at) === key ? { series: series, at } : null;
}
/** An instant as the page shows it, in the schedule's zone: 11-30（一）10:00. */
export function localLabel(zone, ms) {
    const wall = new Date(wallClock(zone, ms));
    const weekday = WEEKDAYS[wall.getUTCDay()];
    return (`${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}（${WEEKDAY_LABEL[weekday]}）` +
        `${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`);
}
/** An ISO instant without milliseconds, the way the board's files store times. */
export function isoSeconds(ms) {
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
