import { h } from "./dom.js";
import { BAD_WRITES, LIGHT_LABEL, QUEUES, WRITE_LABEL, agentName } from "./state.js";
const SUMMARY_LABEL = {
    ready: "就緒",
    report: "報告",
    failed: "失敗",
    landed: "落地",
};
const EVENT_LABEL = {
    "task.dispatched": "已派工",
    "task.status": "",
    "task.pr_ready": "PR 就緒",
    "task.merged": "已合併",
    "task.cleaned_up": "已清理",
};
function pad(value) {
    return String(value).padStart(2, "0");
}
export function when(epochSeconds) {
    const date = new Date(epochSeconds * 1000);
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** A PR link, only for http(s) URLs: the text comes from a ledger and must not become a script link. */
export function prLink(url) {
    if (url === null)
        return null;
    if (!/^https?:\/\//.test(url))
        return url;
    return h("a", { href: url, target: "_blank", rel: "noreferrer noopener" }, url);
}
export function topicName(view, topic) {
    return topic === null ? "未分類" : (view.topics[topic]?.name ?? topic);
}
export function topicLink(view, topic, actions) {
    if (topic === null)
        return h("span", { class: "pill" }, "未分類");
    return h("button", { class: "link", onclick: () => actions.open(topic) }, topicName(view, topic));
}
/** A text input whose content survives re-renders. */
export function draftInput(page, actions, key, placeholder, onEnter) {
    return h("input", {
        type: "text",
        "data-key": key,
        placeholder,
        value: page.drafts.get(key) ?? "",
        oninput: (event) => actions.draft(key, event.target.value),
        onkeydown: (event) => {
            if (event.key === "Enter" && onEnter !== undefined)
                onEnter();
        },
    });
}
function writeRow(page, actions, write) {
    const bad = BAD_WRITES.includes(write.state);
    const key = `resend:${write.id}`;
    const asking = page.pending.has(key);
    return h("div", { class: bad ? "wr bad" : "wr" }, h("span", { class: "pill" }, WRITE_LABEL[write.state] ?? write.state), " ", write.text, write.state === "retrying"
        ? h("span", { class: "note" }, `（第 ${write.attempt} 次重試）`)
        : null, write.error === null ? null : h("div", { class: "note" }, write.error), bad && !asking
        ? h("span", { class: "btns" }, h("button", { onclick: () => actions.resend(write) }, "重送"), h("button", { onclick: () => actions.ignore(write) }, "忽略"))
        : null, asking
        ? h("div", { class: "confirm" }, "這筆不知道有沒有送到，重送可能會重複送出。", h("span", { class: "btns" }, h("button", { class: "danger", onclick: () => actions.confirm(key) }, "還是重送"), h("button", { onclick: () => actions.cancel(key) }, "取消")))
        : null);
}
/** The status lines of the writes that match, newest first, shown where they were sent from. */
export function writeRows(page, actions, matches, limit = 5) {
    const writes = (page.view?.writes ?? []).filter((write) => matches(write) && write.state !== "ignored");
    return writes
        .toSorted((a, b) => b.created_at - a.created_at)
        .slice(0, limit)
        .map((write) => writeRow(page, actions, write));
}
/** What sending an answer will do to the item, in the words the card shows. */
function answerOutcomeText(hold) {
    const outcome = hold.on_answer === "close"
        ? "送出後這一項就結束，標成完成。"
        : `送出後解除等待，這一項回到排隊中，由 ${agentName()} 接著做。`;
    return hold.on_answer_recorded
        ? outcome
        : `${outcome}（開這個決定時沒有註明答了之後怎麼處理，所以照預設不結束它。）`;
}
function answerConfirm(page, actions, key, hold) {
    const pending = page.pending.get(key);
    if (pending === undefined)
        return null;
    const seconds = Math.max(0, Math.round((pending.expiresAt - Date.now()) / 1000));
    return h("div", { class: "confirm" }, h("div", {}, `你的答覆：「${String(pending.body["answer"])}」`), h("div", { class: "note" }, `會記成你的答覆並通知 ${agentName()}。看板自己不會合併或捨棄。這次確認還有 ${seconds} 秒有效。`), h("div", { class: "note outcome" }, answerOutcomeText(hold)), h("div", { class: "btns" }, h("button", { class: "danger", onclick: () => actions.confirm(key) }, "送出"), h("button", { onclick: () => actions.cancel(key) }, "取消")));
}
function holdMeta(view, actions, hold, showTopic) {
    return h("div", { class: "meta" }, showTopic ? topicLink(view, hold.topic, actions) : null, h("span", { class: "pill" }, hold.home), h("span", { class: "note" }, hold.task), hold.live ? null : h("span", { class: "pill warn" }, `暫緩：${hold.deferred_reason ?? ""}`), hold.stale ? h("span", { class: "pill warn" }, "可能已過時") : null);
}
/** True for a live decision shown now, with its answer buttons; not one waiting its turn. */
export function inFront(hold) {
    return hold.live && !hold.waits_turn;
}
/** A menu that files one task of one home under the chosen topic, by a tag write. */
export function fileMenu(view, actions, target, words) {
    const choose = (event) => {
        const topic = event.target.value;
        if (topic !== "")
            actions.tag(target.home, target.task, topic);
    };
    return h("select", { class: "auto", onchange: choose }, h("option", { value: "" }, words), QUEUES.flatMap((queue) => view.queues[queue]).map((id) => h("option", { value: id }, topicName(view, id))));
}
/** One backlog item that no worker has been dispatched for. */
export function queuedRow(item) {
    return h("div", { class: "meta" }, h("b", {}, item.task), h("span", {}, item.title), h("span", { class: "pill" }, item.home), h("span", { class: "note" }, item.waiting === null ? "可以派" : item.waiting));
}
/**
 * Queued work that has no topic and no card of its own. A captain hold is a
 * queued item too, but it already shows as a card wherever holds are listed.
 */
export function untaggedQueued(view) {
    const held = new Set(view.holds.map((hold) => `${hold.home}/${hold.task}`));
    return view.queued.filter((item) => item.topic === null && !held.has(`${item.home}/${item.task}`));
}
/** True for a hands-on item the captain still has to act on. */
export function needsCaptain(todo) {
    return todo.state !== "claimed";
}
/** The hands-on items, every one on the home page or a topic's own, the ones waiting on the captain first. */
export function liveTodos(view, topic) {
    const todos = view.todos.filter((todo) => topic === undefined || todo.topic === topic);
    return [...todos.filter(needsCaptain), ...todos.filter((todo) => !needsCaptain(todo))];
}
/** Copies one command; a browser that refuses gets that block selected, ready for the copy key. */
function copyCommand(command, block, button) {
    navigator.clipboard.writeText(command).then(() => {
        button.textContent = "已複製";
    }, () => {
        getSelection()?.selectAllChildren(block);
        button.textContent = "已選取，請按 Ctrl+C（Mac 是 ⌘C）";
    });
}
/** One command in its own block, with a button that copies exactly that command. */
function commandBlock(command) {
    const block = h("pre", { class: "cmd" }, command);
    return h("div", { class: "cmd-row" }, block, h("button", { onclick: (event) => copyCommand(command, block, event.currentTarget) }, "複製指令"));
}
const TODO_NOTE = {
    open: () => null,
    claimed: () => h("div", { class: "wr" }, `你已按做完了，等 ${agentName()} 驗證`),
    rejected: (reason) => h("div", { class: "wr bad" }, `${agentName()} 驗證沒過：${reason}`),
    obsolete: (reason) => h("div", { class: "wr" }, `${agentName()}：不再需要了。${reason}`),
    unknown: (word) => h("div", { class: "wr bad" }, `看板不認得這個項目的狀態：${word}`),
};
/** Where an item stands, with the word todos.json holds for a state the board does not know. */
function todoNote(todo) {
    return TODO_NOTE[todo.state](todo.state === "unknown" ? (todo.unknown_state ?? "") : (todo.reason ?? ""));
}
function todoButtons(actions, todo, key) {
    const close = (route, answer) => actions.ask(key, route, { task: todo.task, answer });
    if (todo.state === "claimed")
        return null;
    if (todo.state === "unknown")
        return h("div", { class: "btns" }, h("button", { onclick: () => close("todos/drop", "不做了") }, "不做了"));
    if (todo.state === "obsolete")
        return h("div", { class: "btns" }, h("button", { onclick: () => close("todos/takedown", "撤下") }, "好，撤下"));
    return h("div", { class: "btns" }, h("button", { onclick: () => actions.claim(todo.task) }, "做完了"), h("button", { onclick: () => close("todos/drop", "不做了") }, "不做了"));
}
function todoConfirm(page, actions, key) {
    const pending = page.pending.get(key);
    if (pending === undefined)
        return null;
    return h("div", { class: "confirm" }, `會記成你的答覆「${String(pending.body["answer"])}」，這一項就從看板拿掉，並通知 ${agentName()}。`, h("div", { class: "btns" }, h("button", { class: "danger", onclick: () => actions.confirm(key) }, "確定"), h("button", { onclick: () => actions.cancel(key) }, "取消")));
}
/** Something the captain has to do by hand: what, any guidance, each command to copy, and where it stands. */
export function todoCard(page, view, actions, todo, showTopic) {
    const key = `todo:${todo.task}`;
    return h("div", { class: "card todo", "data-todo": todo.task }, h("div", { class: "meta" }, showTopic ? topicLink(view, todo.topic, actions) : null, h("span", { class: "note" }, todo.task)), h("b", {}, todo.title), todoNote(todo), h("div", {}, todo.what), todo.guidance === "" ? null : h("div", { class: "guide" }, todo.guidance), todo.commands.map(commandBlock), todoButtons(actions, todo, key), todoConfirm(page, actions, key));
}
export function holdCard(page, view, actions, hold, showTopic) {
    const key = `answer:${hold.home}/${hold.task}`;
    const draftKey = `answer-text:${hold.home}/${hold.task}`;
    const ask = (answer, label) => {
        if (answer.trim() !== "")
            actions.ask(key, "holds/answer", {
                home: hold.home,
                task: hold.task,
                answer: answer.trim(),
                label,
            });
    };
    const askTyped = () => ask(page.drafts.get(draftKey) ?? "", "文字作答");
    return h("div", { class: "card" }, holdMeta(view, actions, hold, showTopic), h("b", {}, hold.title), h("pre", { class: "q" }, hold.question), h("div", { class: "btns" }, hold.options.map((option) => h("button", { onclick: () => ask(option, option) }, option))), h("div", { class: "btns" }, draftInput(page, actions, draftKey, "用文字回答", askTyped), h("button", { onclick: askTyped }, "送出")), answerConfirm(page, actions, key, hold), writeRows(page, actions, (write) => write.kind === "answer" && write.home === hold.home && write.task === hold.task));
}
export function questionRow(view, actions, question, showTopic) {
    return h("div", { class: "row" }, h("span", { class: "pill" }, `${agentName()} 處理中`), h("span", { class: "grow" }, `${question.home}/${question.task}：${question.summary}`), showTopic ? topicLink(view, question.topic, actions) : null);
}
export function light(agent) {
    return [h("span", { class: `dot l-${agent.light}` }), LIGHT_LABEL[agent.light] ?? agent.light];
}
/** What to say about a worker whose harness has not taken its first turn. */
function unstartedNote(agent) {
    const since = agent.updated_at === null ? "" : `${when(agent.updated_at)} 派出後`;
    return `${since}還沒開始第一輪，停太久就是卡在啟動畫面`;
}
export function agentRow(view, actions, agent) {
    return h("div", { class: "row" }, h("span", {}, light(agent)), h("span", { class: "grow" }, h("b", {}, agent.task), " ", h("span", { class: "note" }, `${agent.state} ${agent.detail}`), agent.unstarted ? [" ", h("span", { class: "pill warn" }, unstartedNote(agent))] : null), h("span", { class: "pill" }, agent.home), agent.stale ? h("span", { class: "pill warn" }, "資料過期") : null, topicLink(view, agent.topic, actions));
}
export function summaryRow(view, actions, summary, showTopic) {
    return h("div", { class: summary.kind === "failed" ? "upd summary failed" : "upd summary" }, h("span", { class: "t" }, when(summary.ts)), h("span", { class: "pill" }, SUMMARY_LABEL[summary.kind] ?? summary.kind), " ", showTopic ? [topicLink(view, summary.topic, actions), " "] : null, h("span", { class: "note" }, `${summary.home}/${summary.task}`), h("div", {}, summary.text), prLink(summary.pr));
}
export function updateRow(update) {
    const ledger = update.source === "ledger";
    const label = ledger ? (EVENT_LABEL[update.event] ?? update.event) : "";
    return h("div", { class: ledger ? "upd" : "upd system" }, h("span", { class: "t" }, when(update.ts)), update.task === null
        ? null
        : h("span", { class: "note" }, `${update.home ?? ""}/${update.task} `), [label, update.text].filter((part) => part !== "").join(" "), update.pr === null ? null : [" ", prLink(update.pr)]);
}
/** One closed thing: its closing line, opening to every record of its life on the board. */
function closedRow(entry) {
    return h("details", { class: "closed", "data-key": entry.key }, h("summary", {}, h("span", { class: "t" }, when(entry.ts)), entry.task === null
        ? null
        : h("span", { class: "note" }, `${entry.home ?? ""}/${entry.task} `), entry.text), entry.records.map(updateRow));
}
/** 已關 N: what closed, folded by default, newest first; nothing when nothing closed. */
export function closedFold(key, entries) {
    if (entries.length === 0)
        return null;
    return h("details", { "data-key": key }, h("summary", {}, `已關 ${entries.length}`), entries.map(closedRow));
}
/** The closed hands-on items as fold rows, each row's key starting with `prefix`. */
export function closedTodoEntries(prefix, closed) {
    return closed.map((entry) => ({
        key: `${prefix}:${entry.item}:${entry.ts}`,
        ts: entry.ts,
        home: null,
        task: null,
        text: entry.text,
        records: entry.records,
    }));
}
/** The agent's recent changes, each with 撤回 (or 已撤回), and one 看過了 for them all. */
export function recentCard(view, actions, list) {
    return h("div", { class: "card" }, h("h3", {}, list.title), list.changes.map((change) => h("div", { class: "row" }, h("span", { class: "t note" }, when(change.ts)), h("span", { class: "grow" }, change.text), change.topic === null ? null : topicLink(view, change.topic, actions), change.reverted
        ? h("span", { class: "note" }, "已撤回")
        : h("button", { onclick: () => actions.send(list.revert, { rid: change.rid }) }, "撤回"))), h("div", { class: "btns" }, h("button", { onclick: () => actions.send(list.seen, {}) }, "看過了")));
}
/** Each setting with its current value, its default and the control that changes it. */
export function settingsTable(rows) {
    return h("table", { class: "settings" }, h("tr", {}, h("th", {}, "設定"), h("th", {}, "現在"), h("th", {}, "預設"), h("th", {}, "")), rows.map((row) => h("tr", {}, h("td", {}, row.label), h("td", { "data-label": "現在" }, row.current), h("td", { "data-label": "預設" }, row.fallback), h("td", {}, row.control))));
}
