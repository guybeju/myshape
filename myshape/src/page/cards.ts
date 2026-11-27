// The captain's one queue (等你決定) and the board's lifecycle cards: the
// aggregator's decisions and close proposals, the board's 沒人處理的議題 and
// 沒人接 cards, the writes that never arrived, and the deadline settings.
import type { StallMember, StallView } from "#board/lifecycle.js";
import type { TurnView } from "#board/view.js";
import { h } from "./dom.js";
import type { Child } from "./dom.js";
import { holdCard, topicLink, when, writeRows } from "./parts.js";
import { BAD_WRITES, agentName } from "./state.js";
import type { Actions, Page, View } from "./state.js";

/** The days 先不關 or 延到 is shown with by default (KEEP_DEFAULT_DAYS; page scripts cannot load lifecycle-settings.ts). */
const DEFAULT_DAYS = 14;
const DAY_MS = 86_400_000;

/** The days typed for one card, or the default. */
function daysOf(page: Page, key: string): number {
  const typed = Number(page.drafts.get(key) ?? "");
  return Number.isInteger(typed) && typed >= 1 && typed <= 90 ? typed : DEFAULT_DAYS;
}

/** The date `days` from now, as MM-DD. */
function dayWords(days: number): string {
  return when(Math.floor((Date.now() + days * DAY_MS) / 1000)).slice(0, 5);
}

/** A small box for how many days, kept across re-renders. */
function daysBox(page: Page, actions: Actions, key: string): Child {
  return h("input", {
    type: "number",
    class: "days",
    min: "1",
    max: "90",
    "data-key": key,
    placeholder: String(DEFAULT_DAYS),
    value: page.drafts.get(key) ?? "",
    oninput: (event) => actions.draft(key, (event.target as HTMLInputElement).value),
  });
}

/** The aggregator's 提議關閉: close and archive, or keep until a date or in 待辦. */
export function closeCard(page: Page, view: View, actions: Actions, id: string): Child {
  const topic = view.topics[id];
  if (topic === undefined || topic.close_reason === null) return null;
  const key = `keep-days:${id}`;
  const days = daysOf(page, key);
  return h(
    "div",
    { class: "card", "data-close": id },
    h(
      "div",
      { class: "meta" },
      topicLink(view, id, actions),
      h("span", { class: "pill warn" }, "提議關閉"),
    ),
    h("div", {}, `${agentName()} 認為這個議題可以關了：${topic.close_reason}`),
    h(
      "div",
      { class: "btns" },
      h("button", { onclick: () => actions.topic("archive", { id }) }, "關閉並封存"),
      h(
        "button",
        { onclick: () => actions.topic("keep", { id, days }) },
        `先不關，到 ${dayWords(days)}`,
      ),
      daysBox(page, actions, key),
      h(
        "button",
        { onclick: () => actions.topic("keep", { id, later: true }) },
        "先不關，移到待辦",
      ),
    ),
  );
}

/** The board's 沒人處理的議題: a topic with no work that nobody handled. A fact, not a proposal. */
export function idleCard(page: Page, view: View, actions: Actions, id: string): Child {
  const card = view.idle.find((entry) => entry.topic === id);
  if (card === undefined) return null;
  const key = `idle-days:${id}`;
  const days = daysOf(page, key);
  return h(
    "div",
    { class: "card", "data-idle": id },
    h(
      "div",
      { class: "meta" },
      topicLink(view, id, actions),
      h("span", { class: "pill warn" }, "沒人處理的議題"),
    ),
    h("div", {}, card.text),
    h(
      "div",
      { class: "btns" },
      h("button", { onclick: () => actions.topic("archive", { id }) }, "關閉並封存"),
      h(
        "button",
        { onclick: () => actions.send("lifecycle/answer", { card: "idle", key: id, days }) },
        `先不關，到 ${dayWords(days)}`,
      ),
      daysBox(page, actions, key),
      h("button", { onclick: () => actions.topic("move", { id, queue: "later" }) }, "移到待辦"),
    ),
  );
}

const STATE_WORDS: Record<string, string> = {
  D8: "答了沒關",
  D9: "讀不懂",
  Q1: "排到就做卻一直沒做",
  Q4: "議題已封存，這筆還開著",
  Q5: "停著，沒有日期也沒有等的項目",
  Q8: "等的工作看板找不到",
  NT: "沒有議題",
  A1: "進行中卻沒有任何變化",
  A2: "停著",
  A3: "還沒開始",
  A4: "卡住",
  A5: "做完還沒收",
  A6: "狀態讀不懂",
  W1: "worker 的問題沒人回",
  S3: "aggregator 暫停了排程",
  S6: "排程一直沒有人接",
};

/** The one button the board already has for a member, when it has one. */
function memberAction(view: View, actions: Actions, member: StallMember): Child {
  const topic = view.schedules.series.find((series) => series.id === member.id)?.topic;
  if (member.states.includes("S3") && topic !== undefined)
    return h("button", { onclick: () => actions.send("schedules/resume", { topic }) }, "恢復排程");
  if (member.states.includes("S6") && topic !== undefined)
    return h("button", { onclick: () => actions.send("schedules/pause", { topic }) }, "暫停排程");
  return null;
}

