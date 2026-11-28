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
/** The scroll for one frame when the finger is `depth` px into an edge's band; 0 outside it. */
function scrollStep(depth) {
    return Math.ceil((Math.min(Math.max(depth, 0), EDGE_PX) / EDGE_PX) * MAX_STEP_PX);
}
/**
 * How far to scroll the page this frame with the finger at `y`, where the
 * visible part of the page runs from `top` to `bottom`: up near the top,
 * down near the bottom, faster the closer to the edge; 0 in between.
 */
export function edgeScroll(y, top, bottom) {
    return scrollStep(y - bottom + EDGE_PX) - scrollStep(top + EDGE_PX - y);
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
const IDLE = { state: "idle" };
const effect = (kind, x = 0, y = 0) => ({ kind, x, y });
/** What undoes the gesture that is on. */
function ending(gesture) {
    if (gesture.state === "pressing")
        return [effect("unpress")];
    return gesture.state === "dragging" ? [effect("cancel")] : [];
}
/** A pointer goes down: it ends any gesture (a second finger ends a drag) and presses ⠿ or nothing. */
function down(gesture, input) {
    const ended = ending(gesture);
    if (!input.onHandle)
        return { gesture: IDLE, effects: ended };
    const { pointer, x, y } = input;
    return {
        gesture: { state: "pressing", pointer, x, y },
        effects: [...ended, effect("press", x, y)],
    };
}
/** The long press ended: the card is lifted where the finger is, unless the page refused it. */
function held(gesture, lifted) {
    if (gesture.state !== "pressing")
        return { gesture, effects: [] };
    if (!lifted)
        return { gesture: IDLE, effects: [effect("unpress")] };
    return {
        gesture: { ...gesture, state: "dragging" },
        effects: [effect("lift", gesture.x, gesture.y)],
    };
}
/** The pointer holding ⠿ moves, lifts or is cancelled. */
function follow(gesture, input) {
    const { x, y } = input;
    if (gesture.state === "pressing") {
        const still = input.type === "move" && !movedAway(x - gesture.x, y - gesture.y);
        return still ? { gesture, effects: [] } : { gesture: IDLE, effects: [effect("unpress")] };
    }
    if (input.type === "move")
        return { gesture: { ...gesture, x, y }, effects: [effect("hover", x, y)] };
    return {
        gesture: IDLE,
        effects: [input.type === "up" ? effect("drop", x, y) : effect("cancel")],
    };
}
/**
 * The gesture after `input`. A press lasts until `PRESS_MS` passes (held),
 * the finger wanders past the slop, or it lifts; a drag until the finger
 * lifts (drop) or the browser cancels. Other pointers' moves are ignored.
 */
export function step(gesture, input) {
    if (input.type === "down")
        return down(gesture, input);
    if (input.type === "held")
        return held(gesture, input.lifted);
    if (gesture.state === "idle" || input.pointer !== gesture.pointer)
        return { gesture, effects: [] };
    return follow(gesture, input);
}
/** The pointer's input for the gesture, with where it is. */
function pointerInput(type, event) {
    return { type, pointer: event.pointerId, x: event.clientX, y: event.clientY };
}
/** The card whose ⠿ a finger or a pen went down on; null for a mouse or anywhere else. */
function pressedCard(event) {
    if (event.pointerType === "mouse")
        return null;
    const handle = event.target.closest(".topic .handle");
    return handle?.closest(".topic[data-topic]") ?? null;
}
/** One page's finger drags: the gesture, the card it holds, and its press timer and scroll loop. */
class Fingers {
    drag;
    band;
    gesture = IDLE;
    /** The card under the pointer that went down last. */
    pressed = null;
    /** The card the gesture holds. */
    card = null;
    timer = 0;
    frame = 0;
    constructor(drag, band) {
        this.drag = drag;
        this.band = band;
    }
    apply(input) {
        const next = step(this.gesture, input);
        this.gesture = next.gesture;
        for (const done of next.effects)
            this.run(done);
    }
    run({ kind, x, y }) {
        if (kind === "press")
            this.press();
        else if (kind === "lift")
            this.lift(x, y);
        else if (kind === "hover")
            this.drag.hover(x, y);
        else
            this.letGo(kind, x, y);
    }
    /** The card's native drag is off while the finger is down on its ⠿. */
    press() {
        this.card = this.pressed;
        this.card?.setAttribute("draggable", "false");
        this.timer = window.setTimeout(() => {
            const card = this.card;
            this.apply({ type: "held", lifted: card !== null && this.drag.lift(card) });
        }, PRESS_MS);
    }
    lift(x, y) {
        this.frame = window.requestAnimationFrame(this.scroll);
        this.drag.hover(x, y);
    }
    /** Ends the press or the drag, gives the card its native drag back, then drops it or puts it back. */
    letGo(kind, x, y) {
        window.clearTimeout(this.timer);
        window.cancelAnimationFrame(this.frame);
        this.card?.setAttribute("draggable", "true");
        if (kind === "drop")
            this.drag.release(x, y);
        if (kind === "cancel")
            this.drag.cancel();
    }
    scroll = () => {
        if (this.gesture.state === "idle")
            return;
        const { x, y } = this.gesture;
        const { top, bottom } = this.band();
        const by = edgeScroll(y, top, bottom);
        window.scrollBy(0, by);
        if (by !== 0)
            this.drag.hover(x, y);
        this.frame = window.requestAnimationFrame(this.scroll);
    };
}
/**
 * Makes a long press on a card's `.handle` under `root` drag the card for
 * any pointer but the mouse. The card's native drag is off while the finger
 * is down, so the phone's own long-press drag cannot take the gesture over.
 */
export function listenForTouchDrag(root, drag, band) {
    const fingers = new Fingers(drag, band);
    root.addEventListener("pointerdown", (event) => {
        fingers.pressed = pressedCard(event);
        if (fingers.pressed !== null)
            event.preventDefault();
        const { pointerId: pointer, clientX: x, clientY: y } = event;
        fingers.apply({ type: "down", pointer, x, y, onHandle: fingers.pressed !== null });
    });
    window.addEventListener("pointermove", (event) => {
        if (fingers.gesture.state === "dragging")
            event.preventDefault();
        fingers.apply(pointerInput("move", event));
    });
    window.addEventListener("pointerup", (event) => fingers.apply(pointerInput("up", event)));
    window.addEventListener("pointercancel", (event) => fingers.apply(pointerInput("cancel", event)));
    // A long press on a phone otherwise opens the browser's own menu over ⠿.
    root.addEventListener("contextmenu", (event) => {
        if (event.target.closest(".topic .handle") !== null)
            event.preventDefault();
    });
}
