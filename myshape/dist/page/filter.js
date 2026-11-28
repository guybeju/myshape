export const NO_FILTER = { any: [], none: [], untagged: false, text: "", view: null };
const PREFIX = "#/f/";
export const TABS = ["wait", "queue", "activity", "more"];
/** The fragment's keys that belong to the filter; `tab` is the only other one. */
const FILTER_KEYS = ["any", "none", "untagged", "text", "view"];
export function isActive(filter) {
    return (filter.any.length > 0 || filter.none.length > 0 || filter.untagged || filter.text.trim() !== "");
}
function list(value) {
    return value === null || value === "" ? [] : value.split(",").filter((name) => name !== "");
}
function queryOf(hash) {
    return hash.startsWith(PREFIX) ? new URLSearchParams(hash.slice(PREFIX.length)) : null;
}
/**
 * The filter in a URL fragment (`#/f/any=A,B&none=C&untagged=1&text=gpu&view=w`),
 * or null when the fragment names no part of a filter, such as one with only a tab.
 */
export function parseFilterHash(hash) {
    const query = queryOf(hash);
    if (query === null || !FILTER_KEYS.some((name) => query.has(name)))
        return null;
    return {
        any: list(query.get("any")),
        none: list(query.get("none")),
        untagged: query.get("untagged") === "1",
        text: query.has("text") ? String(query.get("text")) : "",
        view: query.get("view"),
    };
}
/** The tab in a URL fragment (`#/f/…&tab=queue`); 等你 when it names none or one the page lacks. */
export function parseTab(hash) {
    const named = queryOf(hash)?.get("tab");
    return TABS.find((tab) => tab === named) ?? "wait";
}
/** True when the captain chose a filter or a saved view: the header's 篩選 says so. */
export function hasFilter(filter) {
    return isActive(filter) || filter.view !== null;
}
/** The fragment's filter part; empty for no filter. */
function filterQuery(filter) {
    const query = new URLSearchParams();
    if (!hasFilter(filter))
        return query;
    if (filter.any.length > 0)
        query.set("any", filter.any.join(","));
    if (filter.none.length > 0)
        query.set("none", filter.none.join(","));
    if (filter.untagged)
        query.set("untagged", "1");
    if (filter.text !== "")
        query.set("text", filter.text);
    if (filter.view !== null)
        query.set("view", filter.view);
    return query;
}
/** The home page's URL fragment for `filter` and `tab`; empty for no filter on 等你. */
export function filterHash(filter, tab) {
    const query = filterQuery(filter);
    if (tab !== "wait")
        query.set("tab", tab);
    return query.size === 0 ? "" : `${PREFIX}${query.toString()}`;
}
export function viewFilter(view) {
    return {
        any: [...view.any],
        none: [...view.none],
        untagged: view.untagged,
        text: view.text,
        view: view.id,
    };
}
/** What a hashtag button does next: off, then 有, then 沒有, then off. */
export function cycleHashtag(filter, name) {
    const any = filter.any.filter((entry) => entry !== name);
    const none = filter.none.filter((entry) => entry !== name);
    if (filter.any.includes(name))
        none.push(name);
    else if (!filter.none.includes(name))
        any.push(name);
    return { ...filter, any, none, view: null };
}
function key(name) {
    return name.normalize("NFKC").toLowerCase();
}
/** `filter` with its hashtag names as the board spells them; names the board lacks are dropped. */
export function resolveFilter(filter, known) {
    const shown = new Map(known.map((entry) => [key(entry.name), entry.name]));
    const resolve = (names) => [
        ...new Set(names.flatMap((name) => {
            const found = shown.get(key(name));
            return found === undefined ? [] : [found];
        })),
    ];
    return { ...filter, any: resolve(filter.any), none: resolve(filter.none) };
}
/** True when a topic with these hashtags passes the hashtag part of the filter. */
export function hashtagsPass(tags, filter) {
    if (filter.untagged && tags.length > 0)
        return false;
    if (filter.any.length > 0 && !filter.any.some((name) => tags.includes(name)))
        return false;
    return !filter.none.some((name) => tags.includes(name));
}
/** A topic's hashtags; none when it has none. */
function tagsOf(source, id) {
    return Object.hasOwn(source.hashtags.topics, id) ? source.hashtags.topics[id] : [];
}
/** Every text the page shows about a topic, by the field it is shown in. */
function topicTexts(source, id, topic) {
    const mine = (items) => items.filter((item) => item.topic === id);
    return [
        ["名稱", topic.name],
        ["目標", topic.goal],
        ["議題 id", id],
        ["提議關閉", topic.close_reason === null ? "" : topic.close_reason],
        ["hashtag", tagsOf(source, id).join(" ")],
        ...mine(source.agents).map((agent) => [
            "agent",
            `${agent.task} ${agent.state} ${agent.detail}`,
        ]),
        ...mine(source.queued).map((item) => [
            "排隊項目",
            `${item.task} ${item.title}`,
        ]),
        ...mine(source.holds).map((hold) => [
            "待決事項",
            `${hold.title} ${hold.question}`,
        ]),
        ...mine(source.questions).map((question) => [
            "worker 提問",
            question.summary,
        ]),
        ...mine(source.todos).map((todo) => [
            "要你動手",
            `${todo.title} ${todo.what}`,
        ]),
        ...mine(source.summaries).map((summary) => ["摘要", summary.text]),
    ];
}
/**
 * Whether the topic `id` is shown under `filter`: null when it is not, else
 * the fields the keyword matched in (empty when there is no keyword).
 */
export function topicMatch(source, id, filter) {
    const topic = source.topics[id];
    if (topic === undefined || !hashtagsPass(tagsOf(source, id), filter))
        return null;
    const needle = filter.text.trim().toLowerCase();
    if (needle === "")
        return [];
    const fields = topicTexts(source, id, topic)
        .filter(([, text]) => text.toLowerCase().includes(needle))
        .map(([field]) => field);
    return fields.length === 0 ? null : [...new Set(fields)];
}
/** The topics shown under `filter`, with the fields each matched in; null when nothing is filtered. */
export function shownTopics(source, filter) {
    if (!isActive(filter))
        return null;
    const shown = new Map();
    for (const id of Object.keys(source.topics)) {
        const fields = topicMatch(source, id, filter);
        if (fields !== null)
            shown.set(id, fields);
    }
    return shown;
}
/** True when something filed under `topic` (or under none) is on the page under this filter. */
export function isShown(shown, topic) {
    return shown === null || (topic !== null && shown.has(topic));
}
/**
 * What the filter hides that waits on the captain: decisions (live holds
 * shown now and close proposals), decisions waiting their turn, and hands-on
 * items still to do.
 */
export function owedOutside(source, shown) {
    if (shown === null)
        return { decide: 0, queued: 0, handsOn: 0 };
    const hidden = source.holds.filter((hold) => hold.live && !isShown(shown, hold.topic));
    const holds = hidden.filter((hold) => !hold.waits_turn).length;
    const queued = hidden.length - holds;
    const proposals = Object.entries(source.topics).filter(([id, topic]) => topic.close_reason !== null && !shown.has(id)).length;
    const handsOn = source.todos.filter((todo) => todo.state !== "claimed" && !isShown(shown, todo.topic)).length;
    return { decide: holds + proposals, queued, handsOn };
}
