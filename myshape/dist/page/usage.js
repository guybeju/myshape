import { h } from "./dom.js";
import { when } from "./parts.js";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** A length of time in the largest two units that matter, rounded down: "2 天 3 小時", "4 小時 5 分", "6 分". */
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
/** The number as written: a percentage to one decimal, any other value with its unit. */
export function valueText(item) {
    const shown = String(Number(item.value.toFixed(1)));
    if (item.unit === "%")
        return `${shown}%`;
    return item.unit === "" ? shown : `${shown} ${item.unit}`;
}
const GROUP_PILL = {
    ok: null,
    stale: "舊的數字",
    unavailable: "讀不到",
};
/** The class of a metric's row: a stale one is greyed, and only a current one carries its severity. */
export function itemClass(item) {
    if (item.stale !== null)
        return "usage-item stale";
    return item.severity === "normal" ? "usage-item" : `usage-item sev-${item.severity}`;
}
function itemRow(item, nowMs) {
    const notes = [resetText(item.resets_at, nowMs), ageText(item, nowMs)];
    if (item.stale !== null)
        notes.push(STALE_TEXT[item.stale]);
    return h("div", { class: itemClass(item), "data-metric": item.id }, h("div", { class: "usage-line" }, h("span", { class: "grow" }, item.label), h("b", {}, valueText(item))), item.unit === "%" ? h("meter", { min: 0, max: 100, value: item.value }) : null, h("div", { class: "note" }, notes.filter((note) => note !== null).join(" · ")));
}
function groupCard(group, nowMs) {
    const pill = GROUP_PILL[group.state];
    const next = group.next_reset === null ? null : resetText(group.next_reset, nowMs);
    return h("div", {
        class: group.state === "ok" ? "usage-group" : "usage-group off",
        "data-group": group.id ?? "",
    }, group.label === "" && pill === null
        ? null
        : h("div", { class: "usage-line" }, h("b", { class: "grow" }, group.label), pill === null ? null : h("span", { class: "pill warn" }, pill)), group.note === "" ? null : h("div", { class: "note" }, group.note), next === null || group.items.length < 2 ? null : h("div", { class: "note" }, `最快：${next}`), group.items.map((item) => itemRow(item, nowMs)));
}
function homeBlock(view, nowMs) {
    return [
        view.home === "main" ? null : h("h3", {}, `home ${view.home}`),
        view.problem === null
            ? null
            : h("p", { class: "note" }, `看板沒有用這份用量資料：${view.problem}`),
        view.groups.map((group) => groupCard(group, nowMs)),
        view.dropped === 0
            ? null
            : h("p", { class: "note" }, `看板略過了 ${view.dropped} 筆不合格式的用量資料（第一筆：${view.first_drop ?? ""}）`),
    ];
}
/** The panel, or nothing when no home pushed metrics. */
export function usagePanel(metrics, nowMs) {
    if (metrics.length === 0)
        return null;
    return h("div", { class: "usage", "data-key": "usage" }, h("h2", {}, "用量"), metrics.map((view) => homeBlock(view, nowMs)));
}
