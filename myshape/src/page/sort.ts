// How the sidebar lists the cards in each queue, and 等你 its cards: in the
// queue's own order, or by when each card was created. Only what is shown
// changes; the queue, and the order the aggregator dispatches in, stay as they
// are. Pure, so it is tested on its own. The reasons are in spec/card-sort.markdown.
import type { CardOrder, SavedView } from "#board/hashtags.js";
import type { Page } from "./state.js";

/** What the order needs of a saved view. */
type SavedOrder = Pick<SavedView & { id: string }, "id" | "order">;

/** The orders the page offers. Kept here because page scripts cannot load modules outside dist/page. */
const ORDERS: readonly CardOrder[] = ["priority", "newest", "oldest"];

/** Where the page keeps its own order, for when no saved view is chosen. */
export const ORDER_KEY = "myshape.card-order";

/** The remembered order as stored; 照優先順序 for nothing, or for anything else. */
export function parseOrder(raw: string | null): CardOrder {
  const known = ORDERS.find((order) => order === raw);
  return known === undefined ? "priority" : known;
}

/** The order shown: the chosen saved view's, or the page's own when no saved view is chosen. */
export function shownOrder(
  view: string | null,
  views: readonly SavedOrder[],
  own: CardOrder,
): CardOrder {
  const saved = views.find((entry) => entry.id === view);
  return saved === undefined ? own : saved.order;
}

/** The order the sidebar lists the queues' cards in right now, given the board's saved views. */
export function cardOrder(
  page: Pick<Page, "filter" | "order">,
  views: readonly SavedOrder[],
): CardOrder {
  return shownOrder(page.filter.view, views, page.order);
}

/** Before every time a Date can hold (±8.64e15 ms), and still a number a difference can be taken of. */
const BEFORE_ALL = Number.MIN_SAFE_INTEGER;

/**
 * A creation time as a moment; none, or one that cannot be read, is older than
 * every other. null and undefined read as words no time parses as.
 */
function moment(created: string | null | undefined): number {
  const at = Date.parse(String(created));
  return Number.isNaN(at) ? BEFORE_ALL : at;
}

/**
 * The cards, given in priority order, in `order`. By creation time, newest or
 * oldest first; cards created at one moment keep their priority order in both
 * directions, because the sort is stable and they compare equal.
 */
export function sortCards<Card>(
  cards: readonly Card[],
  order: CardOrder,
  createdAt: (card: Card) => string | null | undefined,
): Card[] {
  if (order === "priority") return [...cards];
  const direction = order === "newest" ? -1 : 1;
  const timed = cards.map((card) => ({ card, at: moment(createdAt(card)) }));
  timed.sort((a, b) => direction * (a.at - b.at));
  return timed.map((entry) => entry.card);
}
