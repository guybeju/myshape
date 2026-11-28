import { h } from "./dom.js";
import { agentRow, closedFold, closedTodoEntries, fileMenu, holdCard, inFront, liveTodos, todoCard, needsCaptain, queuedRow, questionRow, summaryRow, topicLink, topicName, untaggedQueued, } from "./parts.js";
import { BAD_WRITES, LIGHT_LABEL, QUEUES, QUEUE_LABEL } from "./state.js";
import { dropHint } from "./drop.js";
import { TABS, isShown, resolveFilter, shownTopics } from "./filter.js";
import { cardOrder, sortCards } from "./sort.js";
import { FILTER_PANEL, filterPanel, hashtagBar, mergeTagNote, owedLine, topicChips, } from "./tags.js";
import { nowStrip, scheduleBar, scheduleColumn } from "./schedule-parts.js";
import { scheduledTopics } from "./schedules.js";
import { lifecycleSettings, queueCards, undelivered, waitingCount } from "./cards.js";
import { usagePanel } from "./usage.js";
function shownOf(page, view) {
    return shownTopics(view, resolveFilter(page.filter, view.hashtags.hashtags));
}
const RECENT_SUMMARIES = 12;
function lightCounts(agents) {
    return Object.keys(LIGHT_LABEL)
        .map((name) => ({ name, count: agents.filter((agent) => agent.light === name).length }))
        .filter((entry) => entry.count > 0)
        .map((entry) => h("span", {}, h("span", { class: `dot l-${entry.name}` }), String(entry.count)));
}
/** Which fields a keyword matched in, under a topic's card. */
function matchedFields(shown, id) {
    const fields = shown?.get(id) ?? [];
    return fields.length === 0
        ? null
        : h("div", { class: "note matched" }, `符合：${fields.join("、")}`);
}
function topicCard(view, actions, id, shown) {
    const topic = view.topics[id];
    if (topic === undefined)
        return null;
    const agents = view.agents.filter((agent) => agent.topic === id);
    const own = view.holds.filter((hold) => hold.topic === id);
    const deciding = own.filter(inFront).length;
    const turns = own.filter((hold) => hold.waits_turn).length;
    const doing = liveTodos(view, id).filter(needsCaptain).length;
    const waiting = view.queued.filter((item) => item.topic === id).length;
    const unsent = view.writes.filter((write) => write.topic === id && BAD_WRITES.includes(write.state)).length;
    return h("div", { class: "card topic", draggable: "true", "data-topic": id }, 
    // Shown on a touch screen only: a long press on it drags the card (board.ts, touch.ts).
    h("span", { class: "handle", role: "img", "aria-label": "按住拖曳" }, "⠿"), h("button", { class: "link name", onclick: () => actions.open(id) }, topic.name), h("div", { class: "meta" }, h("span", {}, `${agents.length} 個 agent`), lightCounts(agents), waiting > 0 ? h("span", {}, `排隊 ${waiting}`) : null, doing > 0 ? h("span", { class: "pill red" }, `要你動手 ${doing}`) : null, deciding > 0 ? h("span", { class: "pill red" }, `待你決定 ${deciding}`) : null, turns > 0 ? h("span", { class: "pill" }, `決定排隊 ${turns}`) : null, topic.close_reason === null ? null : h("span", { class: "pill warn" }, "提議關閉"), unsent > 0 ? h("span", { class: "pill red" }, `沒送到 ${unsent}`) : null), topicChips(view, id), matchedFields(shown, id));
}
/**
 * The topics a queue box lists: those the filter shows, without the scheduled
 * ones, which stay in 待辦 but are listed under 排程 and cannot be dragged.
 */
function queueTopics(view, queue, shown) {
    const scheduled = scheduledTopics(view.schedules);
    return view.queues[queue].filter((id) => isShown(shown, id) && !scheduled.has(id));
}
/**
 * A queue's box, its cards in `order`. `data-filtered` says whether a filter
 * is on and `data-by-time` whether the cards are listed by creation time,
 * which the drop reads.
 */
