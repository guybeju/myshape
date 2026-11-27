// How the sidebar lists the cards in each queue: in the queue's own order, or
// by when each topic was created. Only what is shown changes; the queue, and
// the order the aggregator dispatches in, stay as they are. Pure, so it is
// tested on its own. The reasons are in spec/card-sort.markdown.
import type { CardOrder, SavedView } from "#board/hashtags.js";
import type { Page, View } from "./state.js";

/** The orders the page offers. Kept here because page scripts cannot load modules outside dist/page. */
const ORDERS: readonly CardOrder[] = ["priority", "newest", "oldest"];

/** Where the page keeps its own order, for when no saved view is chosen. */
export const ORDER_KEY = "myshape.card-order";

/** The remembered order as stored; 照優先順序 for nothing, or for anything else. */
export function parseOrder(raw: string | null): CardOrder {
  return ORDERS.find((order) => order === raw) ?? "priority";
}

/** The order shown: the chosen saved view's, or the page's own when no saved view is chosen. */
export function shownOrder(
  view: string | null,
  views: readonly Pick<SavedView & { id: string }, "id" | "order">[],
  own: CardOrder,
): CardOrder {
  return views.find((saved) => saved.id === view)?.order ?? own;
}

/** The order the sidebar lists the queues' cards in right now. */
export function cardOrder(
  page: Pick<Page, "filter" | "order">,
  view: Pick<View, "hashtags">,
): CardOrder {
  return shownOrder(page.filter.view, view.hashtags.views, page.order);
}

/** A creation time as a moment; one that cannot be read is older than every other. */
function moment(created: string): number {
  const at = Date.parse(created);
  return Number.isNaN(at) ? -Infinity : at;
}

/**
 * The queue's cards in `order`. By creation time, newest or oldest first;
 * topics created at one moment keep their priority order in both directions.
 */
export function sortCards(
  queue: readonly string[],
  order: CardOrder,
  createdAt: (id: string) => string,
): string[] {
  if (order === "priority") return [...queue];
  const sign = order === "newest" ? -1 : 1;
  const cards = queue.map((id, rank) => ({ id, rank, at: moment(createdAt(id)) }));
  cards.sort((a, b) => (a.at === b.at ? a.rank - b.rank : sign * (a.at < b.at ? -1 : 1)));
  return cards.map((card) => card.id);
}
