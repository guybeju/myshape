import { getJson, postJson, takeToken } from "./api.js";
import { h, replaceChildren } from "./dom.js";
import { frame } from "./frame.js";
import { NO_FILTER, filterHash, parseFilterHash, viewFilter } from "./filter.js";
import { QUEUES, agentName, setAgentLabel } from "./state.js";
const POLL_MS = 5000;
const TOAST_MS = 6000;
const NOTIFY_SECONDS = 30;
const FAILURES_BEFORE_DOWN = 3;
const app = document.getElementById("app");
const toastBox = document.getElementById("toast");
const token = takeToken();
const page = {
    view: null,
    down: false,
    tokenBad: token === "",
    drafts: new Map(),
    pending: new Map(),
    editing: new Set(),
    panel: null,
    notice: null,
    filter: parseFilterHash(location.hash) ?? NO_FILTER,
    tagPanel: null,
};
/** Whether the page has applied a filter yet: the URL's, or the default view once the board names it. */
let filterChosen = parseFilterHash(location.hash) !== null;
let failures = 0;
/** The code the board ran when this page first heard from it. */
let loadedCommit = null;
let dragged = null;
let toastTimer;
/** What a redraw would otherwise lose: which input has focus, its caret, and the opened <details>. */
function uiState() {
    const active = document.activeElement;
    const focusKey = active?.getAttribute("data-key") ?? null;
    return {
        focusKey,
        caret: focusKey === null ? null : (active?.selectionStart ?? null),
        opened: [...app.querySelectorAll("details[open][data-key]")].map((element) => element.getAttribute("data-key") ?? ""),
    };
}
/** Redraws the page, keeping the focused input, its caret, and any opened <details>. */
function render() {
    if (dragged !== null)
        return;
    const { focusKey, caret, opened } = uiState();
    replaceChildren(app, frame(page, actions));
    for (const key of opened)
        app.querySelector(`details[data-key="${CSS.escape(key)}"]`)?.setAttribute("open", "");
    if (focusKey === null)
        return;
    const input = app.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
    input?.focus();
    if (caret !== null)
        input?.setSelectionRange(caret, caret);
}
function toast(text, countdownUntil) {
    window.clearInterval(toastTimer);
    const close = () => {
        window.clearInterval(toastTimer);
        replaceChildren(toastBox);
    };
    const draw = () => {
        const left = countdownUntil === undefined ? 0 : Math.ceil((countdownUntil - Date.now()) / 1000);
        if (countdownUntil !== undefined && left <= 0) {
            close();
            return;
        }
        replaceChildren(toastBox, h("div", { class: "card", onclick: close }, countdownUntil === undefined ? text : `${left} 秒後${text}`));
    };
    draw();
    if (countdownUntil === undefined)
        toastTimer = window.setTimeout(close, TOAST_MS);
    else
        toastTimer = window.setInterval(draw, 1000);
}
function accept(view) {
    loadedCommit ??= view.code_commit;
    // The board now runs other code: this page's scripts may not understand its data.
    if (view.code_commit !== loadedCommit) {
        location.reload();
        return;
    }
    setAgentLabel(view.aggregator.label);
    if (page.view !== null && page.view.boot_id !== view.boot_id && page.pending.size > 0) {
        page.pending.clear();
        page.notice = "看板服務重啟過，進行到一半的確認已作廢，請重做一次。";
    }
    page.view = view;
    if (!filterChosen) {
        // The board's default view applies once, when the page opens without a filter of its own.
        filterChosen = true;
        const { views, settings } = view.hashtags;
        const saved = views.find((entry) => entry.id === settings.default_view);
        if (saved !== undefined)
            keepFilter(viewFilter(saved));
    }
}
/** One failed poll; after a few in a row the page says the board is not answering. */
function pollFailed() {
    failures += 1;
    if (failures < FAILURES_BEFORE_DOWN || page.down)
        return;
    page.down = true;
    render();
}
function pollAnswered(reply) {
    failures = 0;
    const changed = reply.data["changed"] === true;
    const redraw = changed || page.down || reply.status === 401;
    page.down = false;
    page.tokenBad = reply.status === 401;
    if (changed)
        accept(reply.data);
    if (redraw)
        render();
}
async function poll() {
    if (page.tokenBad || document.hidden)
        return;
    const version = page.view === null ? "" : `${page.view.boot_id}:${page.view.version}`;
    try {
        pollAnswered(await getJson(token, `state?v=${encodeURIComponent(version)}`));
    }
    catch {
        pollFailed();
    }
}
/** Sends a change to the board. Returns the reply's data when the board accepted it. */
async function post(path, body) {
    if (page.down) {
        toast("看板服務沒有回應，這次沒有送出。");
        return null;
    }
    let reply;
    try {
        reply = await postJson(token, path, body);
    }
    catch {
        toast("連不上看板服務，這次沒有送出。");
        return null;
    }
    page.tokenBad = reply.status === 401;
    page.notice =
        reply.status === 200 ? null : String(reply.data["message"] ?? "看板拒絕了這個操作。");
    await poll();
    render();
    return reply.status === 200 ? reply.data : null;
}
function currentTopicHash() {
    return location.hash.startsWith("#/topic/") ? location.hash : null;
}
/** Shows the home page under `filter` and keeps it in the URL fragment, without a scroll or a history entry. */
/** Keeps `filter`, and puts it in the home page's URL fragment without a scroll or a history entry. */
function keepFilter(filter) {
    page.filter = filter;
    if (currentTopicHash() === null)
        history.replaceState(null, "", `${location.pathname}${filterHash(filter)}`);
}
function setFilter(filter) {
    keepFilter(filter);
    render();
}
function queueOf(topic) {
    return QUEUES.find((queue) => page.view?.queues[queue].includes(topic)) ?? null;
}
/** Says what a move will and will not do, so nobody expects work to start or stop at once. */
function moveFeedback(from, to) {
    if (from === "later" && to !== "later") {
        toast(`會通知 ${agentName()}；拖回「待辦」就不通知。`, Date.now() + NOTIFY_SECONDS * 1000);
    }
    else if (to === "later") {
        toast(`已移到「待辦」。已經在跑的 worker 不會停；還在排隊的項目要等 ${agentName()} 下次重新評估才會被停住。`);
    }
    else {
        toast(`順序已更新。${agentName()} 下次重新評估派工時才會照新順序，不會馬上開工。`);
    }
}
async function sendDraft(path, body, key) {
    const text = page.drafts.get(key) ?? "";
    if (text.trim() === "")
        return;
    if ((await post(path, { ...body, text })) !== null) {
        page.drafts.delete(key);
        render();
    }
}
const actions = {
    open: (topic) => {
        location.hash =
            topic === null ? filterHash(page.filter) : `#/topic/${encodeURIComponent(topic)}`;
    },
    refresh: () => void post("refresh", {}),
    draft: (key, value) => {
        page.drafts.set(key, value);
    },
    setPanel: (panel) => {
        page.panel = panel;
        render();
    },
    edit: (key, on) => {
        const [field, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
        const topic = page.view?.topics[id];
        if (on) {
            page.editing.add(key);
            page.drafts.set(key, (field === "name" ? topic?.name : topic?.goal) ?? "");
        }
        else {
            page.editing.delete(key);
            page.drafts.delete(key);
        }
        render();
    },
    topic: (op, body) => {
        void post(`topics/${op}`, body).then((data) => {
            if (data !== null && op === "reopen")
                moveFeedback("later", "normal");
        });
    },
    move: (topic, queue, before) => {
        const from = queueOf(topic);
        void post("topics/move", { id: topic, queue, ...(before === null ? {} : { before }) }).then((data) => {
            if (data !== null)
                moveFeedback(from, queue);
        });
    },
    ask: (key, path, body) => {
        void post(path, body).then((data) => {
            if (data === null || typeof data["confirm"] !== "string")
                return;
            page.pending.set(key, {
                path,
                body,
                confirm: data["confirm"],
                expiresAt: Number(data["expires_at"]),
                data,
            });
            render();
        });
    },
    confirm: (key) => {
        const pending = page.pending.get(key);
        if (pending === undefined)
            return;
        page.pending.delete(key);
        page.panel = null;
        void post(pending.path, { ...pending.body, confirm: pending.confirm }).then((data) => {
            if (data !== null && key.startsWith("answer:"))
                page.drafts.delete(key.replace("answer:", "answer-text:"));
            render();
        });
    },
    cancel: (key) => {
        if (key === "notice")
            page.notice = null;
        page.pending.delete(key);
        render();
    },
    claim: (task) => void post("todos/claim", { task }),
    message: (topic, key) => void sendDraft("messages", { topic }, key),
    direct: (home, task, key) => void sendDraft("direct", { home, task }, key),
    tag: (home, task, topic) => void post("agents/tag", { home, task, topic }),
    resend: (write) => {
        if (write.state === "unknown")
            actions.ask(`resend:${write.id}`, "writes/resend", { write_id: write.id });
        else
            void post("writes/resend", { write_id: write.id });
    },
    ignore: (write) => void post("writes/ignore", { write_id: write.id }),
    send: (path, body) => void post(path, body),
    setFilter,
    setTagPanel: (panel) => {
        page.tagPanel = panel;
        render();
    },
};
function topicCardAt(event) {
    return event.target.closest(".topic[data-topic]");
}
/** While dragging, the card itself is moved in the DOM so the order updates under the pointer. */
function dragOver(event) {
    if (dragged === null)
        return;
    const card = app.querySelector(".topic.dragging");
    const queue = event.target.closest(".queue");
    if (card === null || queue === null)
        return;
    event.preventDefault();
    const over = topicCardAt(event);
    const list = queue.querySelector(".list");
    if (over === null)
        list.insertBefore(card, list.querySelector(".empty"));
    else if (over !== card) {
        const box = over.getBoundingClientRect();
        over.parentElement?.insertBefore(card, event.clientY < box.top + box.height / 2 ? over : over.nextSibling);
    }
}
function drop(event) {
    const card = app.querySelector(".topic.dragging");
    const queue = card?.closest(".queue")?.dataset["queue"];
    if (dragged === null || card == null || queue === undefined)
        return;
    event.preventDefault();
    dragged.dropped = true;
    const next = card.nextElementSibling;
    actions.move(dragged.id, queue, next?.dataset["topic"] ?? null);
}
app.addEventListener("dragstart", (event) => {
    const card = topicCardAt(event);
    if (card === null || event.dataTransfer === null)
        return;
    dragged = { id: card.dataset["topic"] ?? "", dropped: false };
    event.dataTransfer.setData("text/plain", dragged.id);
    event.dataTransfer.effectAllowed = "move";
    card.classList.add("dragging");
    app.classList.add("dragging-now");
});
app.addEventListener("dragover", dragOver);
app.addEventListener("drop", drop);
app.addEventListener("dragend", () => {
    // Without a drop (Esc, or released outside a queue) the redraw puts the card back.
    dragged = null;
    app.classList.remove("dragging-now");
    render();
});
window.addEventListener("hashchange", () => {
    page.panel = null;
    const filter = parseFilterHash(location.hash);
    if (filter !== null)
        page.filter = filter;
    else if (location.hash === "")
        page.filter = NO_FILTER;
    render();
    window.scrollTo(0, 0);
});
document.addEventListener("visibilitychange", () => void poll());
window.setInterval(() => void poll(), POLL_MS);
window.setInterval(() => {
    // Keeps the confirmation countdown current and drops confirmations that ran out.
    if (page.pending.size === 0)
        return;
    for (const [key, pending] of page.pending) {
        if (pending.expiresAt <= Date.now())
            page.pending.delete(key);
    }
    render();
}, 1000);
render();
void poll();
