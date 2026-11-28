// The order of the 等你 tab's cards: the hands-on items and the cards in front
// of 等你決定. They follow the queues' chosen order; only the cards already
// shown change places, so which decisions are in front and how many wait their
// turn stay the board's. Pure, so it is tested on its own. The reasons are in
// spec/card-sort.markdown, decisions 8 to 12.
import type { CardOrder } from "#board/hashtags.js";
import type { TodoView, TurnView } from "#board/view.js";
import { liveTodos } from "./parts.js";
import { cardOrder, sortCards } from "./sort.js";
import type { Page, View } from "./state.js";

/** What the 等你 order needs of the page's view. */
export type WaitSource = Pick<View, "todos" | "turns" | "holds" | "topics" | "idle" | "stalls"> & {
  hashtags: Pick<View["hashtags"], "views">;
};

type TimeOf = (view: WaitSource, key: string) => string | null | undefined;

/** Where each kind of card keeps the time it came to be (decision 10). */
const CREATED_AT: Record<TurnView["kind"], TimeOf> = {
  hold: (view, key) => view.holds.find((hold) => `${hold.home}\t${hold.task}` === key)?.hold_set,
  close: (view, key) => view.topics[key]?.close_at,
  idle: (view, key) => view.idle.find((card) => card.topic === key)?.since,
  stall: (view, key) => view.stalls.find((card) => card.key === key)?.since,
};

/** When a card of 等你決定 came to be; "" when the board has no time for it. */
export function turnCreatedAt(view: WaitSource, turn: TurnView): string {
  return CREATED_AT[turn.kind](view, turn.key) ?? "";
}

/**
 * The cards of 等你決定 that `shows` lets through: the ones in front, in
 * `order`, and how many wait their turn. Which ones are in front is the
 * board's (`waits_turn`), never the order's.
 */
export function frontTurns(
  view: WaitSource,
  shows: (topic: string | null) => boolean,
  order: CardOrder,
): { front: TurnView[]; waiting: number } {
  const turns = view.turns.filter((turn) => shows(turn.topic));
  const front = turns.filter((turn) => !turn.waits_turn);
  return {
    front: sortCards(front, order, (turn) => turnCreatedAt(view, turn)),
    waiting: turns.length - front.length,
  };
}

/** The 等你 tab's two sorted lists, in the order the page shows them now. */
export interface WaitLists {
  order: CardOrder;
  /** The hands-on items, the ones waiting on the captain before the claimed ones. */
  todos: TodoView[];
  front: TurnView[];
  waiting: number;
}

/** The 等你 tab's cards that `shows` lets through, in the queues' chosen order. */
export function waitLists(
  page: Pick<Page, "filter" | "order">,
  view: WaitSource,
  shows: (topic: string | null) => boolean,
): WaitLists {
  const order = cardOrder(page, view.hashtags.views);
  const todos = sortCards(
    view.todos.filter((todo) => shows(todo.topic)),
    order,
    (todo) => todo.created_at,
  );
  return { order, todos: liveTodos({ todos }), ...frontTurns(view, shows, order) };
}
