import { h } from "./dom.js";
import { fileMenu, holdCard, topicLink, when, writeRows } from "./parts.js";
import { BAD_WRITES, agentName } from "./state.js";
/** The days 先不關 or 延到 is shown with by default (KEEP_DEFAULT_DAYS; page scripts cannot load lifecycle-settings.ts). */
const DEFAULT_DAYS = 14;
const DAY_MS = 86_400_000;
/** The days typed for one card, or the default. */
function daysOf(page, key) {
    const typed = Number(page.drafts.get(key) ?? "");
    return Number.isInteger(typed) && typed >= 1 && typed <= 90 ? typed : DEFAULT_DAYS;
}
/** The date `days` from now, as MM-DD. */
function dayWords(days) {
    return when(Math.floor((Date.now() + days * DAY_MS) / 1000)).slice(0, 5);
}
/** A small box for how many days, kept across re-renders. */
function daysBox(page, actions, key) {
    return h("input", {
        type: "number",
        class: "days",
        min: "1",
        max: "90",
        "data-key": key,
        placeholder: String(DEFAULT_DAYS),
        value: page.drafts.get(key) ?? "",
        oninput: (event) => actions.draft(key, event.target.value),
    });
}
/** The aggregator's 提議關閉: close and archive, or keep until a date or in 待辦. */
export function closeCard(page, view, actions, id) {
    const topic = view.topics[id];
    if (topic === undefined || topic.close_reason === null)
        return null;
    const key = `keep-days:${id}`;
    const days = daysOf(page, key);
    return h("div", { class: "card", "data-close": id }, h("div", { class: "meta" }, topicLink(view, id, actions), h("span", { class: "pill warn" }, "提議關閉")), h("div", {}, `${agentName()} 認為這個議題可以關了：${topic.close_reason}`), h("div", { class: "btns" }, h("button", { onclick: () => actions.topic("archive", { id }) }, "關閉並封存"), h("button", { onclick: () => actions.topic("keep", { id, days }) }, `先不關，到 ${dayWords(days)}`), daysBox(page, actions, key), h("button", { onclick: () => actions.topic("keep", { id, later: true }) }, "先不關，移到待辦")));
}
/** The board's 沒人處理的議題: a topic with no work that nobody handled. A fact, not a proposal. */
export function idleCard(page, view, actions, id) {
    const card = view.idle.find((entry) => entry.topic === id);
    if (card === undefined)
        return null;
    const key = `idle-days:${id}`;
    const days = daysOf(page, key);
    return h("div", { class: "card", "data-idle": id }, h("div", { class: "meta" }, topicLink(view, id, actions), h("span", { class: "pill warn" }, "沒人處理的議題")), h("div", {}, card.text), h("div", { class: "btns" }, h("button", { onclick: () => actions.topic("archive", { id }) }, "關閉並封存"), h("button", { onclick: () => actions.send("lifecycle/answer", { card: "idle", key: id, days }) }, `先不關，到 ${dayWords(days)}`), daysBox(page, actions, key), h("button", { onclick: () => actions.topic("move", { id, queue: "later" }) }, "移到待辦")));
}
const STATE_WORDS = {
    D8: "答了沒關",
    D9: "讀不懂",
    Q1: "排到就做卻一直沒做",
    Q4: "議題已封存，這筆還開著",
    Q5: "停著，沒有日期也沒有等的項目",
    Q8: "等的工作看板找不到",
    Q9: "讀不懂",
    NT: "沒有議題",
    A1: "進行中卻沒有任何變化",
    A2: "停著",
    A3: "還沒開始",
    A4: "卡住",
    A5: "做完還沒收",
    A6: "狀態讀不懂",
    W1: "worker 的問題沒人回",
    O3: "按了做完了，等驗證",
    S3: "aggregator 暫停了排程",
    S6: "排程一直沒有人接",
};
/**
 * The one button the board already has for a member, when it has one: a
 * schedule's resume or pause, and filing work with no topic under one (a tag
 * write: 歸到… for a queued item, 歸併到… for an agent).
 */
function memberAction(view, actions, member) {
    const topic = view.schedules.series.find((series) => series.id === member.id)?.topic;
    if (member.states.includes("S3") && topic !== undefined)
        return h("button", { onclick: () => actions.send("schedules/resume", { topic }) }, "恢復排程");
    if (member.states.includes("S6") && topic !== undefined)
        return h("button", { onclick: () => actions.send("schedules/pause", { topic }) }, "暫停排程");
    if (!member.states.includes("NT") || member.home === null)
        return null;
    const target = { home: member.home, task: member.id };
    return fileMenu(view, actions, target, member.kind === "queued" ? "歸到…" : "歸併到…");
}
function memberRow(view, actions, member) {
    const reasons = member.states.map((state) => STATE_WORDS[state] ?? state).join("、");
    return h("div", { class: "row" }, h("span", { class: "grow" }, h("b", {}, member.label), ` ${reasons}（從 ${when(Date.parse(member.since) / 1000)}）`), memberAction(view, actions, member));
}
/**
 * 〔請 <aggregator> 處理〕 on a topic's card the captain has not asked about
 * yet, or the line that says it was asked once and came back.
 */
