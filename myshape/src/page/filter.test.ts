import { describe, expect, it } from "vitest";
import {
  NO_FILTER,
  cycleHashtag,
  filterHash,
  owedOutside,
  parseFilterHash,
  resolveFilter,
  shownTopics,
  topicMatch,
  viewFilter,
} from "./filter.js";
import type { Filter, FilterSource } from "./filter.js";

function topic(name: string, close: string | null = null) {
  return {
    name,
    goal: `${name} 的目標`,
    status: "confirmed" as const,
    queue: "normal" as const,
    close_reason: close,
    archived_at: null,
  };
}

function source(): FilterSource {
  return {
    topics: { gpu: topic("GPU 叢集"), bill: topic("帳務", "做完了"), misc: topic("雜事") },
    agents: [
      {
        home: "main",
        task: "gpu-task",
        kind: "ship",
        light: "working",
        state: "working",
        detail: "跑 benchmark",
        topic: "gpu",
        unsorted_reason: null,
        updated_at: null,
        stale: false,
        unstarted: false,
        finished: false,
      },
    ],
    queued: [
      { home: "main", task: "q1", kind: "ship", title: "整理發票", topic: "bill", waiting: null },
    ],
    holds: [
      {
        home: "main",
        task: "h1",
        title: "要不要擴充",
        question: "要買 GPU 嗎？",
        options: [],
        on_answer: "close",
        on_answer_recorded: true,
        live: true,
        waits_turn: false,
        deferred_reason: null,
        topic: "gpu",
        stale: false,
      },
      {
        home: "main",
        task: "h2",
        title: "沒議題",
        question: "?",
        options: [],
        on_answer: "close",
        on_answer_recorded: true,
        live: true,
        waits_turn: false,
        deferred_reason: null,
        topic: null,
        stale: false,
      },
      {
        home: "main",
        task: "h3",
        title: "排在後面",
        question: "?",
        options: [],
        on_answer: "close",
        on_answer_recorded: true,
        live: true,
        waits_turn: true,
        deferred_reason: null,
        topic: "misc",
        stale: false,
      },
    ],
    questions: [],
    todos: [
      {
        task: "t1",
        title: "登入 VPN",
        topic: "bill",
        what: "登入",
        guidance: "",
        commands: [],
        state: "open",
        reason: null,
      },
      {
        task: "t2",
        title: "已按",
        topic: "misc",
        what: "x",
        guidance: "",
        commands: [],
        state: "claimed",
        reason: null,
      },
    ],
    summaries: [
      {
        ts: 1,
        home: "main",
        task: "gpu-task",
        kind: "ready",
        text: "PR 好了",
        pr: null,
        topic: "gpu",
      },
    ],
    hashtags: {
      topics: { gpu: ["AI_INFRA"], bill: ["WORK", "URGENT"] },
      hashtags: [{ name: "AI_INFRA" }, { name: "URGENT" }, { name: "WORK" }],
    },
  } as unknown as FilterSource;
}

const filter = (part: Partial<Filter>): Filter => ({ ...NO_FILTER, ...part });

