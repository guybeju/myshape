import { describe, expect, it } from "vitest";
import { findLines } from "./lineage.js";
import * as topics from "./topics.js";
import type { Queue, TopicResult, TopicState } from "./topics.js";

/** A result that must be a change. */
function changeOf(result: TopicResult): topics.TopicChange {
  if (!result.ok || !result.changed) throw new Error(`expected a change: ${result.line}`);
  return result;
}

function done(result: TopicResult): TopicState {
  if (!result.ok) throw new Error(`refused: ${result.line}`);
  return result.state as TopicState;
}

/** Topics: 帳務重構 (billing, high), 登入 (login, normal), 點子 (idea, later). */
function fixture(): TopicState {
  let state = topics.emptyState();
  const add = (id: string, name: string, queue?: Queue): void => {
    const input = { name, goal: `${name}的目標`, id, ...(queue === undefined ? {} : { queue }) };
    state = done(topics.create(state, input, "T"));
  };
  add("billing", "帳務重構", "high");
  add("login", "登入");
  add("idea", "點子", "later");
  return state;
}

/** 帳務報表 (reports) renamed from 報表, merged into billing, which then merged into 財務 (finance). */
function chained(): TopicState {
  let state = fixture();
  state = done(topics.create(state, { name: "報表", goal: "g", id: "reports" }, "T"));
  state = done(topics.rename(state, "reports", "帳務報表", "2026-11-18T01:00:00Z"));
  state = done(topics.merge(state, "reports", "billing", "2026-11-20T01:00:00Z"));
  state = done(
    topics.create(state, { name: "財務", goal: "g", id: "finance", queue: "later" }, "T"),
  );
  state = done(topics.merge(state, "billing", "finance", "2026-12-02T01:00:00Z"));
  return state;
}

