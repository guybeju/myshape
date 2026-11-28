import { describe, expect, it } from "vitest";
import type { CardOrder } from "#board/hashtags.js";
import { generator } from "#board/seeded-random.test-helper.js";
import type { TodoView, TurnView } from "#board/view.js";
import type { Page } from "./state.js";
import { frontTurns, turnCreatedAt, waitLists } from "./wait.js";
import type { WaitSource } from "./wait.js";

const ORDERS: CardOrder[] = ["priority", "newest", "oldest"];

function turn(
  kind: TurnView["kind"],
  key: string,
  topic: string | null,
  waitsTurn = false,
): TurnView {
  return { kind, key, topic, waits_turn: waitsTurn };
}

function todo(task: string, topic: string | null, createdAt: string, state = "open"): TodoView {
  return { task, topic, created_at: createdAt, state } as unknown as TodoView;
}

/** A board with one card of every kind in front and one decision waiting its turn. */
function board(): WaitSource {
  return {
    turns: [
      turn("hold", "main\th-old", "gpu"),
      turn("hold", "main\th-new", null),
      turn("close", "gpu", "gpu"),
      turn("idle", "web", "web"),
      turn("stall", "stall:web", "web"),
      turn("hold", "main\th-waits", "web", true),
    ],
    holds: [
      { home: "main", task: "h-old", hold_set: "2026-11-01T00:00:00Z" },
      { home: "main", task: "h-new", hold_set: "2026-11-05T00:00:00Z" },
      { home: "main", task: "h-waits", hold_set: "2026-11-09T00:00:00Z" },
    ],
    topics: { gpu: { close_at: "2026-11-03T00:00:00Z" }, web: { close_at: null } },
    idle: [{ topic: "web", since: "2026-11-04T00:00:00Z" }],
    stalls: [{ key: "stall:web", since: "2026-11-02T00:00:00Z" }],
    todos: [],
    hashtags: { views: [] },
  } as unknown as WaitSource;
}

const everything = (): boolean => true;
const keys = (turns: TurnView[]): string[] => turns.map((entry) => entry.key);

describe("the creation time of a card in 等你決定", () => {
  it("is the hold's start for a decision, the proposal's for a close, and since for the board's cards", () => {
    const view = board();
    const times = view.turns.map((entry) => turnCreatedAt(view, entry));
    expect(times).toEqual([
      "2026-11-01T00:00:00Z",
      "2026-11-05T00:00:00Z",
      "2026-11-03T00:00:00Z",
      "2026-11-04T00:00:00Z",
      "2026-11-02T00:00:00Z",
      "2026-11-09T00:00:00Z",
    ]);
  });

  it("is nothing when the board has no time for the card", () => {
    const view = { ...board(), holds: [{ home: "main", task: "h-old", hold_set: null }] };
    expect(turnCreatedAt(view as WaitSource, turn("hold", "main\th-old", "gpu"))).toBeNull();
    expect(turnCreatedAt(view as WaitSource, turn("hold", "main\tgone", "gpu"))).toBeUndefined();
    expect(turnCreatedAt(view as WaitSource, turn("close", "web", "web"))).toBeNull();
    expect(turnCreatedAt(view as WaitSource, turn("close", "nowhere", null))).toBeUndefined();
    expect(turnCreatedAt(view as WaitSource, turn("idle", "gpu", "gpu"))).toBeUndefined();
    expect(turnCreatedAt(view as WaitSource, turn("stall", "stall:gone", null))).toBeUndefined();
  });
});

