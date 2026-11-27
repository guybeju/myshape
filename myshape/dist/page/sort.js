/** The orders the page offers. Kept here because page scripts cannot load modules outside dist/page. */
const ORDERS = ["priority", "newest", "oldest"];
/** Where the page keeps its own order, for when no saved view is chosen. */
export const ORDER_KEY = "myshape.card-order";
/** The remembered order as stored; 照優先順序 for nothing, or for anything else. */
export function parseOrder(raw) {
    const known = ORDERS.find((order) => order === raw);
    return known === undefined ? "priority" : known;
}
/** The order shown: the chosen saved view's, or the page's own when no saved view is chosen. */
export function shownOrder(view, views, own) {
    const saved = views.find((entry) => entry.id === view);
    return saved === undefined ? own : saved.order;
}
/** The order the sidebar lists the queues' cards in right now, given the board's saved views. */
export function cardOrder(page, views) {
    return shownOrder(page.filter.view, views, page.order);
}
/** Before every time a Date can hold (±8.64e15 ms), and still a number a difference can be taken of. */
const BEFORE_ALL = Number.MIN_SAFE_INTEGER;
/** A creation time as a moment; one that cannot be read is older than every other. */
function moment(created) {
    const at = Date.parse(created);
    return Number.isNaN(at) ? BEFORE_ALL : at;
}
/**
 * The queue's cards in `order`. By creation time, newest or oldest first;
 * topics created at one moment keep their priority order in both directions,
 * because the sort is stable and they compare equal.
 */
export function sortCards(queue, order, createdAt) {
    if (order === "priority")
        return [...queue];
    const direction = order === "newest" ? -1 : 1;
    const cards = queue.map((id) => ({ id, at: moment(createdAt(id)) }));
    cards.sort((a, b) => direction * (a.at - b.at));
    return cards.map((card) => card.id);
}