function askPart(actions, stall) {
    if (stall.asked_at !== null)
        return {
            note: h("div", { class: "note" }, `已退回過一次：${when(Date.parse(stall.asked_at) / 1000)} 請 ${agentName()} 處理過，期限內沒有變化。`),
            button: null,
        };
    if (stall.topic === null)
        return { note: null, button: null };
    const ask = { card: "stall", key: stall.key, ask: true };
    return {
        note: null,
        button: h("button", { onclick: () => actions.send("lifecycle/answer", ask) }, `請 ${agentName()} 處理`),
    };
}
/** The board's 沒人接 card: the cards under a topic past their deadline, with 延到, 移到待辦 and 請 <aggregator> 處理. */
export function stallCard(page, view, actions, stall) {
    const key = `stall-days:${stall.key}`;
    const days = daysOf(page, key);
    const live = stall.topic !== null && view.topics[stall.topic]?.status !== "archived";
    const ask = askPart(actions, stall);
    return h("div", { class: "card", "data-stall": stall.key }, h("div", { class: "meta" }, stall.topic === null
        ? h("span", { class: "pill" }, "沒有議題")
        : topicLink(view, stall.topic, actions), h("span", { class: "pill warn" }, "沒人接")), h("div", {}, `這些卡過了期限，${agentName()} 都沒有接手：`), stall.members.map((member) => memberRow(view, actions, member)), ask.note, h("div", { class: "btns" }, ask.button, h("button", {
        onclick: () => actions.send("lifecycle/answer", { card: "stall", key: stall.key, days }),
    }, `延到 ${dayWords(days)}`), daysBox(page, actions, key), live
        ? h("button", { onclick: () => actions.topic("move", { id: stall.topic, queue: "later" }) }, "移到待辦")
        : null));
}
function turnCard(page, view, actions, turn) {
    if (turn.kind === "close")
        return closeCard(page, view, actions, turn.key);
    if (turn.kind === "idle")
        return idleCard(page, view, actions, turn.key);
    if (turn.kind === "stall") {
        const stall = view.stalls.find((entry) => entry.key === turn.key);
        return stall === undefined ? null : stallCard(page, view, actions, stall);
    }
    const hold = view.holds.find((entry) => `${entry.home}\t${entry.task}` === turn.key);
    return hold === undefined ? null : holdCard(page, view, actions, hold, true);
}
/**
 * The cards of the one queue that `shows` lets through, in its order: the
 * ones in front, then one line for how many wait their turn.
 */
export function queueCards(page, view, actions, shows) {
    const turns = view.turns.filter((turn) => shows(turn.topic));
    const waiting = turns.filter((turn) => turn.waits_turn).length;
    return [
        turns.filter((turn) => !turn.waits_turn).map((turn) => turnCard(page, view, actions, turn)),
        waiting === 0
            ? null
            : h("p", { class: "note turns" }, `還有 ${waiting} 個決定排隊，輪到時才顯示`),
    ];
}
/** Every write that did not arrive, with or without a topic, archived ones too, with 重送 and 忽略. */
export function undelivered(page, actions) {
    const bad = (page.view?.writes ?? []).filter((write) => BAD_WRITES.includes(write.state));
    if (bad.length === 0)
        return null;
    return h("section", {}, h("h2", {}, `沒送到 ${bad.length}`), writeRows(page, actions, (write) => BAD_WRITES.includes(write.state), bad.length));
}
/** One deadline setting: its two numbers and their defaults; a reminder that does not apply shows as 不適用. */
function settingRow(page, actions, row) {
    const remindKey = `deadline-remind:${row.state}`;
    const raiseKey = `deadline-raise:${row.state}`;
    const value = (key, current) => Number(page.drafts.get(key) ?? current);
    const raise = () => value(raiseKey, row.raise);
    const { remind } = row;
    const save = () => actions.send("lifecycle/settings", {
        [row.state]: remind === null ? { raise: raise() } : { remind: value(remindKey, remind), raise: raise() },
    });
    const box = (key, current) => h("input", {
        type: "number",
        class: "days",
        "data-key": key,
        value: page.drafts.get(key) ?? String(current),
        oninput: (event) => actions.draft(key, event.target.value),
    });
    return h("div", { class: "row" }, h("span", { class: "grow" }, `${row.label}（${row.unit}；預設 ${row.default_remind ?? "不適用"}／${row.default_raise}）`), "提醒", remind === null ? h("span", { class: "note" }, "不適用") : box(remindKey, remind), "交給你", box(raiseKey, row.raise), h("button", { onclick: save }, "存"));
}
/** Says which rows have no reminder, and why: N3, since your press already handed the card over. */
function noReminder(view) {
    const rows = view.lifecycle.settings.filter((row) => row.remind === null);
    const names = rows.map((row) => `「${row.label}」`).join("、");
    return rows.length === 0
        ? ""
        : `${names}沒有提醒（不適用）：你按了請 ${agentName()} 處理，就是交給它了，只有多久之後回到你面前。`;
}
/** The captain's deadline settings: when the aggregator is reminded, and when a card comes to you. */
export function lifecycleSettings(page, actions, view) {
    return h("details", { "data-key": "lifecycle-settings" }, h("summary", {}, "期限設定"), h("p", { class: "note" }, `提醒不能晚於交給你；每一項都要有期限。${noReminder(view)}`), view.lifecycle.settings.map((row) => settingRow(page, actions, row)));
}
