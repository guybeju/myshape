// The one place every lifecycle deadline and default lives (spec/lifecycle.markdown).
// The deadlines are the captain's settings, kept in data/myshape/lifecycle.json
// and changed only on the page; the values below are their defaults. Pure.
import { isRecord } from "./files.js";
/**
 * Every card state the aggregator owns, which has a reminder and an
 * escalation deadline: T2 a topic in 高 or 一般 with no open work; D5 a decision
 * waiting on work the board cannot see; D8 an answer delivered but not closed;
 * D9 a decision the board cannot read; Q1 queued and ready; Q4 queued under an
 * archived topic; Q5 queued and stopped with no date or visible wait; Q8
 * queued waiting on work the board cannot see; Q9 a queued item the board
 * cannot read; NT queued work or an agent with
 * no topic; A1 an agent working without any change; A2 parked or paused; A3 not
 * started; A4 blocked or failed; A5 done but not cleaned up; A6 an agent state
 * the board cannot read; W1 a worker question waiting for the aggregator; O3 a
 * hands-on item the captain says is done, waiting for the check; S3 a schedule
 * the aggregator paused; S6 a schedule nobody takes.
 */
export const TIMED_STATES = [
    "T2",
    "D5",
    "D8",
    "D9",
    "Q1",
    "Q4",
    "Q5",
    "Q8",
    "Q9",
    "NT",
    "A1",
    "A2",
    "A3",
    "A4",
    "A5",
    "A6",
    "W1",
    "O3",
    "S3",
    "S6",
];
const MINUTE = 1;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/**
 * Decision 2, option A (the captain's answer): most cards 1 day to the
 * reminder and 3 days to the captain; a worker not started 15 minutes and 2
 * hours; a stuck worker 1 hour and 1 day; ready to run, working without change
 * and a schedule the aggregator paused 3 and 7 days; what the board cannot
 * read at once and 1 day; a schedule nobody takes the 3rd and the 5th
 * occurrence in a row. Minutes, except S6, which counts occurrences.
 */
export const DEFAULT_DEADLINES = {
    T2: { remind: DAY, raise: 3 * DAY },
    D5: { remind: DAY, raise: 3 * DAY },
    D8: { remind: 0, raise: DAY },
    D9: { remind: 0, raise: DAY },
    Q1: { remind: 3 * DAY, raise: 7 * DAY },
    Q4: { remind: DAY, raise: 3 * DAY },
    Q5: { remind: DAY, raise: 3 * DAY },
    Q8: { remind: DAY, raise: 3 * DAY },
    Q9: { remind: 0, raise: DAY },
    NT: { remind: DAY, raise: 3 * DAY },
    A1: { remind: 3 * DAY, raise: 7 * DAY },
    A2: { remind: DAY, raise: 3 * DAY },
    A3: { remind: 15 * MINUTE, raise: 2 * HOUR },
    A4: { remind: HOUR, raise: DAY },
    A5: { remind: DAY, raise: 3 * DAY },
    A6: { remind: 0, raise: DAY },
    W1: { remind: DAY, raise: 3 * DAY },
    O3: { remind: DAY, raise: 3 * DAY },
    S3: { remind: 3 * DAY, raise: 7 * DAY },
    S6: { remind: 3, raise: 5 },
    N3: { raise: DAY },
};
/**
 * A queued item's dated wait (Q6) is the date's until one day past it; still
 * there then, the date no longer explains the wait (Q5, or Q1 with nothing held).
 */
export const DATE_GRACE_MINUTES = DAY;
/** Decision 3, option A: 先不關 keeps a topic this many days unless the captain picks another. */
export const KEEP_DEFAULT_DAYS = 14;
/** Decision 3: the longest 先不關 or 延到 the captain may pick. */
export const KEEP_MAX_DAYS = 90;
/**
 * Decision 4, option A: with no decisions_at_once from the aggregator, close
 * proposals and the board's own cards are shown this many at a time (decisions all).
 */
export const BOARD_CAP = 1;
/**
 * Decision 4 (the default until the captain answers): the queue's order of
 * kinds: the aggregator's decisions, then its close proposals, then the
 * board's two cards that say nobody picked something up: 沒人處理的議題, then 沒人接.
 */
