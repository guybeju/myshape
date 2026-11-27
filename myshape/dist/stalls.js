// The board's two cards that say nobody picked something up (spec/lifecycle.markdown
// section 2.13). The 沒人接 card: one per topic, and one for work with no
// topic, listing the cards under it that passed their escalation deadline; N2
// puts it in front of the captain, the captain's 延到 <日期> puts the members
// listed then off (N4), and it settles once no member is overdue. The
// 沒人處理的議題 card: a topic in 高 or 一般 with no work past its deadline.
// Before either, the reminder (stall.nudge) tells the aggregator once of each
// card past its reminder deadline. Pure: the service commits what these
// return and hands over the notice.
import crypto from "node:crypto";
import { KEEP_MAX_DAYS, STATE_LABEL, durationWords } from "./lifecycle-settings.js";
/** The stall key of a topic, and of work with no topic. */
export const NO_TOPIC = "-";
/** MM-DD of `iso` in this machine's time, as the page prints days. */
export function localDay(iso) {
    const date = new Date(iso);
    return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function stallKeyOf(topic) {
    return topic === null ? NO_TOPIC : topic;
}
function where(nameOf, key) {
    return key === NO_TOPIC ? "沒有議題的工作" : `議題「${nameOf(key)}」`;
}
function topicOfKey(key) {
    return key === NO_TOPIC ? null : key;
}
/**
 * The 沒人接 cards after this look. `members` holds, for each stall key, the
 * keys of the cards under it now past their escalation deadline. A key with
 * members gets a card (a stall.raised record when it is new); a card left
 * with none settles (stall.settled). A deferral that ran out is dropped.
 */
export function stallStep(previous, members, nameOf, nowMs) {
    const stalls = {};
    const records = [];
    for (const [key, list] of members) {
        if (list.length === 0)
            continue;
        const old = previous[key];
        stalls[key] = nextStall(old, list, nowMs);
        if (old === undefined)
            records.push(raisedRecord(nameOf, key, list.length));
    }
    for (const key of Object.keys(previous))
        if (stalls[key] === undefined)
            records.push({
                kind: "stall.settled",
                topic: topicOfKey(key),
                outcome: "stall",
                text: `「沒人接」${where(nameOf, key)}已不需要：每張卡都離開了逾期的狀態`,
            });
    return { stalls, records };
}
/** The captain's ask, kept with its card for as long as the card lasts. */
function askedOf(stall) {
    const asked = stall?.asked;
    return asked === undefined ? {} : { asked: { at: asked.at, members: [...asked.members] } };
}
/** A 沒人接 card with these members: its first time and the captain's ask kept, a 延到 kept while it runs. */
function nextStall(old, members, nowMs) {
    const put = old?.deferred;
    const running = put !== undefined && Date.parse(put.until) > nowMs;
    return {
        since: old === undefined ? new Date(nowMs).toISOString() : old.since,
        members: [...members],
        ...(running ? { deferred: { until: put.until, members: [...put.members] } } : {}),
        ...askedOf(old),
    };
}
function raisedRecord(nameOf, key, count) {
    return {
        kind: "stall.raised",
        topic: topicOfKey(key),
        outcome: "stall",
        text: `「沒人接」：${where(nameOf, key)}有 ${count} 張卡過了期限，交給你決定`,
    };
}
/** Whether a window the captain gave, ending at `endMs`, still runs and covers every member. */
function covers(stall, window, endMs, nowMs) {
    return endMs > nowMs && stall.members.every((member) => window.members.includes(member));
}
/**
 * N4 while the captain's 延到 covers every member, N3 while the time the
 * captain gave the aggregator (`askMinutes`, the N3 setting) does, N2
 * otherwise: in front of the captain.
 */
export function stallState(stall, nowMs, askMinutes) {
    const { deferred, asked } = stall;
    if (deferred !== undefined && covers(stall, deferred, Date.parse(deferred.until), nowMs))
        return "N4";
    if (asked !== undefined &&
        covers(stall, asked, Date.parse(asked.at) + askMinutes * 60_000, nowMs))
        return "N3";
    return "N2";
}
/** The captain's 延到 <日期>: puts off the members listed now, for `days` days. */
export function deferStall(stalls, key, days, context) {
    const stall = stalls[key];
    if (stall === undefined || stallState(stall, context.nowMs, context.askMinutes) !== "N2")
        return { ok: false, code: "refused", line: "這張「沒人接」卡現在沒有在等你決定。" };
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > KEEP_MAX_DAYS)
        return { ok: false, code: "usage", line: `延幾天要是 1 到 ${KEEP_MAX_DAYS} 的整數。` };
    const until = new Date(context.nowMs + days * 86_400_000).toISOString();
    const shown = localDay(until);
    return {
        ok: true,
        stall: {
            since: stall.since,
            members: [...stall.members],
            deferred: { until, members: [...stall.members] },
            ...askedOf(stall),
        },
        line: `ok ${key} 延到 ${shown}`,
        records: [
            {
                kind: "lifecycle.answered",
                topic: topicOfKey(key),
                outcome: "deferred",
                text: `「沒人接」${where(context.nameOf, key)}：延到 ${shown}，只延現在列出的 ${stall.members.length} 張`,
            },
        ],
    };
}
/**
 * How the board's sentences to the aggregator name a card: by ids only, never
 * a title: `<home>/<task>` for a read card, `要你動手 <id>` and `排程 <id>` for
 * the cards the board stores.
 */
