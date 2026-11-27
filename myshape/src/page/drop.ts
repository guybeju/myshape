// Where a dragged topic lands in its full queue when the sidebar lists only
// some of the queue's topics. Only what the captain sees is ordered; the
// topics a filter hides keep their places. Pure, so it is tested on its own.
// The reasons are in spec/drag-under-filter.markdown, and for cards listed by
// creation time in spec/card-sort.markdown.
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

/**
 * Where a drop puts a card while the cards are listed by creation time: the
 * place in the list is not a priority, so a drop in its own queue moves
 * nothing, and a drop in another queue puts it last there.
 */
export function timeDropAnchor(from: Queue, to: Queue): Anchor | null {
  return from === to ? null : { last: true };
}

/**
 * The hint a queue shows while a card is dragged: `shown` cards listed,
 * `unlisted` not; `byTime` when the cards are listed by creation time.
 */
export function dropHint(
  shown: number,
  unlisted: number,
  filtered: boolean,
  byTime = false,
): string {
  if (byTime)
    return `照建立時間排列中：拖到別的佇列會排在那裡的最後${filtered ? "（連沒列出的也算）" : ""}，在原來的佇列裡放下不會改順序`;
  if (!filtered) return "拖到這裡";
  if (shown > 0)
    return `篩選中：只在看得到的 ${shown} 個議題之間排順序，沒列出的 ${unlisted} 個位置不變`;
  return unlisted > 0
    ? `篩選中：這裡沒有看得到的議題，放下會排在沒列出的 ${unlisted} 個之後`
    : "篩選中：放下會排在這個佇列最後";
}
