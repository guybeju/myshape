import { liveTodos } from "./parts.js";
import { cardOrder, sortCards } from "./sort.js";
/** Where each kind of card keeps the time it came to be (decision 10). */
const CREATED_AT = {
    hold: (view, key) => view.holds.find((hold) => `${hold.home}\t${hold.task}` === key)?.hold_set,
    close: (view, key) => view.topics[key]?.close_at,
    idle: (view, key) => view.idle.find((card) => card.topic === key)?.since,
    stall: (view, key) => view.stalls.find((card) => card.key === key)?.since,
};
/** When a card of 等你決定 came to be; "" when the board has no time for it. */
export function turnCreatedAt(view, turn) {
    return CREATED_AT[turn.kind](view, turn.key) ?? "";
}
/**
 * The cards of 等你決定 that `shows` lets through: the ones in front, in
 * `order`, and how many wait their turn. Which ones are in front is the
 * board's (`waits_turn`), never the order's.
 */
export function frontTurns(view, shows, order) {
    const turns = view.turns.filter((turn) => shows(turn.topic));
    const front = turns.filter((turn) => !turn.waits_turn);
    return {
        front: sortCards(front, order, (turn) => turnCreatedAt(view, turn)),
        waiting: turns.length - front.length,
    };
}
/** The 等你 tab's cards that `shows` lets through, in the queues' chosen order. */
export function waitLists(page, view, shows) {
    const order = cardOrder(page, view.hashtags.views);
    const todos = sortCards(view.todos.filter((todo) => shows(todo.topic)), order, (todo) => todo.created_at);
    return { order, todos: liveTodos({ todos }), ...frontTurns(view, shows, order) };
}