export function cardName(card) {
    if (card.kind === "todo")
        return `要你動手 ${card.id}`;
    if (card.kind === "schedule")
        return `排程 ${card.id}`;
    return card.label;
}
/** When a late state goes to the user, as the reminder says it. */
function raiseWords(state, settings) {
    const { raise } = settings[state];
    return state === "S6"
        ? `連續第 ${raise} 場沒有人接就交給使用者`
        : `滿 ${durationWords(raise)}交給使用者`;
}
function nudgeLine(line, settings, nameOf) {
    const said = line.reasons
        .map(({ state }) => `${STATE_LABEL[state]}，${raiseWords(state, settings)}`)
        .join("；");
    if (line.topic === null)
        return `沒有議題的 ${line.label}（${said}）`;
    const place = `議題「${nameOf(line.topic)}」（id ${line.topic}）`;
    if (line.key.startsWith("topic\t"))
        return `${place}沒有任何開著的工作，滿 ${durationWords(settings.T2.raise)}成為「沒人處理的議題」交給使用者`;
    return `${place}的 ${line.label}（${said}）`;
}
/**
 * The one reminder (stall.nudge) of a look: every card that passed its
 * reminder deadline in it, a line each, under a fixed id made of each card's
 * key, state and since, so the same reminder is handed over once.
 */
export function nudgeOf(lines, settings, nameOf) {
    if (lines.length === 0)
        return null;
    const identity = lines
        .flatMap((line) => line.reasons.map(({ state, since }) => `${line.key}\t${state}\t${since}`))
        .toSorted()
        .join("\n");
    const digest = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 16);
    const said = lines.map((line) => nudgeLine(line, settings, nameOf)).join("；");
    return {
        id: `w-n-${digest}`,
        text: `看板提醒：這些卡沒有人接手，期限到了就交給使用者決定：${said}。`,
    };
}
function refuseAsk(line) {
    return { ok: false, code: "refused", line };
}
/** Why the captain may not ask again about a card in front of them, or null when it may. */
function askProblem(stall, context) {
    if (stall.asked !== undefined)
        return `這張「沒人接」卡已經請 ${context.label} 處理過一次了；現在只能延到或移到待辦。`;
    return context.members.length === 0 ? "看板現在列不出這張卡的成員，稍後再按一次。" : null;
}
/**
 * The captain's 〔請 <aggregator> 處理〕 on a topic's 沒人接 card in front of
 * them: the card goes to the aggregator for `askMinutes` (the N3 setting),
 * once per card, with one fixed message naming its members as the page lists them.
 */
export function askStall(stalls, key, context) {
    if (key === NO_TOPIC)
        return refuseAsk("沒有議題的「沒人接」卡沒有這個按鈕：訊息一定在一個議題底下。");
    const stall = stalls[key];
    if (stall === undefined || stallState(stall, context.nowMs, context.askMinutes) !== "N2")
        return refuseAsk("這張「沒人接」卡現在沒有在等你決定。");
    const problem = askProblem(stall, context);
    if (problem !== null)
        return refuseAsk(problem);
    const wait = durationWords(context.askMinutes);
    const listed = context.members
        .map((member) => `${cardName(member)}（${member.states.map((state) => STATE_LABEL[state]).join("；")}）`)
        .join("；");
    const name = context.nameOf(key);
    const digest = crypto.createHash("sha256").update(`${key}\n${stall.since}`).digest("hex");
    return {
        ok: true,
        stall: {
            since: stall.since,
            members: [...stall.members],
            asked: { at: new Date(context.nowMs).toISOString(), members: [...stall.members] },
        },
        line: `ok ${key} 已請 ${context.label} 處理`,
        records: [
            {
                kind: "lifecycle.answered",
                topic: key,
                outcome: "asked",
                text: `「沒人接」議題「${name}」：請 ${context.label} 處理這 ${context.members.length} 張，${wait}內沒有變化就回到你面前`,
            },
        ],
        message: {
            id: `w-a-${digest.slice(0, 16)}`,
            topic: key,
            text: `使用者請你處理議題「${name}」（id ${key}）的「沒人接」卡：${listed}。` +
                `${wait}內這些卡沒有離開逾期的狀態，卡會回到使用者面前，那時不能再請你處理。`,
        },
    };
}
/**
 * The 沒人處理的議題 cards after this look: one for each topic in `topics`
 * (overdue with no work), raised with a stall.raised record when new; one
 * whose topic is no longer overdue settles with stall.settled.
 */
export function idleStep(previous, topics, nameOf, nowMs) {
    const now = new Date(nowMs).toISOString();
    const idle = {};
    const records = [];
    for (const topic of topics) {
        const since = previous[topic];
        idle[topic] = since === undefined ? now : since;
        if (since === undefined)
            records.push({
                kind: "stall.raised",
                topic,
                outcome: "idle",
                text: `「沒人處理的議題」：議題「${nameOf(topic)}」過了期限還沒有任何工作，交給你決定`,
            });
    }
    for (const topic of Object.keys(previous)) {
        if (idle[topic] !== undefined)
            continue;
        records.push({
            kind: "stall.settled",
            topic,
            outcome: "idle",
            text: `「沒人處理的議題」議題「${nameOf(topic)}」已不需要：它離開了沒有工作的狀態`,
        });
    }
    return { idle, records };
}