function memberRow(view: View, actions: Actions, member: StallMember): Child {
  const reasons = member.states.map((state) => STATE_WORDS[state] ?? state).join("、");
  return h(
    "div",
    { class: "row" },
    h(
      "span",
      { class: "grow" },
      h("b", {}, member.label),
      ` ${reasons}（從 ${when(Date.parse(member.since) / 1000)}）`,
    ),
    memberAction(view, actions, member),
  );
}

/** The board's 沒人接 card: the cards under a topic past their deadline, with 延到 and 移到待辦. */
export function stallCard(page: Page, view: View, actions: Actions, stall: StallView): Child {
  const key = `stall-days:${stall.key}`;
  const days = daysOf(page, key);
  const live = stall.topic !== null && view.topics[stall.topic]?.status !== "archived";
  return h(
    "div",
    { class: "card", "data-stall": stall.key },
    h(
      "div",
      { class: "meta" },
      stall.topic === null
        ? h("span", { class: "pill" }, "沒有議題")
        : topicLink(view, stall.topic, actions),
      h("span", { class: "pill warn" }, "沒人接"),
    ),
    h("div", {}, `這些卡過了期限，${agentName()} 都沒有接手：`),
    stall.members.map((member) => memberRow(view, actions, member)),
    h(
      "div",
      { class: "btns" },
      h(
        "button",
        {
          onclick: () => actions.send("lifecycle/answer", { card: "stall", key: stall.key, days }),
        },
        `延到 ${dayWords(days)}`,
      ),
      daysBox(page, actions, key),
      live
        ? h(
            "button",
            { onclick: () => actions.topic("move", { id: stall.topic, queue: "later" }) },
            "移到待辦",
          )
        : null,
    ),
  );
}

function turnCard(page: Page, view: View, actions: Actions, turn: TurnView): Child {
  if (turn.kind === "close") return closeCard(page, view, actions, turn.key);
  if (turn.kind === "idle") return idleCard(page, view, actions, turn.key);
  if (turn.kind === "stall") {
    const stall = view.stalls.find((entry) => entry.key === turn.key);
    return stall === undefined ? null : stallCard(page, view, actions, stall);
  }
  const hold = view.holds.find((entry) => `${entry.home}\t${entry.task}` === turn.key);
  return hold === undefined ? null : holdCard(page, view, actions, hold, true);
}

/**
 * The cards of the one queue that `shows` lets through, in its order: the
 * ones in front, then one line for how many wait their turn.
 */
export function queueCards(
  page: Page,
  view: View,
  actions: Actions,
  shows: (topic: string | null) => boolean,
): Child {
  const turns = view.turns.filter((turn) => shows(turn.topic));
  const waiting = turns.filter((turn) => turn.waits_turn).length;
  return [
    turns.filter((turn) => !turn.waits_turn).map((turn) => turnCard(page, view, actions, turn)),
    waiting === 0
      ? null
      : h("p", { class: "note turns" }, `還有 ${waiting} 個決定排隊，輪到時才顯示`),
  ];
}

/** Every write that did not arrive, with or without a topic, archived ones too, with 重送 and 忽略. */
export function undelivered(page: Page, actions: Actions): Child {
  const bad = (page.view?.writes ?? []).filter((write) => BAD_WRITES.includes(write.state));
  if (bad.length === 0) return null;
  return h(
    "section",
    {},
    h("h2", {}, `沒送到 ${bad.length}`),
    writeRows(page, actions, (write) => BAD_WRITES.includes(write.state), bad.length),
  );
}

/** One deadline setting: its two numbers and their defaults. */
function settingRow(
  page: Page,
  actions: Actions,
  row: View["lifecycle"]["settings"][number],
): Child {
  const remindKey = `deadline-remind:${row.state}`;
  const raiseKey = `deadline-raise:${row.state}`;
  const value = (key: string, current: number): number => Number(page.drafts.get(key) ?? current);
  const save = (): void =>
    actions.send("lifecycle/settings", {
      [row.state]: { remind: value(remindKey, row.remind), raise: value(raiseKey, row.raise) },
    });
  const box = (key: string, current: number): Child =>
    h("input", {
      type: "number",
      class: "days",
      "data-key": key,
      value: page.drafts.get(key) ?? String(current),
      oninput: (event) => actions.draft(key, (event.target as HTMLInputElement).value),
    });
  return h(
    "div",
    { class: "row" },
    h(
      "span",
      { class: "grow" },
      `${row.label}（${row.unit}；預設 ${row.default_remind}／${row.default_raise}）`,
    ),
    "提醒",
    box(remindKey, row.remind),
    "交給你",
    box(raiseKey, row.raise),
    h("button", { onclick: save }, "存"),
  );
}

/** The captain's deadline settings: when the aggregator is reminded, and when a card comes to you. */
export function lifecycleSettings(page: Page, actions: Actions, view: View): Child {
  return h(
    "details",
    { "data-key": "lifecycle-settings" },
    h("summary", {}, "期限設定"),
    h("p", { class: "note" }, "提醒不能晚於交給你；每一項都要有期限。"),
    view.lifecycle.settings.map((row) => settingRow(page, actions, row)),
  );
}
