import { h } from "./dom.js";
import { NO_FILTER, cycleHashtag, isActive, owedOutside, viewFilter } from "./filter.js";
import { draftInput, topicLink, topicName, when } from "./parts.js";
import { agentName } from "./state.js";
const COLORS = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"];
function hashtagOf(view, name) {
    return view.hashtags.hashtags.find((entry) => entry.name === name);
}
/** One hashtag as a chip; `state` marks it chosen (有) or excluded (沒有) in the filter. */
export function chip(view, name, state = null) {
    const entry = hashtagOf(view, name);
    return h("span", { class: `tag ${entry?.color ?? "c1"}${state === null ? "" : ` ${state}`}` }, `#${name}`, entry?.new === true ? h("span", { class: "new" }, "新") : null);
}
/** A topic's hashtags on its card, flagged when a merge left more than the maximum. */
export function topicChips(view, id) {
    const names = view.hashtags.topics[id] ?? [];
    if (names.length === 0)
        return null;
    return h("div", { class: "meta tags" }, names.map((name) => chip(view, name)), view.hashtags.over.includes(id) ? h("span", { class: "pill warn" }, "hashtag 超過上限") : null);
}
/** What merging `from` into `into` adds to `into`'s hashtags, for the merge's second step. */
export function mergeTagNote(view, from, into) {
    const have = view.hashtags.topics[into] ?? [];
    const added = (view.hashtags.topics[from] ?? []).filter((name) => !have.includes(name));
    if (added.length === 0)
        return null;
    const total = have.length + added.length;
    const max = view.hashtags.settings.per_topic_max;
    return h("div", {}, `hashtag 取聯集，「${topicName(view, into)}」會多 `, added.map((name) => chip(view, name)), total > max ? `，合起來 ${total} 個，超過上限 ${max} 個；減到上限以下之前不能再貼新的。` : "。");
}
function viewButtons(page, view, actions) {
    const current = page.filter;
    const button = (label, chosen, filter) => h("button", { class: chosen ? "primary" : "", onclick: () => actions.setFilter(filter) }, label);
    return h("div", { class: "btns" }, h("span", { class: "note" }, "視圖："), button("全部", !isActive(current), NO_FILTER), view.hashtags.views.map((saved) => button(saved.name, current.view === saved.id, viewFilter(saved))), button("（沒標）", current.untagged && current.any.length === 0, {
        ...NO_FILTER,
        untagged: true,
    }));
}
function hashtagButtons(page, view, actions) {
    const filter = page.filter;
    if (view.hashtags.hashtags.length === 0)
        return null;
    return h("div", { class: "btns" }, h("span", { class: "note" }, "hashtag（按一下是有、再按是沒有）："), view.hashtags.hashtags.map((entry) => {
        const state = filter.any.includes(entry.name)
            ? "on"
            : filter.none.includes(entry.name)
                ? "not"
                : null;
        return h("button", { class: "link chip", onclick: () => actions.setFilter(cycleHashtag(filter, entry.name)) }, state === "not" ? "沒有 " : "", chip(view, entry.name, state));
    }));
}
function keywordRow(page, actions) {
    const filter = page.filter;
    const keyword = (event) => actions.setFilter({ ...filter, text: event.target.value, view: null });
    const save = () => {
        const name = (page.drafts.get("view-name") ?? "").trim();
        if (name === "")
            return;
        actions.send("views/save", {
            name,
            any: filter.any,
            none: filter.none,
            text: filter.text,
            untagged: filter.untagged,
        });
        actions.draft("view-name", "");
    };
    return h("div", { class: "btns" }, h("input", {
        type: "text",
        "data-key": "filter-text",
        placeholder: "關鍵字（比對頁面上的所有文字）",
        value: filter.text,
        // A redraw in the middle of an input method's composition (Chinese, Japanese) would cut it off.
        oninput: (event) => {
            if (!event.isComposing)
                keyword(event);
        },
        oncompositionend: keyword,
    }), isActive(filter)
        ? [
            draftInput(page, actions, "view-name", "存成視圖的名稱", save),
            h("button", { onclick: save }, "存成視圖"),
        ]
        : null);
}
/** The line that never lets a filter hide what waits on the captain. */
function owedLine(view, actions, shown) {
    if (shown === null)
        return null;
    const owed = owedOutside(view, shown);
    const parts = [
        `等你決定 ${owed.decide}`,
        ...(owed.handsOn > 0 ? [`要你動手 ${owed.handsOn}`] : []),
    ];
    return h("p", { class: owed.decide + owed.handsOn > 0 ? "owed red" : "owed" }, h("button", { class: "link", onclick: () => actions.setFilter(NO_FILTER) }, `這個篩選之外還有：${parts.join("、")}`));
}
function panelButtons(page, view, actions) {
    const recent = view.hashtags.recent.length;
    const toggle = (panel) => actions.setTagPanel(page.tagPanel === panel ? null : panel);
    return h("div", { class: "btns" }, recent > 0
        ? h("button", { class: "link", onclick: () => toggle("recent") }, `${agentName()} 最近改了 ${recent} 個 hashtag`)
        : null, h("button", { class: "link", onclick: () => toggle("settings") }, "hashtag 設定"));
}
/** The filter bar above the home page. */
export function filterBar(page, view, actions, shown) {
    return h("section", { class: "filterbar" }, viewButtons(page, view, actions), hashtagButtons(page, view, actions), keywordRow(page, actions), owedLine(view, actions, shown), panelButtons(page, view, actions), page.tagPanel === "recent" ? recentPanel(view, actions) : null, page.tagPanel === "settings" ? settingsPanel(page, view, actions) : null);
}
function recentPanel(view, actions) {
    return h("div", { class: "card" }, h("h3", {}, `${agentName()} 最近的 hashtag 改動`), view.hashtags.recent.map((change) => h("div", { class: "row" }, h("span", { class: "t note" }, when(change.ts)), h("span", { class: "grow" }, change.text), change.topic === null ? null : topicLink(view, change.topic, actions), change.reverted
        ? h("span", { class: "note" }, "已撤回")
        : h("button", { onclick: () => actions.send("hashtags/revert", { rid: change.rid }) }, "撤回"))), h("div", { class: "btns" }, h("button", { onclick: () => actions.send("hashtags/seen", {}) }, "看過了")));
}
const SETTING_LABEL = {
    aggregator_may_tag: () => `${agentName()} 可以貼撕 hashtag`,
    aggregator_may_create: () => `${agentName()} 可以開新的 hashtag`,
    per_topic_max: () => "一個議題最多幾個 hashtag",
    board_max: () => `整個看板最多幾個 hashtag（${agentName()} 開新的時）`,
    aggregator_hourly_max: () => `${agentName()} 每小時最多改幾次 hashtag`,
    default_view: () => "打開看板預設看哪個視圖",
};
function shownValue(view, name, value) {
    if (typeof value === "boolean")
        return value ? "可以" : "不可以";
    if (name === "default_view")
        return view.hashtags.views.find((saved) => saved.id === value)?.name ?? "全部";
    return String(value);
}
function settingControl(page, view, actions, name) {
    const current = view.hashtags.settings[name];
    const apply = (value) => actions.send("hashtags/settings", { [name]: value });
    if (typeof current === "boolean")
        return h("button", { onclick: () => apply(!current) }, current ? "改成不可以" : "改成可以");
    if (name === "default_view")
        return h("select", { class: "auto", onchange: (event) => apply(event.target.value) }, [{ id: "all", name: "全部" }, ...view.hashtags.views].map((saved) => h("option", { value: saved.id, ...(saved.id === current ? { selected: true } : {}) }, saved.name)));
    const key = `setting:${name}`;
    const range = view.hashtags.ranges[name];
    const save = () => {
        const typed = (page.drafts.get(key) ?? "").trim();
        if (typed !== "")
            apply(Number(typed));
    };
    return [
        draftInput(page, actions, key, `${range[0]} 到 ${range[1]}`, save),
        h("button", { onclick: save }, "改"),
    ];
}
function settingsTable(page, view, actions) {
    const names = Object.keys(SETTING_LABEL);
    return h("table", { class: "settings" }, h("tr", {}, h("th", {}, "設定"), h("th", {}, "現在"), h("th", {}, "預設"), h("th", {}, "")), names.map((name) => h("tr", {}, h("td", {}, SETTING_LABEL[name]()), h("td", {}, shownValue(view, name, view.hashtags.settings[name])), h("td", {}, shownValue(view, name, view.hashtags.defaults[name])), h("td", {}, settingControl(page, view, actions, name)))));
}
/** The second step of a whole-hashtag change: how many topics, and which. */
function wholeConfirm(page, view, actions, key, what) {
    const pending = page.pending.get(key);
    if (pending === undefined)
        return null;
    const topics = Array.isArray(pending.data["topics"]) ? pending.data["topics"] : [];
    return h("div", { class: "confirm" }, `${what}會動到 ${topics.length} 個議題${topics.length === 0 ? "" : "："}`, topics.map((id) => topicName(view, id)).join("、"), h("div", { class: "btns" }, h("button", { class: "danger", onclick: () => actions.confirm(key) }, "確定"), h("button", { onclick: () => actions.cancel(key) }, "取消")));
}
/** One hashtag's line in the settings panel: how many topics, who opened it, its lock and colour. */
function hashtagMeta(view, actions, entry) {
    const name = entry.name;
    const recolor = (event) => actions.send("hashtags/color", { name, color: event.target.value });
    return h("div", { class: "meta" }, chip(view, name), h("span", {}, `${entry.topics.length} 個議題`), entry.created_by === "aggregator" ? h("span", { class: "note" }, `${agentName()} 開的`) : null, h("button", { onclick: () => actions.send("hashtags/lock", { name, locked: !entry.locked }) }, entry.locked ? "解鎖（現在只有你能貼撕）" : "鎖上"), h("select", { class: "auto", onchange: recolor }, COLORS.map((color, index) => h("option", { value: color, ...(color === entry.color ? { selected: true } : {}) }, `顏色 ${index + 1}`))));
}
/** The menu that starts merging `name` into another hashtag; none when there is no other. */
function mergeInto(view, actions, name) {
    const others = view.hashtags.hashtags.filter((other) => other.name !== name);
    if (others.length === 0)
        return null;
    const choose = (event) => {
        const into = event.target.value;
        if (into !== "")
            actions.ask(`tag-merge:${name}`, "hashtags/merge", { name, into });
    };
    return h("select", { class: "auto", onchange: choose }, h("option", { value: "" }, "併入…"), others.map((other) => h("option", { value: other.name }, `#${other.name}`)));
}
/** The other side of a pending whole-hashtag change, for its confirmation line. */
function pendingArg(page, key, field) {
    return String(page.pending.get(key)?.body[field] ?? "");
}
function hashtagRow(page, view, actions, entry) {
    const name = entry.name;
    const keys = {
        rename: `tag-rename:${name}`,
        merge: `tag-merge:${name}`,
        remove: `tag-delete:${name}`,
    };
    const rename = () => {
        const to = (page.drafts.get(`tag-to:${name}`) ?? "").trim();
        if (to !== "")
            actions.ask(keys.rename, "hashtags/rename", { name, to });
    };
    return h("div", { class: "card" }, hashtagMeta(view, actions, entry), h("div", { class: "btns" }, draftInput(page, actions, `tag-to:${name}`, "新名稱", rename), h("button", { onclick: rename }, "改名…"), mergeInto(view, actions, name), h("button", { class: "danger", onclick: () => actions.ask(keys.remove, "hashtags/delete", { name }) }, "刪掉…")), wholeConfirm(page, view, actions, keys.rename, `把 #${name} 改名為 #${pendingArg(page, keys.rename, "to")}，`), wholeConfirm(page, view, actions, keys.merge, `把 #${name} 併入 #${pendingArg(page, keys.merge, "into")}，`), wholeConfirm(page, view, actions, keys.remove, `刪掉 #${name}，`));
}
function settingsPanel(page, view, actions) {
    return h("div", { class: "card" }, h("h3", {}, "hashtag 設定"), h("p", { class: "note" }, `hashtag 只描述議題的內容，不改佇列、順序或派工。這裡的設定管 ${agentName()} 能做什麼；你在頁面上不受這些限制，只受「一個議題最多幾個」管。`), settingsTable(page, view, actions), h("h3", {}, "hashtag"), view.hashtags.hashtags.length === 0 ? h("p", { class: "note" }, "還沒有 hashtag。") : null, view.hashtags.hashtags.map((entry) => hashtagRow(page, view, actions, entry)), h("h3", {}, "存下來的視圖"), view.hashtags.views.length === 0
        ? h("p", { class: "note" }, "還沒有。用上面的篩選再按「存成視圖」。")
        : null, view.hashtags.views.map((saved) => h("div", { class: "row" }, h("span", { class: "grow" }, saved.name), [
        ...saved.any.map((name) => chip(view, name, "on")),
        ...saved.none.map((name) => chip(view, name, "not")),
    ], saved.text === "" ? null : h("span", { class: "note" }, `關鍵字：${saved.text}`), saved.untagged ? h("span", { class: "note" }, "（沒標）") : null, h("button", { onclick: () => actions.send("views/delete", { id: saved.id }) }, "刪掉"))));
}
/** A topic's hashtags on its own page: take one off, put one on. */
export function topicTagEditor(page, view, actions, id) {
    const names = view.hashtags.topics[id] ?? [];
    const key = `tag-add:${id}`;
    const add = () => {
        const name = (page.drafts.get(key) ?? "").trim();
        if (name === "")
            return;
        actions.send("hashtags/add", { id, name });
        actions.draft(key, "");
    };
    const max = view.hashtags.settings.per_topic_max;
    return h("div", { class: "btns tags" }, names.map((name) => h("span", {}, chip(view, name), h("button", {
        class: "link",
        "aria-label": `撕掉 #${name}`,
        onclick: () => actions.send("hashtags/remove", { id, name }),
    }, "×"))), view.hashtags.over.includes(id)
        ? h("span", { class: "pill warn" }, `hashtag 有 ${names.length} 個，超過上限 ${max} 個；減到上限以下之前不能再貼新的`)
        : null, draftInput(page, actions, key, "貼上 hashtag（文字、數字、底線）", add), h("button", { onclick: add }, "貼上"));
}