function queueBox(view, actions, queue, shown, order) {
    const createdAt = (id) => view.topics[id]?.created_at ?? "";
    const listed = sortCards(queueTopics(view, queue, shown), order, createdAt);
    const unlisted = view.queues[queue].length - listed.length;
    const byTime = order !== "priority";
    return h("div", {
        class: "queue",
        "data-queue": queue,
        "data-filtered": String(shown !== null),
        "data-by-time": String(byTime),
    }, h("h3", {}, queue === "later" ? "待辦（不自動開工）" : QUEUE_LABEL[queue]), h("div", { class: "list" }, listed.map((id) => topicCard(view, actions, id, shown)), h("div", { class: "empty" }, dropHint(listed.length, unlisted, shown !== null, byTime))));
}
function archivedBox(view, actions, shown) {
    const archived = Object.entries(view.topics).filter(([id, topic]) => topic.status === "archived" && isShown(shown, id));
    return h("details", { "data-key": "archived" }, h("summary", {}, `已封存 ${archived.length}`), archived.map(([id, topic]) => h("div", { class: "card" }, h("button", { class: "link", onclick: () => actions.open(id) }, topic.name), h("div", { class: "goal" }, topic.goal), h("div", { class: "btns" }, h("button", { onclick: () => actions.topic("reopen", { id }) }, "重開（放「一般」）")))));
}
const ORDER_LABEL = {
    priority: "照優先順序",
    newest: "新的在上",
    oldest: "舊的在上",
};
/** The three orders the queues' cards can be listed in, and what the chosen one means. */
function orderButtons(page, view, actions, order) {
    const saved = view.hashtags.views.find((entry) => entry.id === page.filter.view);
    return h("div", { class: "order" }, h("div", { class: "btns" }, h("span", { class: "note" }, "排列："), Object.keys(ORDER_LABEL).map((entry) => h("button", { class: entry === order ? "primary" : "", onclick: () => actions.setOrder(entry) }, ORDER_LABEL[entry]))), order === "priority"
        ? null
        : h("p", { class: "note" }, "照建立時間排列只改顯示的順序，優先順序與派工不變；拖到別的佇列會排在那裡的最後。"), saved === undefined ? null : h("p", { class: "note" }, `排列記在視圖「${saved.name}」`));
}
const SEGMENT_LABEL = { ...QUEUE_LABEL, schedules: "排程" };
/** On a narrow screen, the buttons that choose the one box the 佇列 tab shows, each with its count. */
function segmentButtons(page, actions, counts) {
    return h("div", { class: "segs" }, Object.keys(SEGMENT_LABEL).map((segment) => h("button", {
        class: segment === page.segment ? "on" : "",
        "data-segment": segment,
        onclick: () => actions.setSegment(segment),
    }, SEGMENT_LABEL[segment], h("span", { class: "count" }, String(counts[segment])))));
}
/** 佇列: the left column on a wide screen. 用量 heads it there; on a narrow screen it is under 更多. */
function sidebar(page, view, actions, shown) {
    const order = cardOrder(page, view.hashtags.views);
    const scheduled = (id) => isShown(shown, id) && view.topics[id]?.status !== "archived";
    const counts = {
        high: queueTopics(view, "high", shown).length,
        normal: queueTopics(view, "normal", shown).length,
        later: queueTopics(view, "later", shown).length,
        schedules: view.schedules.series.filter((card) => scheduled(card.topic)).length,
    };
    return h("div", { id: "sidebar", "data-segment": page.segment }, usagePanel(view.metrics, Date.now()), h("h2", {}, "優先順序"), segmentButtons(page, actions, counts), orderButtons(page, view, actions, order), nowStrip(page, view, actions), QUEUES.map((queue) => queueBox(view, actions, queue, shown, order)), scheduleColumn(view, actions, scheduled), archivedBox(view, actions, shown));
}
function section(title, ...children) {
    const content = children
        .flat(4)
        .filter((child) => child !== null && child !== undefined && child !== false);
    return h("section", {}, h("h2", {}, title), content.length > 0 ? content : h("p", { class: "note" }, "目前沒有。"));
}
const UNSORTED_REASON = {
    "no-tag": "沒有標記",
    "unknown-topic": "標記的議題不存在",
};
/** A menu that starts merging `from` into the chosen topic. */
export function mergeMenu(view, actions, from, key) {
    const choose = (event) => {
        const into = event.target.value;
        if (into !== "")
            actions.ask(key, "topics/merge", { from, into });
    };
    return h("select", { class: "auto", onchange: choose }, h("option", { value: "" }, "併入其他議題…"), QUEUES.flatMap((queue) => view.queues[queue])
        .filter((id) => id !== from)
        .map((id) => h("option", { value: id }, topicName(view, id))));
}
export function mergeConfirm(page, view, actions, key) {
    const pending = page.pending.get(key);
    if (pending === undefined)
        return null;
    const from = topicName(view, String(pending.body["from"]));
    const into = topicName(view, String(pending.body["into"]));
    return h("div", { class: "confirm" }, `併入之後不能拆開，「${from}」的 agent 與更新都會顯示在「${into}」底下。`, mergeTagNote(view, String(pending.body["from"]), String(pending.body["into"])), h("div", { class: "btns" }, h("button", { class: "danger", onclick: () => actions.confirm(key) }, `併入「${into}」`), h("button", { onclick: () => actions.cancel(key) }, "取消")));
}
function unsortedRow(view, actions, agent) {
    return h("div", { class: "row" }, h("span", { class: "grow" }, h("b", {}, agent.task), " ", h("span", { class: "note" }, UNSORTED_REASON[agent.unsorted_reason ?? ""] ?? "")), h("span", { class: "pill" }, agent.home), fileMenu(view, actions, agent, "歸併到…"));
}
/** The agents with no valid topic, split into running and finished. */
function untaggedAgents(view) {
    const untagged = view.agents.filter((agent) => agent.topic === null);
    return {
        open: untagged.filter((agent) => !agent.finished),
        finished: untagged.filter((agent) => agent.finished),
    };
}
/** The summaries with no topic that belong to one of `agents`. */
function summariesOf(view, agents) {
    const tasks = new Set(agents.map((agent) => `${agent.home}/${agent.task}`));
    return view.summaries.filter((summary) => summary.topic === null && tasks.has(`${summary.home}/${summary.task}`));
}
/**
 * Work, decisions, and questions that still need a topic, and below them,
 * folded, finished work that never got one: it waits for nothing.
 */
