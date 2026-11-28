// The long press on a topic card's ⠿ that drags the card with a finger or a
// pen, since phone browsers do not run the native drag and drop the mouse
// uses dependably. The decisions are pure functions, tested on their own;
// `listenForTouchDrag` only wires them to pointer events. Why and how in
// spec/stage-5-browser.markdown (拖曳).
/** How long a finger holds still on ⠿ before the card lifts, so a swipe is not a drag. */
export const PRESS_MS = 400;
/** How far the finger may wander during the press and still be holding still. */
const SLOP_PX = 10;
/** How close to the top or bottom of the visible part of the page the finger scrolls it. */
const EDGE_PX = 56;
/** The most the page scrolls in one frame, with the finger at the very edge. */
const MAX_STEP_PX = 18;
/** Whether a finger that moved by (dx, dy) during the press meant to swipe, not to hold. */
export function movedAway(dx, dy) {
    return Math.hypot(dx, dy) > SLOP_PX;
}
/** The scroll for one frame when the finger is `depth` px into an edge's band. */
function step(depth) {
    return Math.ceil((Math.min(depth, EDGE_PX) / EDGE_PX) * MAX_STEP_PX);
}
/**
 * How far to scroll the page this frame with the finger at `y`, where the
 * visible part of the page runs from `top` to `bottom`: up near the top,
 * down near the bottom, faster the closer to the edge; 0 in between.
 */
export function edgeScroll(y, top, bottom) {
    if (y < top + EDGE_PX)
        return -step(top + EDGE_PX - y);
    if (y > bottom - EDGE_PX)
        return step(y - bottom + EDGE_PX);
    return 0;
}
/**
 * Where the dragged card goes among the other cards of a list, whose middles
 * are `middles` from the top: before the first one whose middle is below the
 * finger, or last.
 */
export function indexAt(middles, y) {
    const index = middles.findIndex((middle) => middle > y);
    return index === -1 ? middles.length : index;
}
/**
 * Makes a long press on a card's `.handle` under `root` drag the card for
 * any pointer but the mouse. The card's native drag is off while the finger
 * is down, so the phone's own long-press drag cannot take the gesture over.
 */
export function listenForTouchDrag(root, drag, band) {
    let gesture = { state: "idle" };
    /** Ends the gesture, whatever state it is in, and gives the card its native drag back. */
    const stop = () => {
        if (gesture.state === "idle")
            return;
        if (gesture.state === "pressing")
            window.clearTimeout(gesture.timer);
        else
            window.cancelAnimationFrame(gesture.frame);
        gesture.card.draggable = true;
        gesture = { state: "idle" };
    };
    const scroll = () => {
        if (gesture.state !== "dragging")
            return;
        const { top, bottom } = band();
        const by = edgeScroll(gesture.y, top, bottom);
        if (by !== 0) {
            window.scrollBy(0, by);
            drag.hover(gesture.x, gesture.y);
        }
        gesture.frame = window.requestAnimationFrame(scroll);
    };
    const lift = () => {
        if (gesture.state !== "pressing")
            return;
        const { pointer, card, x, y } = gesture;
        if (!drag.lift(card)) {
            stop();
            return;
        }
        gesture = {
            state: "dragging",
            pointer,
            card,
            x,
            y,
            frame: window.requestAnimationFrame(scroll),
        };
        drag.hover(x, y);
    };
    /** Ends the gesture; `finish` runs only when the card was lifted. */
    const end = (finish) => {
        const lifted = gesture.state === "dragging";
        stop();
        if (lifted)
            finish();
    };
    const ours = (event) => gesture.state !== "idle" && event.pointerId === gesture.pointer;
    root.addEventListener("pointerdown", (event) => {
        // A second finger ends the drag of the first.
        end(drag.cancel);
        const handle = event.target.closest(".topic .handle");
        const card = handle?.closest(".topic[data-topic]");
        if (event.pointerType === "mouse" || card === null || card === undefined)
            return;
        event.preventDefault();
        card.draggable = false;
        const timer = window.setTimeout(lift, PRESS_MS);
        gesture = {
            state: "pressing",
            pointer: event.pointerId,
            card,
            x: event.clientX,
            y: event.clientY,
            timer,
        };
    });
    window.addEventListener("pointermove", (event) => {
        if (!ours(event) || gesture.state === "idle")
            return;
        if (gesture.state === "pressing") {
            if (movedAway(event.clientX - gesture.x, event.clientY - gesture.y))
                stop();
            return;
        }
        event.preventDefault();
        gesture.x = event.clientX;
        gesture.y = event.clientY;
        drag.hover(gesture.x, gesture.y);
    });
    window.addEventListener("pointerup", (event) => {
        if (ours(event))
            end(() => drag.release(event.clientX, event.clientY));
    });
    window.addEventListener("pointercancel", (event) => {
        if (ours(event))
            end(drag.cancel);
    });
    // A long press on a phone otherwise opens the browser's own menu over ⠿.
    root.addEventListener("contextmenu", (event) => {
        if (event.target.closest(".topic .handle") !== null)
            event.preventDefault();
    });
}