export const TURN_ORDER = ["hold", "close", "idle", "stall"];
/** The longest deadline a minute setting may take: invariant I wants every one finite. */
const MAX_MINUTES = KEEP_MAX_DAYS * DAY;
/** S6 counts the occurrences schedules.json keeps in `recent`: ten. */
const MAX_OCCURRENCES = 10;
/** What a setting's numbers count, and the most they may be. */
function unitOf(state) {
    return state === "S6"
        ? { max: MAX_OCCURRENCES, min: 1, words: "連續第幾場（1 到 10）" }
        : { max: MAX_MINUTES, min: 0, words: `分鐘（0 到 ${MAX_MINUTES}）` };
}
export const STATE_LABEL = {
    T2: "議題沒有任何開著的工作",
    D5: "待決事項等看板看不到的工作",
    D8: "答了沒關的待決事項",
    D9: "讀不懂的待決事項",
    Q1: "排到就做的排隊項目",
    Q4: "封存議題底下的排隊項目",
    Q5: "停著、沒有日期也沒有等的項目",
    Q8: "等看板看不到的工作的排隊項目",
    Q9: "讀不懂的排隊項目",
    NT: "沒有議題的排隊項目與 agent",
    A1: "進行中卻沒有任何變化的 agent",
    A2: "停著的 agent",
    A3: "還沒開始的 agent",
    A4: "卡住的 agent",
    A5: "做完還沒收的 agent",
    A6: "狀態讀不懂的 agent",
    W1: "等 aggregator 的 worker 提問",
    O3: "按了做完了、等驗證的要你動手",
    S3: "aggregator 暫停的排程",
    S6: "沒有人接的排程",
};
/** N3's name in 期限設定 and in its records. */
export const ASK_LABEL = "請 aggregator 處理之後的「沒人接」卡";
/** N3's value: whole minutes, 1 to 90 days, and no reminder, which does not apply to it. */
function isAskDeadline(raw) {
    if (!isRecord(raw) || Object.hasOwn(raw, "remind"))
        return false;
    const { raise } = raw;
    return typeof raise === "number" && Number.isInteger(raise) && raise >= 1 && raise <= MAX_MINUTES;
}
function isDeadline(raw, state) {
    if (!isRecord(raw))
        return false;
    const { remind, raise } = raw;
    const { max, min } = unitOf(state);
    const whole = (value) => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
    return whole(remind) && whole(raise) && remind <= raise && raise >= 1;
}
/** The stored settings; a missing or invalid pair reads as its default. */
export function parseSettings(raw) {
    const given = isRecord(raw) ? raw : {};
    const settings = {};
    for (const state of TIMED_STATES) {
        const value = given[state];
        settings[state] = isDeadline(value, state) ? { ...value } : { ...DEFAULT_DEADLINES[state] };
    }
    const ask = given["N3"];
    settings.N3 = isAskDeadline(ask) ? { raise: ask.raise } : { ...DEFAULT_DEADLINES.N3 };
    return settings;
}
export function defaultSettings() {
    return parseSettings({});
}
/** How long `minutes` reads on the page and in the board's sentences. */
export function durationWords(minutes) {
    if (minutes === 0)
        return "立刻";
    if (minutes % DAY === 0)
        return `${minutes / DAY} 天`;
    if (minutes % HOUR === 0)
        return `${minutes / HOUR} 小時`;
    return `${minutes} 分鐘`;
}
/** A deadline as words: a time, or for S6 the occurrence in a row. */
export function deadlineWords(state, value) {
    return state === "S6" ? `連續第 ${value} 場` : durationWords(value);
}
function isTimedState(name) {
    return TIMED_STATES.includes(name);
}
/** Puts one change into `settings`; returns why it is refused, or null. */
function applyChange(settings, name, raw) {
    if (name === "N3") {
        if (!isAskDeadline(raw))
            return `「${ASK_LABEL}」只有交給你的期限（{raise}，分鐘，1 到 ${MAX_MINUTES}），沒有提醒`;
        settings.N3 = { raise: raw.raise };
        return null;
    }
    if (!isTimedState(name))
        return `不認得的設定：${name}`;
    const { words } = unitOf(name);
    if (!isDeadline(raw, name))
        return `「${STATE_LABEL[name]}」要是 {remind, raise}，兩個都是整數${words}，提醒不能晚於交給你，交給你至少要 1`;
    settings[name] = { remind: raw.remind, raise: raw.raise };
    return null;
}
/** The settings with `changes` applied, or why one of them is refused. */
function nextSettings(current, changes) {
    const settings = parseSettings(current);
    for (const [name, raw] of Object.entries(changes)) {
        const problem = applyChange(settings, name, raw);
        if (problem !== null)
            return problem;
    }
    return settings;
}
function pairWords(state, pair) {
    return `${deadlineWords(state, pair.remind)}／${deadlineWords(state, pair.raise)}`;
}
/** The captain's change to the deadlines; any refused value changes nothing. */
export function changeSettings(current, changes) {
    const settings = nextSettings(current, changes);
    if (typeof settings === "string")
        return { ok: false, code: "usage", line: settings };
    const lines = TIMED_STATES.filter((state) => settings[state].remind !== current[state].remind ||
        settings[state].raise !== current[state].raise).map((state) => `${STATE_LABEL[state]} ${pairWords(state, current[state])} → ${pairWords(state, settings[state])}`);
    if (settings.N3.raise !== current.N3.raise)
        lines.push(`${ASK_LABEL} ${durationWords(current.N3.raise)} → ${durationWords(settings.N3.raise)}`);
    if (lines.length === 0)
        return { ok: true, changed: false, line: "ok 期限設定沒有變" };
    const said = lines.join("；");
    return {
        ok: true,
        changed: true,
        settings,
        line: "ok 期限設定已改",
        records: [
            {
                kind: "lifecycle.settings_changed",
                topic: null,
                before: JSON.stringify(current),
                after: JSON.stringify(settings),
                text: `期限設定（提醒 aggregator／交給你）：${said}`,
            },
        ],
    };
}
