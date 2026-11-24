import { h } from "./dom.js";
import { agentRow, closedFold, closedTodoEntries, holdCard, liveTodos, todoCard, needsCaptain, queuedRow, questionRow, summaryRow, topicLink, topicName, untaggedQueued, } from "./parts.js";
import { BAD_WRITES, LIGHT_LABEL, QUEUES, QUEUE_LABEL, agentName } from "./state.js";
const RECENT_SUMMARIES = 12;
function lightCounts(agents) {
    return Object.keys(LIGHT_LABEL)
        .map((name) => ({ name, count: agents.filter((agent) => agent.light === name).length }))
        .filter((entry) => entry.count > 0)
        .map((entry) => h("span", {}, h("span", { class: `dot l-${entry.name}` }), String(entry.count)));
}
function topicCard(view, actions, id) {
    const topic = view.topics[id];
    if (topic === undefined)
        return null;
    const agents = view.agents.filter((agent) => agent.topic === id);
    const deciding = view.holds.filter((hold) => hold.topic === id && hold.live).length;
    const doing = liveTodos(view, id).filter(needsCaptain).length;
    const waiting = view.queued.filter((item) => item.topic === id).length;
    const unsent = view.writes.filter((write) => write.topic === id && BAD_WRITES.includes(write.state)).length;
    return h("div", { class: "card topic", draggable: "true", "data-topic": id }, h("button", { class: "link name", onclick: () => actions.open(id) }, topic.name), h("div", { class: "meta" }, h("span", {}, `${agents.length} 個 agent`), lightCounts(agents), waiting > 0 ? h("span", {}, `排隊 ${waiting}`) : null, doing > 0 ? h("span", { class: "pill red" }, `要你動手 ${doing}`) : null, deciding > 0 ? h("span", { class: "pill red" }, `待你決定 ${deciding}`) : null, topic.close_reason === null ? null : h("span", { class: "pill warn" }, "提議關閉"), unsent > 0 ? h("span", { class: "pill red" }, `沒送到 ${unsent}`) : null));
}
function queueBox(view, actions, queue) {
    return h("div", { class: "queue", "data-queue": queue }, h("h3", {}, queue === "later" ? "待辦（不自動開工）" : QUEUE_LABEL[queue]), h("div", { class: "list" }, view.queues[queue].map((id) => topicCard(view, actions, id)), h("div", { class: "empty" }, "拖到這裡")));
}
function archivedBox(view, actions) {
    const archived = Object.entries(view.topics).filter(([, topic]) => topic.status === "archived");
    return h("details", { "data-key": "archived" }, h("summary", {}, `已封存 ${archived.length}`), archived.map(([id, topic]) => h("div", { class: "card" }, h("button", { class: "link", onclick: () => actions.open(id) }, topic.name), h("div", { class: "goal" }, topic.goal), h("div", { class: "btns" }, h("button", { onclick: () => actions.topic("reopen", { id }) }, "重開（放「一般」）")))));
}
export function sidebar(view, actions) {
    return h("div", { id: "sidebar" }, h("h2", {}, "優先順序"), QUEUES.map((queue) => queueBox(view, actions, queue)), archivedBox(view, actions));
}
function closeProposals(view, actions) {
    return Object.entries(view.topics)
        .filter(([, topic]) => topic.close_reason !== null)
        .map(([id, topic]) => h("div", { class: "card" }, h("div", { class: "meta" }, topicLink(view, id, actions), h("span", { class: "pill warn" }, "提議關閉")), h("div", {}, `${agentName()} 認為這個議題可以關了：${topic.close_reason ?? ""}`), h("div", { class: "btns" }, h("button", { onclick: () => actions.topic("archive", { id }) }, "關閉並封存"), h("button", { onclick: () => actions.topic("keep", { id }) }, "先不關"))));
}
function section(title, ...children) {
    const content = children
        .flat(4)
        .filter((child) => child !== null && child !== undefined && child !== false);
    return h("section", {}, h("h2", {}, title), content.length > 0 ? content : h("p", { class: "note" }, "目前沒有。"));
}
function tagMenu(view, actions, agent) {
    const choose = (event) => {
        const topic = event.target.value;
        if (topic !== "")
            actions.tag(agent.home, agent.task, topic);
    };
    return h("select", { class: "auto", onchange: choose }, h("option", { value: "" }, "歸併到…"), QUEUES.flatMap((queue) => view.queues[queue]).map((id) => h("option", { value: id }, topicName(view, id))));
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
    return h("div", { class: "confirm" }, `併入之後不能拆開，「${from}」的 agent 與更新都會顯示在「${into}」底下。`, h("div", { class: "btns" }, h("button", { class: "danger", onclick: () => actions.confirm(key) }, `併入「${into}」`), h("button", { onclick: () => actions.cancel(key) }, "取消")));
}
function unsortedRow(view, actions, agent) {
    return h("div", { class: "row" }, h("span", { class: "grow" }, h("b", {}, agent.task), " ", h("span", { class: "note" }, UNSORTED_REASON[agent.unsorted_reason ?? ""] ?? "")), h("span", { class: "pill" }, agent.home), tagMenu(view, actions, agent));
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
export function home(page, view, actions) {
    const active = ["working", "stuck", "unknown", "decide"];
    return [
        liveTodos(view).length === 0
            ? null
            : section("要你動手", liveTodos(view).map((todo) => todoCard(page, view, actions, todo, true))),
        noTopic(view),
        section("等你決定", closeProposals(view, actions), view.holds
            .filter((hold) => hold.live)
            .map((hold) => holdCard(page, view, actions, hold, true))),
        section("最近的結果", view.summaries
            .slice(0, RECENT_SUMMARIES)
            .map((summary) => summaryRow(view, actions, summary, true))),
        section("進行中", view.agents
            .filter((agent) => agent.topic !== null && active.includes(agent.light))
            .map((agent) => agentRow(view, actions, agent))),
        section("排定的", view.queues.later.map((id) => h("div", { class: "row" }, topicLink(view, id, actions), h("span", { class: "note" }, "待辦，不自動開工"))), view.holds
            .filter((hold) => !hold.live && hold.topic !== null)
            .map((hold) => holdCard(page, view, actions, hold, true))),
        unsorted(page, view, actions),
    ];
}
