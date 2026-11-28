import { getJson, postJson, takeToken, tokenInHash } from "./api.js";
import { h, replaceChildren } from "./dom.js";
import { dropPlace } from "./drop.js";
import { frame } from "./frame.js";
import { NO_FILTER, filterHash, parseFilterHash, parseTab, viewFilter } from "./filter.js";
import { ORDER_KEY, parseOrder } from "./sort.js";
import { QUEUES, agentName, currentTopic, setAgentLabel } from "./state.js";
import { indexAt, listenForTouchDrag } from "./touch.js";
const POLL_MS = 5000;
/** How often the 用量 panel is redrawn so its times stay current. */
const USAGE_REDRAW_MS = 30_000;
const TOAST_MS = 6000;
const NOTIFY_SECONDS = 30;
const FAILURES_BEFORE_DOWN = 3;
/** The page's own card order; a browser that will not lend its storage lists by priority. */
function storedOrder() {
    try {
        return parseOrder(localStorage.getItem(ORDER_KEY));
    }
    catch (error) {
        console.warn("myshape: localStorage cannot be read, so the cards are listed by priority", error);
        return "priority";
    }
}
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
    tab: parseTab(location.hash),
    segment: "high",
    order: storedOrder(),
    tagPanel: null,
    schedulePanel: null,
    open: new Set(),
};
/** Whether the page has applied a filter yet: the URL's, or the default view once the board names it. */
let filterChosen = parseFilterHash(location.hash) !== null;
let failures = 0;
/** The code the board ran when this page first heard from it. */
let loadedCommit = null;
/** The card being dragged, and where it was when the drag started. */
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
/** Puts the filter and the tab in the home page's URL fragment, without a scroll or a history entry. */
function keepHash() {
    if (currentTopicHash() === null)
        history.replaceState(null, "", `${location.pathname}${filterHash(page.filter, page.tab)}`);
}
function keepFilter(filter) {
    page.filter = filter;
    keepHash();
}
function setFilter(filter) {
    keepFilter(filter);
    render();
}
/** Like the filter, a tab adds no history entry: the browser's back still leaves the page. */
function setTab(tab) {
    page.tab = tab;
    keepHash();
    render();
    window.scrollTo(0, 0);
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
            topic === null ? filterHash(page.filter, page.tab) : `#/topic/${encodeURIComponent(topic)}`;
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
    move: (topic, queue, anchor) => {
        const from = queueOf(topic);
        const where = "last" in anchor ? {} : anchor;
        void post("topics/move", { id: topic, queue, ...where }).then((data) => {
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
    setTab,
    setSegment: (segment) => {
        page.segment = segment;
        render();
    },
    setOrder: (order) => {
        // A chosen saved view keeps its own order; otherwise this page does (spec/card-sort.markdown).
        const saved = page.view?.hashtags.views.find((entry) => entry.id === page.filter.view);
        if (saved !== undefined) {
            const { id, name, any, none, text, untagged } = saved;
            void post("views/save", { id, name, any, none, text, untagged, order });
            return;
        }
        page.order = order;
        render();
        localStorage.setItem(ORDER_KEY, order);
    },
    setTagPanel: (panel) => {
        page.tagPanel = panel;
        render();
    },
    setSchedulePanel: (panel) => {
        page.schedulePanel = panel;
        render();
    },
    toggle: (key) => {
        if (!page.open.delete(key))
            page.open.add(key);
        render();
    },
};
function topicCardAt(event) {
    return event.target.closest(".topic[data-topic]");
}
/** The topic of a card in a queue's list; null for the drop hint or no card at all. */
function topicOf(element) {
    return element === null ? null : element.getAttribute("data-topic");
}
/** Where a card sits in its queue's list as the page shows it. */
function slotOf(card) {
    const queue = card.closest(".queue")?.dataset["queue"];
    if (queue === undefined)
        return null;
    return {
        queue,
        above: topicOf(card.previousElementSibling),
        below: topicOf(card.nextElementSibling),
    };
}
/** The cards a queue's box lists, without the one being dragged. */
function othersIn(box, card) {
    const cards = box?.querySelectorAll(".topic[data-topic]") ?? [];
    return [...cards].filter((entry) => entry !== card);
}
/** The last card a queue lists, not counting the dragged one: a segment drop lands after it. */
function lastIn(queue, card) {
    const box = app.querySelector(`.queue[data-queue="${CSS.escape(queue)}"]`);
    return topicOf(othersIn(box, card).at(-1) ?? null);
}
/**
 * What a drop on `element` lands on: a segment button, or a queue's list at
 * the card's place in it. A box the card is not in (listed by creation time
 * it stays where it was) is a drop at that list's end.
 */
function targetAt(element, card) {
    return segmentAt(element, card) ?? listAt(element, card);
}
function segmentAt(element, card) {
    const button = element?.closest(".segs button[data-segment]");
    const segment = button?.dataset["segment"];
    return segment === undefined ? null : { kind: "segment", segment, last: lastIn(segment, card) };
}
function listAt(element, card) {
    const box = element?.closest(".queue[data-queue]") ?? null;
    if (box === null)
        return null;
    const queue = box.dataset["queue"];
    const slot = box.contains(card) ? slotOf(card) : null;
    return { kind: "list", slot: slot ?? { queue, above: lastIn(queue, card), below: null } };
}
/**
 * How the queues list their cards, which the drop reads: under a filter
 * (spec/drag-under-filter.markdown), by creation time (spec/card-sort.markdown).
 */
function listingOf(card) {
    const box = card.closest(".queue");
    return {
        filtered: box?.dataset["filtered"] === "true",
        byTime: box?.dataset["byTime"] === "true",
    };
}
function placeAt(target, card, start) {
    return dropPlace(start, target, listingOf(card));
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
    // Listed by creation time, a place in the list is no priority: the card stays where it was.
    if (queue.dataset["byTime"] === "true")
        return;
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
    if (dragged === null || card === null)
        return;
    const target = targetAt(event.target, card);
    if (target === null)
        return;
    event.preventDefault();
    const place = placeAt(target, card, dragged.start);
    if (place !== null)
        actions.move(dragged.id, place.queue, place.anchor);
}
function startDrag(card, start) {
    dragged = { id: card.dataset["topic"] ?? "", start };
    card.classList.add("dragging");
    app.classList.add("dragging-now");
}
/** Without a drop (Esc, or let go outside a queue) the redraw puts the card back. */
function endDrag() {
    dragged = null;
    app.classList.remove("dragging-now");
    render();
}
app.addEventListener("dragstart", (event) => {
    const card = topicCardAt(event);
    const start = card === null ? null : slotOf(card);
    if (card === null || start === null || event.dataTransfer === null)
        return;
    startDrag(card, start);
    event.dataTransfer.setData("text/plain", card.dataset["topic"] ?? "");
    event.dataTransfer.effectAllowed = "move";
});
app.addEventListener("dragover", dragOver);
app.addEventListener("drop", drop);
app.addEventListener("dragend", endDrag);
/** A finger places the card by height alone: a box's title or a gap between cards is no jump. */
function slideCard(card, element, y) {
    // Listed by creation time, a place in the list is no priority: the card stays where it was.
    const box = element?.closest('.queue[data-by-time="false"]') ?? null;
    const list = box?.querySelector(".list") ?? null;
    if (box === null || list === null)
        return;
    const others = othersIn(box, card);
    const at = indexAt(others.map(middleOf), y);
    list.insertBefore(card, others[at] ?? list.querySelector(".empty"));
}
function middleOf(element) {
    const box = element.getBoundingClientRect();
    return box.top + box.height / 2;
}
/** Marks the segment button under the finger when letting go there would move the card. */
function markDrop(card, element, start) {
    for (const button of app.querySelectorAll(".segs button.drop"))
        button.classList.remove("drop");
    const target = targetAt(element, card);
    if (target?.kind !== "segment" || placeAt(target, card, start) === null)
        return;
    element?.closest(".segs button")?.classList.add("drop");
}
/** The top of the tab bar where it is fixed at the window's bottom (a phone); else the window's bottom. */
function bottomBar() {
    const tabs = app.querySelector(".tabs")?.getBoundingClientRect();
    const fixed = tabs !== undefined && tabs.bottom >= window.innerHeight - 1;
    return fixed ? tabs.top : window.innerHeight;
}
/** The part of the window between the sticky header and, on a phone, the tab bar at the bottom. */
function band() {
    const header = document.querySelector("header")?.getBoundingClientRect().bottom ?? 0;
    return { top: Math.max(0, header), bottom: bottomBar() };
}
/** The card a finger lifted and where it started; null when no card is lifted. */
function lifted() {
    const card = app.querySelector(".topic.dragging");
    return dragged === null || card === null ? null : { card, ...dragged };
}
function liftCard(card) {
    const start = slotOf(card);
    if (start === null)
        return false;
    startDrag(card, start);
    card.classList.add("lifted");
    return true;
}
function fingerAt(x, y) {
    const held = lifted();
    if (held === null)
        return;
    const element = document.elementFromPoint(x, y);
    slideCard(held.card, element, y);
    markDrop(held.card, element, held.start);
}
function fingerUp(x, y) {
    const held = lifted();
    const target = held === null ? null : targetAt(document.elementFromPoint(x, y), held.card);
    const place = held === null || target === null ? null : placeAt(target, held.card, held.start);
    if (held !== null && place !== null)
        actions.move(held.id, place.queue, place.anchor);
    endDrag();
}
listenForTouchDrag(app, { lift: liftCard, hover: fingerAt, release: fingerUp, cancel: endDrag }, band);
window.addEventListener("hashchange", () => {
    // A link from `open` pasted into this tab changes only the fragment; loading
    // the page again takes its token the way the first load does.
    if (tokenInHash(location.hash) !== null) {
        location.reload();
        return;
    }
    page.panel = null;
    if (currentTopicHash() === null) {
        page.filter = parseFilterHash(location.hash) ?? NO_FILTER;
        page.tab = parseTab(location.hash);
    }
    render();
    window.scrollTo(0, 0);
});
document.addEventListener("visibilitychange", () => void poll());
window.setInterval(() => void poll(), POLL_MS);
window.setInterval(() => {
    // The 用量 panel writes its times relative to now; nothing the board sends changes them.
    if (document.hidden || currentTopic() !== null || (page.view?.metrics.length ?? 0) === 0)
        return;
    render();
}, USAGE_REDRAW_MS);
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