describe("the filter", () => {
  it("shows topics with any of the chosen hashtags and none of the excluded ones", () => {
    expect([
      ...(shownTopics(source(), filter({ any: ["AI_INFRA", "URGENT"] })) ?? []).keys(),
    ]).toEqual(["gpu", "bill"]);
    expect([...(shownTopics(source(), filter({ none: ["AI_INFRA"] })) ?? []).keys()]).toEqual([
      "bill",
      "misc",
    ]);
    expect([...(shownTopics(source(), filter({ untagged: true })) ?? []).keys()]).toEqual(["misc"]);
    expect(shownTopics(source(), NO_FILTER)).toBeNull();
  });

  it("combines hashtags and the keyword with AND, and says which field matched", () => {
    expect(topicMatch(source(), "gpu", filter({ any: ["AI_INFRA"], text: "benchmark" }))).toEqual([
      "agent",
    ]);
    expect(topicMatch(source(), "gpu", filter({ text: "gpu" }))).toEqual([
      "名稱",
      "目標",
      "議題 id",
      "agent",
      "待決事項",
    ]);
    expect(topicMatch(source(), "bill", filter({ text: "發票" }))).toEqual(["排隊項目"]);
    expect(topicMatch(source(), "bill", filter({ text: "做完" }))).toEqual(["提議關閉"]);
    expect(topicMatch(source(), "bill", filter({ text: "urgent" }))).toEqual(["hashtag"]);
    expect(topicMatch(source(), "gpu", filter({ none: ["AI_INFRA"], text: "gpu" }))).toBeNull();
    expect(topicMatch(source(), "misc", filter({ text: "nothing" }))).toBeNull();
  });

  it("counts what waits on the captain outside the filter", () => {
    const shown = shownTopics(source(), filter({ any: ["AI_INFRA"] }));
    expect(owedOutside(source(), shown)).toEqual({ decide: 2, queued: 1, handsOn: 1 });
    expect(owedOutside(source(), shownTopics(source(), filter({ any: ["WORK"] })))).toEqual({
      decide: 2,
      queued: 1,
      handsOn: 0,
    });
    expect(owedOutside(source(), shownTopics(source(), filter({ untagged: true })))).toEqual({
      decide: 3,
      queued: 0,
      handsOn: 1,
    });
    expect(owedOutside(source(), null)).toEqual({ decide: 0, queued: 0, handsOn: 0 });
  });

  it("cycles a hashtag button through 有, 沒有 and off, leaving any saved view", () => {
    const on = cycleHashtag(filter({ view: "w" }), "A");
    expect(on).toEqual(filter({ any: ["A"] }));
    const off = cycleHashtag(on, "A");
    expect(off).toEqual(filter({ none: ["A"] }));
    expect(cycleHashtag(off, "A")).toEqual(NO_FILTER);
  });

  it("round-trips through the URL fragment", () => {
    const chosen = filter({
      any: ["AI_INFRA", "基礎"],
      none: ["X"],
      untagged: true,
      text: "gpu 叢集&x",
      view: "w",
    });
    expect(parseFilterHash(filterHash(chosen))).toEqual(chosen);
    expect(filterHash(NO_FILTER)).toBe("");
    expect(parseFilterHash("#/topic/gpu")).toBeNull();
    expect(parseFilterHash("#/f/")).toEqual(NO_FILTER);
  });

  it("spells hashtags as the board does, and drops ones it lacks", () => {
    const known = [{ name: "AI_INFRA" }];
    expect(resolveFilter(filter({ any: ["ai_infra", "ＡＩ_INFRA", "GONE"] }), known)).toEqual(
      filter({ any: ["AI_INFRA"] }),
    );
  });

  it("starts from a saved view", () => {
    const view = { id: "w", name: "工作", any: [], none: ["AI_INFRA"], text: "", untagged: false };
    expect(viewFilter(view)).toEqual(filter({ none: ["AI_INFRA"], view: "w" }));
  });
});

describe("the URL fragment", () => {
  it("names only the parts of the filter that are set", () => {
    expect(filterHash(filter({ text: "gpu" }))).toBe("#/f/text=gpu");
    expect(filterHash(filter({ any: ["A"] }))).toBe("#/f/any=A");
    expect(filterHash(filter({ none: ["A"] }))).toBe("#/f/none=A");
    expect(topicMatch(source(), "nope", NO_FILTER)).toBeNull();
    expect(filterHash(filter({ untagged: true }))).toBe("#/f/untagged=1");
    expect(filterHash(filter({ none: ["A", "B"] }))).toBe("#/f/none=A%2CB");
    expect(filterHash(filter({ view: "w" }))).toBe("#/f/view=w");
    expect(parseFilterHash("#/f/any=A,,B&untagged=0")).toEqual(filter({ any: ["A", "B"] }));
  });
});