function unsorted(page, view, actions) {
    const { open, finished } = untaggedAgents(view);
    return section("未分類", open.map((agent) => unsortedRow(view, actions, agent)), summariesOf(view, open).map((summary) => summaryRow(view, actions, summary, false)), view.holds
        .filter((hold) => hold.topic === null && !hold.live)
        .map((hold) => holdCard(page, view, actions, hold, false)), view.questions
        .filter((question) => question.topic === null)
        .map((question) => questionRow(view, actions, question, false)), untaggedList(view), finishedList(view, actions, finished));
}
/** Finished work with no topic, folded: kept so its history can still be filed under a topic. */
function finishedList(view, actions, agents) {
    if (agents.length === 0)
        return null;
    return h("details", { "data-key": "finished:untagged" }, h("summary", {}, `已結束、沒標議題 ${agents.length}`), agents.map((agent) => unsortedRow(view, actions, agent)), summariesOf(view, agents).map((summary) => summaryRow(view, actions, summary, false)));
}
/** Queued work nobody gave a topic, folded: it is there to be noticed, not to crowd the page. */
function untaggedList(view) {
    const items = untaggedQueued(view);
    if (items.length === 0)
        return null;
    return h("details", { "data-key": "queued:untagged" }, h("summary", {}, `沒標議題的排隊項目 ${items.length}`), items.map(queuedRow));
}
/** Closed hands-on items that have no topic, folded as on a topic page; shown only when there is one. */
function noTopic(view) {
    const closed = view.closed_todos.filter((entry) => entry.topic === null);
    if (closed.length === 0)
        return null;
    return section("沒有議題", closedFold("closed-no-topic", closedTodoEntries("closed-no-topic", closed)));
}
/** 等你: what waits on the captain. */
function waitPart(page, view, actions, shown) {
    const todos = liveTodos(view).filter((todo) => isShown(shown, todo.topic));
    return [
        todos.length === 0
            ? null
            : section("要你動手", todos.map((todo) => todoCard(page, view, actions, todo, true))),
        shown === null ? noTopic(view) : null,
        section("等你決定", queueCards(page, view, actions, (topic) => isShown(shown, topic))),
        undelivered(page, actions),
    ];
}
/** 動態: what came back and what is under way. */
function activityPart(page, view, actions, shown) {
    const active = ["working", "stuck", "unknown", "decide"];
    const mine = (items) => items.filter((item) => isShown(shown, item.topic));
    return [
        section("最近的結果", mine(view.summaries)
            .slice(0, RECENT_SUMMARIES)
            .map((summary) => summaryRow(view, actions, summary, true))),
        section("進行中", mine(view.agents)
            .filter((agent) => agent.topic !== null && active.includes(agent.light))
            .map((agent) => agentRow(view, actions, agent))),
        section("排定的", queueTopics(view, "later", shown).map((id) => h("div", { class: "row" }, topicLink(view, id, actions), h("span", { class: "note" }, "待辦，不自動開工"))), mine(view.holds)
            .filter((hold) => !hold.live && hold.topic !== null)
            .map((hold) => holdCard(page, view, actions, hold, true))),
        shown === null ? unsorted(page, view, actions) : null,
    ];
}
/**
 * 更多: the programs waiting for the captain's confirmation first, then 用量
 * (shown here only on a narrow screen) and the settings.
 */
