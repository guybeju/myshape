import { describe, expect, it } from "vitest";
import { PRESS_MS, edgeScroll, indexAt, movedAway } from "./touch.js";

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
