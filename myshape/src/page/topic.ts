// One topic's page: pending decisions, updates, its agents, and the message box.
import type { AgentView, SummaryView, UpdateView } from "#board/view.js";
import { h } from "./dom.js";
import type { Child } from "./dom.js";
import { mergeConfirm, mergeMenu } from "./home.js";
import {
  closedFold,
  closedTodoEntries,
  draftInput,
  holdCard,
  light,
  liveTodos,
  todoCard,
  queuedRow,
  questionRow,
  summaryRow,
  updateRow,
  when,
  writeRows,
} from "./parts.js";
import type { ClosedEntry } from "./parts.js";
import { QUEUE_LABEL, agentName } from "./state.js";
import type { Actions, Page, View } from "./state.js";

/** Ledger lines and summaries shown before the rest fold into 更早的更新; board records always show. */
const MAX_UPDATES = 200;

/** A line of text with an edit button that swaps it for an input in place. */
function editable(
  page: Page,
  actions: Actions,
  id: string,
  field: "name" | "goal",
  text: string,
): Child {
  const key = `${field}:${id}`;
  const op = field === "name" ? "rename" : "goal";
  if (!page.editing.has(key)) {
    return [
      h(field === "name" ? "h2" : "span", { class: field === "goal" ? "goal" : "" }, text),
      h("button", { class: "link", onclick: () => actions.edit(key, true) }, "編輯"),
    ];
  }
  const save = (): void => {
    actions.topic(op, { id, value: page.drafts.get(key) ?? text });
    actions.edit(key, false);
  };
  const input = draftInput(page, actions, key, "", save);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") actions.edit(key, false);
  });
  return [
    input,
    h("button", { class: "primary", onclick: save }, "儲存"),
    h("button", { onclick: () => actions.edit(key, false) }, "取消"),
  ];
}

function menu(page: Page, actions: Actions): Child {
  return h(
    "span",
    { class: "menu" },
    h(
      "button",
      {
        "aria-label": "更多操作",
        onclick: () => actions.setPanel(page.panel === "menu" ? null : "menu"),
      },
      "⋯",
    ),
    page.panel === "menu"
      ? h(
          "div",
          { class: "items" },
          h("button", { onclick: () => actions.setPanel("archive") }, "封存"),
          h("button", { onclick: () => actions.setPanel("merge") }, "併入其他議題…"),
        )
      : null,
  );
}

function panels(page: Page, view: View, actions: Actions, id: string): Child {
  const key = `merge:${id}`;
  if (page.panel === "archive") {
    return h(
      "div",
      { class: "confirm" },
      "封存之後，這個議題排隊中的項目會被停住，已經在跑的不會停；之後可以在「已封存」重開。",
      h(
        "div",
        { class: "btns" },
        h(
          "button",
          {
            class: "danger",
            onclick: () => {
              actions.topic("archive", { id });
              actions.setPanel(null);
            },
          },
          "封存",
        ),
        h("button", { onclick: () => actions.setPanel(null) }, "取消"),
      ),
    );
  }
  if (page.panel === "merge" && !page.pending.has(key)) {
    return h(
      "div",
      { class: "confirm" },
      "要併進哪一個議題？",
      h(
        "div",
        { class: "btns" },
        mergeMenu(view, actions, id, key),
        h("button", { onclick: () => actions.setPanel(null) }, "取消"),
      ),
    );
  }
  return mergeConfirm(page, view, actions, key);
}

function header(page: Page, view: View, actions: Actions, id: string): Child {
  const topic = view.topics[id];
  if (topic === undefined) return null;
  const place =
    topic.status === "archived"
      ? "已封存"
      : topic.queue === null
        ? "沒有排進佇列"
        : `佇列：${QUEUE_LABEL[topic.queue]}`;
  return [
    h(
      "div",
      { class: "titleline" },
      editable(page, actions, id, "name", topic.name),
      h("span", { class: "pill" }, place),
      menu(page, actions),
    ),
    h("div", { class: "titleline" }, editable(page, actions, id, "goal", topic.goal)),
    panels(page, view, actions, id),
  ];
}