describe("the cards in front of 等你決定", () => {
  it("keeps the queue's own order under 照優先順序", () => {
    const { front, waiting } = frontTurns(board(), everything, "priority");
    expect(keys(front)).toEqual(["main\th-old", "main\th-new", "gpu", "web", "stall:web"]);
    expect(waiting).toBe(1);
  });

  it("lists the cards in front newest first or oldest first, a topicless one by its own time", () => {
    expect(keys(frontTurns(board(), everything, "newest").front)).toEqual([
      "main\th-new",
      "web",
      "gpu",
      "stall:web",
      "main\th-old",
    ]);
    expect(keys(frontTurns(board(), everything, "oldest").front)).toEqual([
      "main\th-old",
      "stall:web",
      "gpu",
      "web",
      "main\th-new",
    ]);
  });

  it("never brings a decision waiting its turn forward, whatever the order", () => {
    for (const order of ORDERS) {
      const { front, waiting } = frontTurns(board(), everything, order);
      expect(keys(front)).not.toContain("main\th-waits");
      expect(waiting).toBe(1);
    }
  });

  it("orders only what the filter lets through, and counts only its waiting ones", () => {
    const web = (topic: string | null): boolean => topic === "web";
    expect(frontTurns(board(), web, "priority")).toEqual({
      front: [turn("idle", "web", "web"), turn("stall", "stall:web", "web")],
      waiting: 1,
    });
    expect(keys(frontTurns(board(), web, "oldest").front)).toEqual(["stall:web", "web"]);
    const gpu = (topic: string | null): boolean => topic === "gpu";
    expect(frontTurns(board(), gpu, "newest").waiting).toBe(0);
  });

  it("keeps the priority order among equal or unreadable times, in both directions", () => {
    const view = {
      ...board(),
      holds: [
        { home: "main", task: "h-old", hold_set: "2026-11-05" },
        { home: "main", task: "h-new", hold_set: "2026-11-05T00:00:00.000+00:00" },
        { home: "main", task: "h-waits", hold_set: null },
      ],
      topics: { gpu: { close_at: "not a time" }, web: { close_at: null } },
      idle: [{ topic: "web", since: "2026-11-05T00:00:00Z" }],
      stalls: [{ key: "stall:web", since: "" }],
    } as unknown as WaitSource;
    expect(keys(frontTurns(view, everything, "newest").front)).toEqual([
      "main\th-old",
      "main\th-new",
      "web",
      "gpu",
      "stall:web",
    ]);
    expect(keys(frontTurns(view, everything, "oldest").front)).toEqual([
      "gpu",
      "stall:web",
      "main\th-old",
      "main\th-new",
      "web",
    ]);
  });

  it("is empty when there is no decision, or the filter lets none through", () => {
    for (const order of ORDERS) {
      expect(frontTurns({ ...board(), turns: [] }, everything, order)).toEqual({
        front: [],
        waiting: 0,
      });
      expect(frontTurns(board(), () => false, order)).toEqual({ front: [], waiting: 0 });
    }
  });

  it("only reorders: the same cards in front and the same count waiting under every order", () => {
    const random = generator(20261128);
    for (let round = 0; round < 200; round += 1) {
      const size = Math.floor(random() * 12);
      const turns = Array.from({ length: size }, (_, index) =>
        turn("hold", `main\th${index}`, random() < 0.3 ? null : "gpu", random() < 0.4),
      );
      const holds = turns.map((entry, index) => ({
        home: "main",
        task: `h${index}`,
        hold_set: random() < 0.2 ? null : `2026-11-0${1 + Math.floor(random() * 3)}`,
      }));
      const view = { ...board(), turns, holds } as unknown as WaitSource;
      const shows = (topic: string | null): boolean => topic !== null || round % 2 === 0;
      const baseline = frontTurns(view, shows, "priority");
      for (const order of ORDERS) {
        const shown = frontTurns(view, shows, order);
        expect(shown.waiting).toBe(baseline.waiting);
        expect(keys(shown.front).toSorted()).toEqual(keys(baseline.front).toSorted());
      }
    }
  });
});

function page(view: string | null, order: CardOrder): Pick<Page, "filter" | "order"> {
  return { filter: { view } as Page["filter"], order };
}

describe("the 等你 lists", () => {
  const hands: TodoView[] = [
    todo("k-high", "gpu", "2026-11-02T00:00:00Z"),
    todo("k-claimed", "gpu", "2026-11-09T00:00:00Z", "claimed"),
    todo("k-normal", "web", "2026-11-05T00:00:00Z"),
    todo("k-loose", null, "2026-11-01T00:00:00Z"),
  ];
  const source = (views: { id: string; order: CardOrder }[]): WaitSource =>
    ({ ...board(), todos: hands, hashtags: { views } }) as unknown as WaitSource;
  const tasks = (todos: TodoView[]): string[] => todos.map((entry) => entry.task);

  it("follows the page's own order when no saved view is chosen", () => {
    const lists = waitLists(page(null, "newest"), source([]), everything);
    expect(lists.order).toBe("newest");
    expect(tasks(lists.todos)).toEqual(["k-normal", "k-high", "k-loose", "k-claimed"]);
    expect(keys(lists.front)[0]).toBe("main\th-new");
    expect(lists.waiting).toBe(1);
  });

  it("follows the chosen saved view's order, not the page's own", () => {
    const views = [{ id: "v1", order: "oldest" as const }];
    const lists = waitLists(page("v1", "newest"), source(views), everything);
    expect(lists.order).toBe("oldest");
    expect(tasks(lists.todos)).toEqual(["k-loose", "k-high", "k-normal", "k-claimed"]);
    expect(keys(lists.front)[0]).toBe("main\th-old");
  });

  it("keeps the items waiting on the captain before the claimed ones, and the queue's order by default", () => {
    const lists = waitLists(page(null, "priority"), source([]), everything);
    expect(tasks(lists.todos)).toEqual(["k-high", "k-normal", "k-loose", "k-claimed"]);
    expect(keys(lists.front)).toEqual(["main\th-old", "main\th-new", "gpu", "web", "stall:web"]);
  });

  it("lists only what the filter lets through", () => {
    const gpu = (topic: string | null): boolean => topic === "gpu";
    const lists = waitLists(page(null, "oldest"), source([]), gpu);
    expect(tasks(lists.todos)).toEqual(["k-high", "k-claimed"]);
    expect(keys(lists.front)).toEqual(["main\th-old", "gpu"]);
    expect(lists.waiting).toBe(0);
  });

  it("is empty with nothing to do and nothing to decide", () => {
    const empty = { ...source([]), todos: [], turns: [] } as WaitSource;
    expect(waitLists(page(null, "newest"), empty, everything)).toEqual({
      order: "newest",
      todos: [],
      front: [],
      waiting: 0,
    });
  });
});