describe("findLines", () => {
  it("finds a live topic by part of its id, name, or goal, ignoring case", () => {
    const state = fixture();
    expect(findLines(state, "BILL", [])).toEqual(["billing　帳務重構（高）"]);
    expect(findLines(state, "登", [])).toEqual(["login　登入（一般）"]);
    expect(findLines(state, "點子的目標", [])).toEqual(["idea　點子（待辦）"]);
  });

  it("follows an old name through a rename and two merges to where it is now", () => {
    const lines = findLines(chained(), "報表", []);
    expect(lines).toEqual([
      "finance　財務（待辦）",
      "  2026-11-18 「報表」改名為「帳務報表」",
      "  2026-11-20 「帳務報表」（reports）併入「帳務重構」",
      "  2026-12-02 「帳務重構」（billing）併入「財務」",
    ]);
    expect(findLines(chained(), "reports", [])).toEqual(lines);
  });

  it("shows an archived topic with its history, and says when nothing matches", () => {
    let state = done(topics.archive(fixture(), "login", "2026-11-21T00:00:00Z"));
    expect(findLines(state, "登入", [])).toEqual(["login　登入（已封存）", "  2026-11-21 封存"]);
    state = done(topics.reopen(state, "login", "high", "2026-11-22T00:00:00Z"));
    expect(findLines(state, "login", [])).toEqual([
      "login　登入（高）",
      "  2026-11-21 封存",
      "  2026-11-22 重開",
    ]);
    expect(findLines(state, "沒有這個", [])).toEqual(["找不到「沒有這個」。"]);
  });

  it("shows a merge made before the history existed, without details", () => {
    const state = fixture();
    state.doc.merged = { "old-one": "billing" };
    expect(findLines(state, "old-one", [])).toEqual([
      "billing　帳務重構（高）",
      "  old-one 併入這裡（沒有當時的紀錄）",
    ]);
  });

  it("says where a merged-away id points when its target no longer exists", () => {
    const state = fixture();
    state.doc.merged = { ghost: "nowhere" };
    expect(findLines(state, "ghost", [])).toEqual([
      "nowhere　（已不存在）",
      "  ghost 併入這裡（沒有當時的紀錄）",
    ]);
  });

  it("lists the topics a task was tagged with, oldest first, by their current names", () => {
    const state = chained();
    const tags = [
      { topic: "reports", atMs: Date.parse("2026-11-19T05:00:00Z") },
      { topic: "login", atMs: Date.parse("2026-12-05T05:00:00Z") },
      { topic: "gone", atMs: 0 },
    ];
    expect(findLines(state, "exp-1", [{ home: "sm1", task: "exp-1", tags }])).toEqual([
      "task sm1/exp-1：財務（2026-11-19，原 reports）→ 登入（2026-12-05）→ gone（不認得的議題）",
    ]);
    const undated = [{ topic: "login", atMs: 0 }];
    expect(findLines(state, "exp-2", [{ home: "main", task: "exp-2", tags: undated }])).toEqual([
      "task main/exp-2：登入（時間不明）",
    ]);
    expect(findLines(state, "exp-1", [{ home: "main", task: "exp-1", tags: [] }])).toEqual([
      "task main/exp-1：沒有標過議題",
    ]);
  });

  it("caps the topics and the history lines it prints and says how many are left out", () => {
    let state = topics.emptyState();
    for (let index = 0; index < 8; index += 1) {
      state = done(
        topics.create(state, { name: `同名 ${index}`, goal: "g", id: `t${index}` }, "T"),
      );
    }
    for (let index = 0; index < 11; index += 1) {
      state = done(topics.rename(state, "t0", `同名 0 第${index}版`, "2026-11-18T00:00:00Z"));
    }
    const lines = findLines(state, "同名", []);
    expect(lines.filter((line) => !line.startsWith("  "))).toEqual([
      "t0　同名 0 第10版（一般）",
      "t1　同名 1（一般）",
      "t2　同名 2（一般）",
      "t3　同名 3（一般）",
      "t4　同名 4（一般）",
      "還有 3 個議題符合，請用更長的關鍵字。",
    ]);
    expect(lines.slice(1, 10)).toEqual([
      "  還有 3 筆更早的紀錄，加 --all 看全部",
      ...[3, 4, 5, 6, 7, 8, 9, 10].map(
        (index) =>
          `  2026-11-18 「${index === 0 ? "同名 0" : `同名 0 第${index - 1}版`}」改名為「同名 0 第${index}版」`,
      ),
    ]);
  });

  it("shows a split under both the source and the topic that was split off", () => {
    const result = topics.split(
      fixture(),
      { from: "billing", name: "帳務匯出", goal: "g", id: "exports" },
      "2026-12-02T03:00:00Z",
    );
    const state = done(result);
    const line = "  2026-12-02 從「帳務重構」（billing）拆出「帳務匯出」（exports）";
    expect(findLines(state, "exports", [])).toEqual(["exports　帳務匯出（高）", line]);
    expect(findLines(state, "billing", [])).toEqual(["billing　帳務重構（高）", line]);
  });

  it("marks what a hand-edited history entry leaves out instead of failing", () => {
    const state = fixture();
    state.doc.history = [
      { at: "2026-11-18T00:00:00Z", kind: "renamed", topic: "login", name: "登入" },
      { at: "2026-11-19T00:00:00Z", kind: "merged", topic: "login", name: "登入" },
      { at: "2026-11-20T00:00:00Z", kind: "split", topic: "login", name: "登入" },
    ];
    expect(findLines(state, "login", [])).toEqual([
      "login　登入（一般）",
      "  2026-11-18 「？」改名為「登入」",
      "  2026-11-19 「？」（？）併入「登入」",
      "  2026-11-20 從「？」（？）拆出「登入」（login）",
    ]);
  });

  it("says when a topic sits in no queue", () => {
    const state = fixture();
    state.doc.queues.normal = [];
    expect(findLines(state, "login", [])).toEqual(["login　登入（沒有排進佇列）"]);
  });

  it("keeps empty old names as they are and leaves unrelated history out", () => {
    const state = chained();
    state.doc.history.push({
      at: "2026-12-03T00:00:00Z",
      kind: "merged",
      topic: "login",
      name: "登入",
      from: "",
      from_name: "",
    });
    expect(findLines(state, "login", [])).toEqual([
      "login　登入（一般）",
      "  2026-12-03 「」（）併入「登入」",
    ]);
  });

  it("prints no leftover note at exactly the caps, and counts one past them", () => {
    let state = topics.emptyState();
    const add = (index: number): void => {
      state = done(topics.create(state, { name: `同 ${index}`, goal: "g", id: `t${index}` }, "T"));
    };
    for (let index = 0; index < 5; index += 1) add(index);
    for (let index = 0; index < 8; index += 1) {
      state = done(topics.rename(state, "t0", `同 0 版${index}`, "2026-11-18T00:00:00Z"));
    }
    expect(findLines(state, "同", [])).toHaveLength(5 + 8);
    state = done(topics.rename(state, "t0", "同 0 版8", "2026-11-18T00:00:00Z"));
    expect(findLines(state, "t0", [])[1]).toBe("  還有 1 筆更早的紀錄，加 --all 看全部");
    add(5);
    expect(findLines(state, "同", []).at(-1)).toBe("還有 1 個議題符合，請用更長的關鍵字。");
  });

  it("treats the query as plain text, not as a pattern", () => {
    expect(findLines(fixture(), ".*", [])).toEqual(["找不到「.*」。"]);
  });
});

