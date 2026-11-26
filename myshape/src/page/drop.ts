// Where a dragged topic lands in its full queue when the sidebar lists only
// some of the queue's topics. Only what the captain sees is ordered; the
// topics a filter hides keep their places. Pure, so it is tested on its own.
// The reasons are in spec/drag-under-filter.markdown.
import type { Queue } from "#board/topics.js";

/** A place in a queue's list as the page shows it: the cards right above and right below. */
export interface Slot {
  queue: Queue;
  above: string | null;
  below: string | null;
}

/** What the page asks the board for: before a card, directly after a card, or the end. */
export type Anchor = { before: string } | { after: string } | { last: true };

/** The page does not redraw during a drag, so in one queue the card above fixes the place. */
function sameSlot(start: Slot, drop: Slot): boolean {
  return start.queue === drop.queue && start.above === drop.above;
}

/**
 * Where a drop at `drop` puts a card that started at `start`. Without a
 * filter, before the card below, or at the end, as the page always did.
 * Under a filter, directly after the visible card above; at the head of the
 * list, before the first visible card; with no visible card at all, at the
 * end. Null when a filtered card is dropped where it started, so the hidden
 * topics around it are not jumped over.
 */
export function dropAnchor(start: Slot, drop: Slot, filtered: boolean): Anchor | null {
  if (!filtered) return drop.below === null ? { last: true } : { before: drop.below };
  if (sameSlot(start, drop)) return null;
  if (drop.above !== null) return { after: drop.above };
  return drop.below === null ? { last: true } : { before: drop.below };
}

/** The hint a queue shows while a card is dragged: `shown` cards listed, `unlisted` not. */
export function dropHint(shown: number, unlisted: number, filtered: boolean): string {
  if (!filtered) return "拖到這裡";
  if (shown > 0)
    return `篩選中：只在看得到的 ${shown} 個議題之間排順序，沒列出的 ${unlisted} 個位置不變`;
  return unlisted > 0
    ? `篩選中：這裡沒有看得到的議題，放下會排在沒列出的 ${unlisted} 個之後`
    : "篩選中：放下會排在這個佇列最後";
}
