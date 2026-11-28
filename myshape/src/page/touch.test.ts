import { describe, expect, it } from "vitest";
import { PRESS_MS, edgeScroll, indexAt, movedAway, step } from "./touch.js";
import type { Gesture, Input } from "./touch.js";

describe("the long press on ⠿", () => {
  it("waits long enough that a swipe to scroll is not taken for a drag", () => {
    expect(PRESS_MS).toBe(400);
  });

  it("holds still within 10 px and counts anything farther as a swipe", () => {
    expect(movedAway(0, 0)).toBe(false);
    expect(movedAway(6, 8)).toBe(false);
    expect(movedAway(-10, 0)).toBe(false);
    expect(movedAway(0, 10.5)).toBe(true);
    expect(movedAway(-8, -7)).toBe(true);
  });
});

describe("scrolling while a finger drags a card", () => {
  // The visible part of the page: under a 50 px header, above a 52 px tab bar, in an 844 px window.
  const TOP = 50;
  const BOTTOM = 792;

  it("does not scroll away from the edges", () => {
    expect(edgeScroll(TOP + 56, TOP, BOTTOM)).toBe(0);
    expect(edgeScroll(400, TOP, BOTTOM)).toBe(0);
    expect(edgeScroll(BOTTOM - 56, TOP, BOTTOM)).toBe(0);
  });

  it("scrolls up near the top and down near the bottom, faster closer to the edge", () => {
    expect(edgeScroll(TOP + 55, TOP, BOTTOM)).toBe(-1);
    expect(edgeScroll(TOP + 28, TOP, BOTTOM)).toBe(-9);
    expect(edgeScroll(TOP, TOP, BOTTOM)).toBe(-18);
    expect(edgeScroll(BOTTOM - 55, TOP, BOTTOM)).toBe(1);
    expect(edgeScroll(BOTTOM - 28, TOP, BOTTOM)).toBe(9);
    expect(edgeScroll(BOTTOM, TOP, BOTTOM)).toBe(18);
  });

  it("scrolls no faster past the edge, over the header or the tab bar", () => {
    expect(edgeScroll(0, TOP, BOTTOM)).toBe(-18);
    expect(edgeScroll(844, TOP, BOTTOM)).toBe(18);
  });
});

describe("where a finger puts the card it drags in a list", () => {
  // The middles of the other cards, from the top.
  const middles = [100, 200, 300];

  it("goes before the first card whose middle is below the finger", () => {
    expect(indexAt(middles, 0)).toBe(0);
    expect(indexAt(middles, 99)).toBe(0);
    expect(indexAt(middles, 100)).toBe(1);
    expect(indexAt(middles, 250)).toBe(2);
  });

  it("goes last below every card, and first in a list with no other card", () => {
    expect(indexAt(middles, 300)).toBe(3);
    expect(indexAt(middles, 900)).toBe(3);
    expect(indexAt([], 50)).toBe(0);
  });
});

describe("a finger's gesture on ⠿", () => {
  const IDLE: Gesture = { state: "idle" };
  const PRESSING: Gesture = { state: "pressing", pointer: 1, x: 100, y: 200 };
  const DRAGGING: Gesture = { state: "dragging", pointer: 1, x: 100, y: 300 };
  const down = (onHandle: boolean, pointer = 1): Input => ({
    type: "down",
    pointer,
    x: 100,
    y: 200,
    onHandle,
  });
  const at = (type: "move" | "up" | "cancel", x: number, y: number, pointer = 1): Input => ({
    type,
    pointer,
    x,
    y,
  });
  /** The effects of one step, as kinds. */
  const kinds = (gesture: Gesture, input: Input) =>
    step(gesture, input).effects.map((done) => done.kind);

  it("presses when a finger goes down on ⠿, and does nothing anywhere else", () => {
    expect(step(IDLE, down(true))).toEqual({
      gesture: PRESSING,
      effects: [{ kind: "press", x: 100, y: 200 }],
    });
    expect(step(IDLE, down(false))).toEqual({ gesture: IDLE, effects: [] });
  });

  it("lifts the card where the finger is once the press lasts", () => {
    expect(step(PRESSING, { type: "held", lifted: true })).toEqual({
      gesture: { ...PRESSING, state: "dragging" },
      effects: [{ kind: "lift", x: 100, y: 200 }],
    });
  });

  it("gives the press up when the page refuses to lift the card", () => {
    expect(step(PRESSING, { type: "held", lifted: false })).toEqual({
      gesture: IDLE,
      effects: [{ kind: "unpress", x: 0, y: 0 }],
    });
  });

  it("ignores a press timer that ends after the press is over", () => {
    expect(step(IDLE, { type: "held", lifted: true })).toEqual({ gesture: IDLE, effects: [] });
    expect(step(DRAGGING, { type: "held", lifted: true })).toEqual({
      gesture: DRAGGING,
      effects: [],
    });
  });

  it("keeps pressing while the finger holds still, and gives up on a swipe or a lift", () => {
    expect(step(PRESSING, at("move", 106, 208))).toEqual({ gesture: PRESSING, effects: [] });
    expect(kinds(PRESSING, at("move", 100, 211))).toEqual(["unpress"]);
    expect(step(PRESSING, at("move", 100, 211)).gesture).toEqual(IDLE);
    expect(kinds(PRESSING, at("up", 100, 200))).toEqual(["unpress"]);
    expect(kinds(PRESSING, at("cancel", 100, 200))).toEqual(["unpress"]);
  });

  it("follows the finger while dragging, and drops the card where it lets go", () => {
    expect(step(DRAGGING, at("move", 120, 50))).toEqual({
      gesture: { ...DRAGGING, x: 120, y: 50 },
      effects: [{ kind: "hover", x: 120, y: 50 }],
    });
    expect(step(DRAGGING, at("up", 120, 60))).toEqual({
      gesture: IDLE,
      effects: [{ kind: "drop", x: 120, y: 60 }],
    });
  });

  it("puts the card back when the browser takes the gesture over", () => {
    expect(step(DRAGGING, at("cancel", 120, 60))).toEqual({
      gesture: IDLE,
      effects: [{ kind: "cancel", x: 0, y: 0 }],
    });
  });

  it("ignores another pointer's moves and lifts", () => {
    for (const gesture of [PRESSING, DRAGGING])
      for (const type of ["move", "up", "cancel"] as const)
        expect(step(gesture, at(type, 10, 10, 2))).toEqual({ gesture, effects: [] });
    expect(step(IDLE, at("up", 10, 10))).toEqual({ gesture: IDLE, effects: [] });
  });

  it("ends the gesture when a second finger goes down, and presses again on another ⠿", () => {
    expect(step(DRAGGING, down(false, 2))).toEqual({
      gesture: IDLE,
      effects: [{ kind: "cancel", x: 0, y: 0 }],
    });
    expect(kinds(DRAGGING, down(true, 2))).toEqual(["cancel", "press"]);
    expect(kinds(PRESSING, down(false, 2))).toEqual(["unpress"]);
    expect(step(PRESSING, down(true, 2))).toEqual({
      gesture: { ...PRESSING, pointer: 2 },
      effects: [
        { kind: "unpress", x: 0, y: 0 },
        { kind: "press", x: 100, y: 200 },
      ],
    });
  });
});
