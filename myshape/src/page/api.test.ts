import { describe, expect, it } from "vitest";
import { tokenInHash } from "./api.js";

describe("tokenInHash", () => {
  it("takes the token out of a #t=<token> fragment", () => {
    expect(tokenInHash("#t=0a1b2c")).toBe("0a1b2c");
  });

  it("is null for every other fragment, so the page leaves them to its views", () => {
    for (const hash of [
      "",
      "#",
      "#t=",
      "#t=ABC",
      "#t=0a 1b",
      "#/topic/lim?t=0a1b",
      "#/f/any=x",
      "x#t=0a",
    ])
      expect(tokenInHash(hash)).toBeNull();
  });
});