function morePart(page, view, actions, confirms) {
    return [
        confirms,
        usagePanel(view.metrics, Date.now()),
        hashtagBar(page, view, actions),
        scheduleBar(page, view, actions),
        lifecycleSettings(page, actions, view),
    ];
}
function waitingPill(view) {
    const count = waitingCount(view);
    return h("span", { class: count > 0 ? "count red" : "count" }, count);
}
function confirmDot(view) {
    return view.aggregator.confirm.length > 0
        ? h("span", { class: "dot-new", title: "有程式等你確認" })
        : null;
}
const TAB_LABEL = {
    wait: "等你",
    queue: "佇列",
    activity: "動態",
    more: "更多",
};
/**
 * The tabs: above the right column on a wide screen, where 佇列 is the left
 * column and has none, and at the bottom of a narrow one. 等你 always shows
 * its count; 更多 has a dot while a program waits for confirmation.
 */
function tabBar(page, view, actions) {
    const marks = {
        wait: waitingPill(view),
        queue: null,
        activity: null,
        more: confirmDot(view),
    };
    return h("nav", { class: "tabs" }, TABS.map((tab) => h("button", {
        class: tab === page.tab ? "on" : "",
        "data-tab": tab,
        onclick: () => actions.setTab(tab),
    }, TAB_LABEL[tab], marks[tab])));
}
function pane(tab, content) {
    return h("div", { class: "pane", "data-pane": tab }, content);
}
/** The home page; `confirms` are the programs waiting for the captain's confirmation (frame.ts). */
export function home(page, view, actions, confirms) {
    const shown = shownOf(page, view);
    return [
        page.open.has(FILTER_PANEL) ? filterPanel(page, view, actions) : null,
        h("div", { class: "side home", "data-tab": page.tab }, sidebar(page, view, actions, shown), h("div", { class: "tabbed" }, tabBar(page, view, actions), owedLine(view, actions, shown), pane("wait", waitPart(page, view, actions, shown)), pane("activity", activityPart(page, view, actions, shown)), pane("more", morePart(page, view, actions, confirms)))),
    ];
}
