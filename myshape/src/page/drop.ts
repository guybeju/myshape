// Where a dragged topic lands in its full queue when the sidebar lists only
// some of the queue's topics. Only what the captain sees is ordered; the
// topics a filter hides keep their places. Pure, so it is tested on its own.
// The reasons are in spec/drag-under-filter.markdown, and for cards listed by
// creation time in spec/card-sort.markdown.
import type { Queue } from "#board/topics.js";
import type { Segment } from "./state.js";

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
 * Where a dragged card is let go: in a queue's list, at `slot` as the page
 * shows it, or on a segment button (高／一般／待辦／排程) with the last card
 * that queue lists other than the dragged one.
 */
export type Target =
  | { kind: "list"; slot: Slot }
  | { kind: "segment"; segment: Segment; last: string | null };

/** How the queues list their cards: under a filter, and by creation time instead of priority. */
export interface Listing {
  filtered: boolean;
  byTime: boolean;
}

/** The move a drop asks the board for. */
export interface Place {
  queue: Queue;
  anchor: Anchor;
}

/** The place in a list a target stands for: a segment button is its queue's end; 排程 is none. */
function targetSlot(target: Target): Slot | null {
  if (target.kind === "list") return target.slot;
  if (target.segment === "schedules") return null;
  return { queue: target.segment, above: target.last, below: null };
}

/**
 * The move a card that started at `start` asks for when let go on `target`;
 * null when it sends nothing. A segment button is the end of its queue's
 * list, so it follows the same rules as a drop there; 排程 takes no drop.
 */
export function dropPlace(start: Slot, target: Target, listing: Listing): Place | null {
  const slot = targetSlot(target);
  if (slot === null) return null;
  const anchor = listing.byTime
    ? timeDropAnchor(start.queue, slot.queue)
    : dropAnchor(start, slot, listing.filtered);
  return anchor === null ? null : { queue: slot.queue, anchor };
}

/**
 * The hint a queue shows while a card is dragged: `shown` cards listed,
 * `unlisted` not; `byTime` when the cards are listed by creation time.
 */
export function dropHint(
  shown: number,
  unlisted: number,
  filtered: boolean,
  byTime: boolean,
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
