import { describe, expect, it } from "vitest";
import type { TodoView, TurnView } from "#board/view.js";
import { waitingCount } from "./cards.js";
import type { WriteView } from "./state.js";

function todo(task: string, state: string, topic: string | null = "gpu"): TodoView {
  return { task, state, topic } as unknown as TodoView;
}

function turn(key: string, waitsTurn: boolean, topic: string | null = "gpu"): TurnView {
  return { kind: "hold", key, topic, waits_turn: waitsTurn };
}

function write(id: string, state: string): WriteView {
  return { id, state } as unknown as WriteView;
}

describe("the count on the 等你 tab", () => {
  it("is zero when nothing waits on the captain", () => {
    expect(waitingCount({ todos: [], turns: [], writes: [] })).toBe(0);
  });

  it("counts hands-on items still to do, the decisions in front and the writes that did not arrive", () => {
    const view = {
      todos: [todo("k1", "open"), todo("k2", "failed", null), todo("k3", "claimed")],
      turns: [turn("main\th1", false), turn("bill", false, null), turn("main\th2", true)],
      writes: [
        write("w1", "failed"),
        write("w2", "undelivered"),
        write("w3", "unknown"),
        write("w4", "delivered"),
        write("w5", "ignored"),
        write("w6", "retrying"),
      ],
    };
    expect(waitingCount(view)).toBe(2 + 2 + 3);
  });
});