function handsOn(page: Page, view: View, actions: Actions, id: string): Child {
  const todos = liveTodos(view, id);
  const closed = view.closed_todos.filter((entry) => entry.topic === id);
  if (todos.length === 0 && closed.length === 0) return null;
  return h(
    "section",
    {},
    h("h2", {}, "要你動手"),
    todos.map((todo) => todoCard(page, view, actions, todo, false)),
    closedFold(`closed:${id}`, closedTodoEntries(`closed:${id}`, closed)),
  );
}

/** The topic's closed decisions as fold rows. */
function closedDecisionEntries(view: View, id: string): ClosedEntry[] {
  return view.closed_decisions
    .filter((entry) => entry.topic === id)
    .map((entry) => ({
      key: `closed-decision:${id}:${entry.home}/${entry.task}:${entry.ts}`,
      ts: entry.ts,
      home: entry.home,
      task: entry.task,
      text: entry.text,
      records: entry.records,
    }));
}

function decisions(page: Page, view: View, actions: Actions, id: string): Child {
  const topic = view.topics[id];
  const holds = view.holds.filter((hold) => hold.topic === id);
  const deferred = holds.filter((hold) => !hold.live);
  return h(
    "section",
    {},
    h("h2", {}, "待決"),
    topic?.close_reason == null
      ? null
      : h(
          "div",
          { class: "card" },
          h("span", { class: "pill warn" }, "提議關閉"),
          ` ${agentName()} 認為這個議題可以關了：${topic.close_reason}`,
          h(
            "div",
            { class: "btns" },
            h("button", { onclick: () => actions.topic("archive", { id }) }, "關閉並封存"),
            h("button", { onclick: () => actions.topic("keep", { id }) }, "先不關"),
          ),
        ),
    holds.filter((hold) => hold.live).map((hold) => holdCard(page, view, actions, hold, false)),
    deferred.length === 0
      ? null
      : h(
          "details",
          { "data-key": `deferred:${id}` },
          h("summary", {}, `暫緩 ${deferred.length}`),
          deferred.map((hold) => holdCard(page, view, actions, hold, false)),
        ),
    view.questions
      .filter((question) => question.topic === id)
      .map((question) => questionRow(view, actions, question, false)),
    closedFold(`closed-decisions:${id}`, closedDecisionEntries(view, id)),
  );
}

type Entry = { ts: number; row: Child; record: boolean };

/**
 * The topic's updates, newest first. Every board record shows; ledger lines
 * and summaries past the newest MAX_UPDATES fold into 更早的更新.
 */
function updateRows(view: View, actions: Actions, id: string): { rows: Entry[]; older: Entry[] } {
  const entries: Entry[] = [
    ...view.summaries
      .filter((summary: SummaryView) => summary.topic === id)
      .map((summary) => ({
        ts: summary.ts,
        row: summaryRow(view, actions, summary, false),
        record: false,
      })),
    ...view.updates
      .filter((update: UpdateView) => update.topic === id)
      .map((update) => ({
        ts: update.ts,
        row: updateRow(update),
        record: update.source !== "ledger",
      })),
  ];
  const sorted = entries.toSorted((a, b) => b.ts - a.ts);
  const cut = sorted.filter((entry) => !entry.record)[MAX_UPDATES];
  const older =
    cut === undefined ? [] : sorted.filter((entry) => !entry.record && entry.ts <= cut.ts);
  const folded = new Set(older);
  return { rows: sorted.filter((entry) => !folded.has(entry)), older };
}