describe("findLines for working out what happened", () => {
  it("says where each change was made and why, when that was recorded", () => {
    let state = fixture();
    state = done(
      topics.stampHistory(
        changeOf(
          topics.split(
            state,
            { from: "billing", name: "退款", goal: "g", id: "refunds", reason: "帳務太寬" },
            "2026-11-16T19:36:44Z",
          ),
        ),
        0,
        "command",
      ),
    );
    state = done(topics.closePropose(state, "refunds", "都做完了", "2026-11-17T00:00:00Z"));
    state = done(
      topics.stampHistory(
        changeOf(topics.archive(state, "refunds", "2026-11-17T03:26:21Z")),
        1,
        "page",
      ),
    );
    state = done(topics.merge(state, "login", "billing", "2026-11-18T00:00:00Z"));
    expect(findLines(state, "退款", [])).toEqual([
      "refunds　退款（已封存）",
      "  2026-11-16 從「帳務重構」（billing）拆出「退款」（refunds）（用指令；原因：帳務太寬）",
      "  2026-11-17 封存（在頁面上；原因：都做完了）",
    ]);
    expect(findLines(state, "login", []).at(-1)).toBe(
      "  2026-11-18 「登入」（login）併入「帳務重構」",
    );
  });

  it("prints every topic and every entry with exact times when asked for everything", () => {
    let state = topics.emptyState();
    for (let index = 0; index < 7; index += 1) {
      state = done(topics.create(state, { name: `同 ${index}`, goal: "g", id: `t${index}` }, "T"));
    }
    for (let index = 0; index < 10; index += 1) {
      state = done(topics.rename(state, "t0", `同 0 版${index}`, `2026-11-18T00:00:0${index}Z`));
    }
    const lines = findLines(state, "同", [], true);
    expect(lines.filter((line) => !line.startsWith("  "))).toHaveLength(7);
    expect(lines.filter((line) => line.startsWith("  "))).toHaveLength(10);
    expect(lines[1]).toBe("  2026-11-18T00:00:00Z 「同 0」改名為「同 0 版0」");
    expect(lines.join("\n")).not.toContain("還有");
    expect(findLines(state, "同", [])).toContain("還有 2 個議題符合，請用更長的關鍵字。");
    const tags = [
      { home: "main", task: "w1", tags: [{ topic: "t1", atMs: Date.UTC(2026, 10, 19, 8, 7, 6) }] },
    ];
    expect(findLines(state, "w1", tags, true)).toEqual([
      "task main/w1：同 1（2026-11-19T08:07:06.000Z）",
    ]);
    expect(findLines(state, "w1", tags)).toEqual(["task main/w1：同 1（2026-11-19）"]);
  });

  it("lists moves and goal changes with who made them", () => {
    let state = fixture();
    state = done(
      topics.stampHistory(
        changeOf(topics.move(state, "login", "high", { first: true }, "2026-11-19T00:00:00Z")),
        state.doc.history.length,
        "command",
      ),
    );
    state = done(
      topics.stampHistory(
        changeOf(topics.setGoal(state, "login", "只做扣款", "2026-11-19T00:00:01Z")),
        state.doc.history.length,
        "page",
      ),
    );
    const lines = findLines(state, "login", [], true);
    expect(lines).toContain("  2026-11-19T00:00:00Z 移到「高」第 1（用指令）");
    expect(lines).toContain("  2026-11-19T00:00:01Z 目標改為「只做扣款」（在頁面上）");
  });

  it("keeps moves and goal changes out of the bounded answer, so a merge stays in it", () => {
    let state = fixture();
    state = done(topics.merge(state, "idea", "login", "2026-11-19T00:00:00Z"));
    for (let index = 0; index < 9; index += 1) {
      const queue = index % 2 === 0 ? "high" : "normal";
      state = done(
        topics.move(state, "login", queue, { first: true }, `2026-11-19T01:00:0${index}Z`),
      );
    }
    state = done(topics.setGoal(state, "login", "新的目標", "2026-11-19T02:00:00Z"));
    const plain = findLines(state, "login", []);
    expect(plain.some((line) => line.includes("併入"))).toBe(true);
    expect(plain.some((line) => line.includes("移到") || line.includes("目標改為"))).toBe(false);
    expect(
      findLines(state, "login", [], true).filter((line) => line.includes("移到")),
    ).toHaveLength(9);
  });
});
