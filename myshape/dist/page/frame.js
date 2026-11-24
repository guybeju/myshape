// The page around the content: header, the banners that say what is wrong, and
// the choice between the home page and a topic page.
import { h } from "./dom.js";
import { home, sidebar } from "./home.js";
import { currentTopic } from "./state.js";
import { topicPage } from "./topic.js";
function staleBanner(view) {
    return view.homes
        .filter((entry) => entry.stale && entry.last_ok_seconds_ago !== null && entry.version !== "unreported")
        .map((entry) => h("div", { class: "banner warn" }, `home ${entry.id} 已經 ${Math.round((entry.last_ok_seconds_ago ?? 0) / 60)} 分鐘沒有更新：它的 agent 燈號顯示「未知」，待決事項可能已過時。`, entry.error === null ? null : h("span", { class: "note" }, ` ${entry.error}`)));
}
/** The board's own words for a home whose code differs; the aggregator may add its advice. */
function versionNote(view, entry) {
    switch (entry.version) {
        case "unreported":
            return entry.error ?? "這個 home 現在無法回報";
        case "incompatible": {
            const hint = view.aggregator.update_hint;
            return `版本不相容，它的資料沒有被使用${hint === null ? "。" : `：${hint}`}`;
        }
        case "different":
            return "版本和主 home 不同（通常只是更新還沒傳到），資料照常使用。";
        default:
            return null;
    }
}
function versionBanner(view) {
    return view.homes.map((entry) => {
        const note = versionNote(view, entry);
        return note === null ? null : h("div", { class: "banner warn" }, `home ${entry.id}：${note}`);
    });
}
/** A home whose ledger is off, only when the aggregator said what to do about it. */
function ledgerBanner(view) {
    return view.homes
        .filter((entry) => entry.ledger_enabled === false && entry.ledger_hint !== null)
        .map((entry) => h("div", { class: "banner warn" }, entry.ledger_hint));
}
/** Nothing is on the other side: a plain note, since nothing on the page is lost. */
function notConnectedNote(view) {
    if (view.aggregator.connected)
        return null;
    return h("p", { class: "note not-connected" }, `沒有接上 aggregator（${view.aggregator.unavailable ?? ""}）。頁面上的動作照常完成；要送出的會等它接上之後依序送出。`);
}
const ROLE_WORD = { feed: "讀取", deliver: "送出" };
/**
 * A program the board may run only once the captain confirms it, in two
 * steps that show its full path; the board checks both steps against the
 * program and binding as they are then.
 */
function programConfirm(page, actions, program) {
    const name = page.view?.aggregator.binding?.name ?? "aggregator";
    const roles = program.roles.map((role) => ROLE_WORD[role]).join("與");
    const key = `program:${program.path}`;
    const role = program.roles[0] ?? "deliver";
    if (!page.pending.has(key)) {
        return h("p", { class: "note program-confirm" }, `要接上 ${name}，看板得在${roles}時執行 `, h("code", {}, program.path), "。這支程式不是看板程式目錄 bin/ 裡、和 commit 相同的檔，要你確認一次才會執行。", h("button", { onclick: () => actions.ask(key, "programs/confirm", { role }) }, "確認…"));
    }
    return h("div", { class: "confirm" }, `確定讓看板在每次${roles}時執行 `, h("code", {}, program.path), ` 嗎？確認的是它現在的內容（SHA-256 ${program.sha256}）與 config/myshape-aggregator.json 現在的內容；之後兩者有一個改了，看板就不執行，再問你一次。`, h("span", { class: "btns" }, h("button", { class: "danger", onclick: () => actions.confirm(key) }, "確定執行"), h("button", { onclick: () => actions.cancel(key) }, "取消")));
}
function programConfirms(page, actions) {
    return (page.view?.aggregator.confirm ?? []).map((program) => programConfirm(page, actions, program));
}
function banners(page, actions) {
    const view = page.view;
    return [
        page.tokenBad
            ? h("div", { class: "banner" }, "token 已重置或無效，請在終端機重新跑 ", h("code", {}, "bin/myshape.sh open"))
            : null,
        page.down
            ? h("div", { class: "banner" }, "看板服務沒有回應。畫面是最後拿到的資料，現在送不出東西。請在終端機跑 ", h("code", {}, "bin/myshape.sh open"))
            : null,
        view === null
            ? null
            : [
                notConnectedNote(view),
                programConfirms(page, actions),
                staleBanner(view),
                versionBanner(view),
                ledgerBanner(view),
            ],
        page.notice === null
            ? null
            : h("div", { class: "banner warn" }, page.notice, " ", h("button", { class: "link", onclick: () => actions.cancel("notice") }, "知道了")),
    ];
}
export function frame(page, actions) {
    const view = page.view;
    const topic = currentTopic();
    return [
        h("header", {}, h("h1", {}, h("button", { class: "link", onclick: () => actions.open(null) }, "議題看板")), h("span", { class: "spacer" }), h("span", { class: "note" }, "每 5 秒自動更新"), h("button", { onclick: actions.refresh }, "立刻更新")),
        banners(page, actions),
        view === null
            ? h("main", {}, h("p", { class: "note" }, page.tokenBad || page.down ? "" : "載入中…"))
            : h("main", {}, topic === null
                ? h("div", { class: "side" }, sidebar(view, actions), h("div", {}, home(page, view, actions)))
                : topicPage(page, view, actions, topic)),
    ];
}
