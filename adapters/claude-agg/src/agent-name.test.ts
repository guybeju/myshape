import { describe, expect, it } from "vitest";

import { AGENT_NAME } from "./agent-name.js";

// The binding file's `name` rule, from the board's contract (section 7): 1 to 64
// letters, digits, `.`, `_` or `-`, starting with a letter or digit.
const BINDING_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

describe("AGENT_NAME", () => {
  it("is a name the board accepts in its binding file", () => {
    expect(AGENT_NAME).toMatch(BINDING_NAME);
  });

  it("does not present the agent as Firstmate", () => {
    expect(AGENT_NAME.toLowerCase()).not.toContain("firstmate");
  });
});