function updates(view: View, actions: Actions, id: string): Child {
  const { rows, older } = updateRows(view, actions, id);
  const ledgerOff = view.homes
    .filter((home) => home.ledger_enabled === false)
    .map((home) => home.id);
  return h(
    "section",
    {},
    h("h2", {}, "更新"),
    ledgerOff.length === 0
      ? null
      : h(
          "p",
          { class: "note" },
          `帳本未開的 home：${ledgerOff.join("、")}。它們的 task 不會有更新；開帳本的指令見頁首的說明。`,
        ),
    rows.length === 0 ? h("p", { class: "note" }, "還沒有更新。") : rows.map((entry) => entry.row),
    older.length === 0
      ? null
      : h(
          "details",
          { "data-key": `older:${id}` },
          h("summary", {}, `更早的更新 ${older.length}`),
          older.map((entry) => entry.row),
        ),
  );
}

function agentCard(page: Page, actions: Actions, agent: AgentView): Child {
  const key = `direct:${agent.home}/${agent.task}`;
  const send = (): void => actions.direct(agent.home, agent.task, key);
  return h(
    "div",
    { class: "card" },
    h(
      "div",
      { class: "meta" },
      h("span", {}, light(agent)),
      h("b", {}, agent.task),
      h("span", { class: "pill" }, agent.home),
      agent.updated_at === null
        ? null
        : h("span", { class: "note" }, `最後更新 ${when(agent.updated_at)}`),
      agent.stale ? h("span", { class: "pill warn" }, "資料過期") : null,
    ),
    h("div", { class: "note" }, `${agent.state} ${agent.detail}`),
    h(
      "div",
      { class: "btns" },
      draftInput(page, actions, key, "只給這個 agent 的訊息", send),
      h("button", { onclick: send }, agent.home === "main" ? "直送" : `經 ${agent.home} 轉達`),
    ),
    agent.home === "main"
      ? null
      : h(
          "div",
          { class: "note" },
          "「已送達」只代表訊息到了 secondmate 的收件匣，它轉給 worker 可能還要一點時間。",
        ),
    writeRows(
      page,
      actions,
      (write) => write.kind === "direct" && write.home === agent.home && write.task === agent.task,
    ),
  );
}

/** Backlog items of this topic that no worker has been dispatched for, folded by default. */
function queued(view: View, id: string): Child {
  const items = view.queued.filter((item) => item.topic === id);
  if (items.length === 0) return null;
  return h(
    "section",
    {},
    h(
      "details",
      { "data-key": `queued:${id}` },
      h("summary", {}, `排隊中 ${items.length}`),
      items.map(queuedRow),
    ),
  );
}

export function topicPage(page: Page, view: View, actions: Actions, id: string): Child {
  if (view.topics[id] === undefined) {
    return h(
      "p",
      {},
      "沒有這個議題。",
      h("button", { class: "link", onclick: () => actions.open(null) }, "回首頁"),
    );
  }
  const key = `message:${id}`;
  const send = (): void => actions.message(id, key);
  return [
    h(
      "div",
      { class: "narrow" },
      h("p", {}, h("button", { class: "link", onclick: () => actions.open(null) }, "← 回首頁")),
      header(page, view, actions, id),
      handsOn(page, view, actions, id),
      decisions(page, view, actions, id),
      updates(view, actions, id),
      h(
        "section",
        {},
        h("h2", {}, "關聯 agent"),
        view.agents
          .filter((agent) => agent.topic === id)
          .map((agent) => agentCard(page, actions, agent)),
      ),
      queued(view, id),
    ),
    h(
      "div",
      { class: "composer" },
      h(
        "div",
        { class: "inner" },
        h(
          "div",
          { class: "btns" },
          draftInput(
            page,
            actions,
            key,
            `給 ${agentName()} 的訊息（會附上議題「${view.topics[id]?.name ?? id}」）`,
            send,
          ),
          h("button", { class: "primary", onclick: send }, `送給 ${agentName()}`),
        ),
        writeRows(
          page,
          actions,
          (write) => (write.kind === "message" || write.kind === "notice") && write.topic === id,
        ),
      ),
    ),
  ];
}
