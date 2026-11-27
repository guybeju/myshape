import { h } from "./dom.js";
import { when } from "./parts.js";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/**
 * A length of time in the largest two units that matter, rounded down:
 * "2 天 3 小時", "4 小時 5 分", "6 分".
 */
export function spanText(ms) {
    if (ms < MINUTE_MS)
        return "不到 1 分";
    const days = Math.floor(ms / DAY_MS);
    const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
    const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
    if (days > 0)
        return hours > 0 ? `${days} 天 ${hours} 小時` : `${days} 天`;
    if (hours > 0)
        return minutes > 0 ? `${hours} 小時 ${minutes} 分` : `${hours} 小時`;
    return `${minutes} 分`;
}
function clock(iso) {
    return when(Date.parse(iso) / 1000);
}
/** When a reset comes, or that it has passed: never a countdown below zero. */
export function resetText(resetsAt, nowMs) {
    if (resetsAt === null)
        return null;
    const left = Date.parse(resetsAt) - nowMs;
    if (left <= 0)
        return `重置時間已過（${clock(resetsAt)}）`;
    return `${spanText(left)}後重置（${clock(resetsAt)}）`;
}
/** How long ago the aggregator measured a metric, as far as the board can tell. */
export function ageText(item, nowMs) {
    if (item.measured_at === null)
        return "沒說是什麼時候量的";
    if (item.stale === "future")
        return `量的時間（${clock(item.measured_at)}）比看板的時鐘晚`;
    const ago = nowMs - Date.parse(item.measured_at);
    return ago < MINUTE_MS ? "剛量的" : `${spanText(ago)}前量的`;
}
const STALE_TEXT = {
    group: "這組的數字不是現在的",
    "no-time": "不知道是不是現在的",
    future: "不當成現在的數字",
    reset: "重置之後還沒有新的數字",
    old: "已經過時",
};
/** The number as written: a percentage to one decimal, any other value as sent, with its unit. */
export function valueText(item) {
    if (item.unit === "%")
        return `${Number(item.value.toFixed(1))}%`;
    return item.unit === "" ? String(item.value) : `${item.value} ${item.unit}`;
}
const GROUP_PILL = {
    ok: null,
    stale: "舊的數字",
    unavailable: "讀不到",
};
/**
 * The class of a metric's row: a stale one is greyed, and only a current
 * one carries its severity.
 */
export function itemClass(item) {
    if (item.stale !== null)
        return "usage-item stale";
    return item.severity === "normal" ? "usage-item" : `usage-item sev-${item.severity}`;
}
export function usageRow(item, nowMs) {
    const notes = [resetText(item.resets_at, nowMs), ageText(item, nowMs)];
    if (item.stale !== null)
        notes.push(STALE_TEXT[item.stale]);
    return {
        id: item.id,
        class: itemClass(item),
        label: item.label,
        value: valueText(item),
        meter: item.unit === "%" ? { min: 0, max: 100, value: item.value } : null,
        note: notes.filter((note) => note !== null).join(" · "),
    };
}
export function usageCard(group, nowMs) {
    const pill = GROUP_PILL[group.state];
    const next = group.next_reset === null ? null : resetText(group.next_reset, nowMs);
    return {
        id: group.id,
        class: group.state === "ok" ? "usage-group" : "usage-group off",
        title: group.label === "" && pill === null ? null : { label: group.label, pill },
        note: group.note === "" ? null : group.note,
        next: next === null || group.items.length < 2 ? null : `最快：${next}`,
        rows: group.items.map((item) => usageRow(item, nowMs)),
    };
}
/** Every home's part of the panel at `nowMs`, in the board's order. */
export function usageBlocks(metrics, nowMs) {
    return metrics.map((view) => ({
        home: view.home === "main" ? null : `home ${view.home}`,
        problem: view.problem === null ? null : `看板沒有用這份用量資料：${view.problem}`,
        cards: view.groups.map((group) => usageCard(group, nowMs)),
        dropped: view.first_drop === null
            ? null
            : `看板略過了 ${view.dropped} 筆不合格式的用量資料（第一筆：${view.first_drop}）`,
    }));
}
/** The list, or null for an empty one. */
export function nonEmpty(list) {
    return list.length === 0 ? null : list;
}
/** `render(value)`, or nothing for a null value. */
export function shown(value, render) {
    return value === null ? null : render(value);
}
function rowNode(row) {
    return h("div", { class: row.class, "data-metric": row.id }, h("div", { class: "usage-line" }, h("span", { class: "grow" }, row.label), h("b", {}, row.value)), shown(row.meter, (meter) => h("meter", meter)), h("div", { class: "note" }, row.note));
}
function cardNode(card) {
    return h("div", { class: card.class, "data-group": card.id }, shown(card.title, (title) => h("div", { class: "usage-line" }, h("b", { class: "grow" }, title.label), shown(title.pill, (pill) => h("span", { class: "pill warn" }, pill)))), shown(card.note, (note) => h("div", { class: "note" }, note)), shown(card.next, (next) => h("div", { class: "note" }, next)), card.rows.map(rowNode));
}
function blockNode(block) {
    return [
        shown(block.home, (home) => h("h3", {}, home)),
        shown(block.problem, (problem) => h("p", { class: "note" }, problem)),
        block.cards.map(cardNode),
        shown(block.dropped, (dropped) => h("p", { class: "note" }, dropped)),
    ];
}
/** The panel, or nothing when no home pushed metrics. */
export function usagePanel(metrics, nowMs) {
    return shown(nonEmpty(usageBlocks(metrics, nowMs)), (blocks) => h("div", { class: "usage", "data-key": "usage" }, h("h2", {}, "用量"), blocks.map(blockNode)));
}
