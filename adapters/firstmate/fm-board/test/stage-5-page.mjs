// The captain's path through the real page, run by browser.mjs in a headless
// Firefox. Every step waits for what the captain would see next.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const topic = (...args) => execFileSync(process.env.TB_TOPIC, args, { encoding: "utf8" });
const has = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`;
const queueHas = (queue, name) =>
  `[...document.querySelectorAll('.queue[data-queue="${queue}"] .topic')].some((card) => card.innerText.includes(${JSON.stringify(name)}))`;

/** Chooses an option of the first <select> that offers it, as a user would. */
function choose(optionText) {
  return `(() => {
    for (const select of document.querySelectorAll("select")) {
      const option = [...select.options].find((entry) => entry.textContent === ${JSON.stringify(optionText)});
      if (option) { select.value = option.value; select.dispatchEvent(new Event("change", { bubbles: true })); return true; }
    }
    return false;
  })()`;
}

/**
 * Drags a topic card with synthetic drag events onto another card's upper or lower half, or
 * onto the queue itself (ontoName null), which is where a drop lands at the end of the queue.
 */
function drag(name, queue, ontoName, half = "upper") {
  return `(() => {
    const card = [...document.querySelectorAll(".topic")].find((entry) => entry.innerText.includes(${JSON.stringify(name)}));
    const box = document.querySelector('.queue[data-queue="${queue}"]');
    const onto = ${JSON.stringify(ontoName)} === null ? box : [...box.querySelectorAll(".topic")].find((entry) => entry.innerText.includes(${JSON.stringify(ontoName)}));
    const data = new DataTransfer();
    const fire = (target, type, y) => target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, clientY: y }));
    fire(card, "dragstart", 0);
    const at = onto.getBoundingClientRect();
    fire(onto, "dragover", ${JSON.stringify(half)} === "upper" ? at.top + 1 : at.bottom - 1);
    return { card, onto, fire };
  })()`;
}

/** Every queue's topic names, as "high|normal|later" with each queue comma-separated. */
const queueOrder = `["high", "normal", "later"].map((queue) => [...document.querySelectorAll(\`.queue[data-queue="\${queue}"] .topic .name\`)].map((el) => el.textContent).join(",")).join("|")`;

export default async function run(page) {
  await page.waitFor("the home page", has("等你決定"));
  for (const title of ["最近的結果", "進行中", "排定的", "未分類", "優先順序", "待辦（不自動開工）"]) {
    await page.waitFor(`section ${title}`, has(title));
  }
  await page.waitFor("the milestone summary", has("PR 開好了"));

  // Queued work nobody tagged with a topic is listed under 未分類, folded. A captain hold
  // without a topic already has its card, so it is not listed a second time.
  const untagged = `document.querySelector('details[data-key="queued:untagged"]')`;
  await page.waitFor("the untagged queued items", `${untagged} !== null`);
  if ((await page.evaluate(`${untagged}.querySelector("summary").textContent`)) !== "沒標議題的排隊項目 1")
    throw new Error("only work without a topic and without its own card counts as untagged");
  if (!(await page.evaluate(`${untagged}.closest("section").querySelector("h2").textContent === "未分類"`)))
    throw new Error("untagged queued items belong under 未分類");
  if (await page.evaluate(`${untagged}.open`)) throw new Error("the list starts folded");
  await page.click('details[data-key="queued:untagged"] summary', "沒標議題的排隊項目");
  await page.waitFor("the untagged item", `${untagged}.innerText.includes("loose-1") && ${untagged}.innerText.includes("Loose work") && ${untagged}.innerText.includes("可以派")`);
  if (await page.evaluate(`${untagged}.innerText.includes("loose-call") || ${untagged}.innerText.includes("next-1")`))
    throw new Error("a hold with its own card and tagged work must not be listed as untagged");
  // The adapter shows one decision at a time: call-1 (Billing) is in front, the loose call
  // waits its turn as one line, with no question and no buttons.
  await page.waitFor("the loose call waiting its turn", has("還有 1 個決定排隊，輪到時才顯示"));
  if (await page.evaluate(has("這個要不要做？"))) throw new Error("a decision waiting its turn must not show its question");
  // A filter that hides both counts the one in front and the one waiting apart; the line clears it.
  await page.type('[data-key="filter-text"]', "Login");
  await page.waitFor("the owed line under a filter", has("這個篩選之外還有：等你決定 1、決定排隊 1"));
  await page.click("p.owed button", "這個篩選之外還有");
  await page.waitFor("the filter cleared", `!${has("這個篩選之外還有")} && ${has("還有 1 個決定排隊，輪到時才顯示")}`);

  // 未分類 lists what still needs a topic; finished work without one is folded below it,
  // still taggable. A mate's own record is not work and appears nowhere.
  const unsortedSection = `${untagged}.closest("section")`;
  const finished = `document.querySelector('details[data-key="finished:untagged"]')`;
  const openText = `[...${unsortedSection}.children].filter((child) => child.tagName !== "DETAILS").map((child) => child.innerText).join("\\n")`;
  await page.waitFor("the open untagged worker", `${openText}.includes("open-1") && ${openText}.includes("沒有標記")`);
  if (await page.evaluate(`${openText}.includes("done-1") || ${openText}.includes("done-2") || ${openText}.includes("已落地")`))
    throw new Error("finished work must not read as needing a topic");
  if (await page.evaluate(`${unsortedSection}.innerText.includes("old-mate") || ${unsortedSection}.innerText.includes("一個 mate 的回報")`))
    throw new Error("a mate's own record, and a summary filed under it, are not work waiting for a topic");
  if ((await page.evaluate(`${finished}.querySelector("summary").textContent`)) !== "已結束、沒標議題 2")
    throw new Error("the folded list counts finished items without a topic");
  if (await page.evaluate(`${finished}.open`)) throw new Error("the finished list starts folded");
  await page.click('details[data-key="finished:untagged"] summary', "已結束、沒標議題");
  await page.waitFor(
    "the finished items with their reasons",
    `${finished}.innerText.includes("done-1") && ${finished}.innerText.includes("沒有標記") && ${finished}.innerText.includes("done-2") && ${finished}.innerText.includes("標記的議題不存在") && ${finished}.innerText.includes("已落地，沒人標議題。")`,
  );
  if (await page.evaluate(`${finished}.innerText.includes("一個 mate 的回報")`))
    throw new Error("only the summaries of the listed finished work are folded with it");
  if ((await page.evaluate(`${finished}.querySelectorAll("select").length`)) !== 2)
    throw new Error("each finished item can still be filed under a topic");

  // Something the captain has to do by hand: its own section, guidance as plain text, each
  // command exactly as written with its own copy button, and a claim that firstmate checks
  // before the item goes away.
  const COMMAND = 'sudo x --now "a b" && echo $HOME `date`\n\tps | grep x';
  const SECOND = "echo two";
  const todo = (expression) => `(() => { const card = document.querySelector('[data-todo="todo-1"]'); return ${expression}; })()`;
  const todoButtons = todo(`[...card.querySelectorAll("button")].map((button) => button.textContent).join("|")`);
  const cardOf = (name) =>
    `[...document.querySelectorAll(".topic")].find((card) => card.innerText.includes(${JSON.stringify(name)})).innerText`;
  await page.waitFor("the hands-on card", `document.querySelector('[data-todo="todo-1"]') !== null`, 15000);
  const blocks = await page.evaluate(todo(`JSON.stringify([...card.querySelectorAll("pre.cmd")].map((pre) => pre.textContent))`));
  if (blocks !== JSON.stringify([COMMAND, SECOND])) throw new Error(`each command must be its own block, exactly as written, got ${blocks}`);
  if ((await page.evaluate(todo(`card.querySelectorAll(".cmd-row button").length`))) !== 2)
    throw new Error("each command must have its own copy button");
  if ((await page.evaluate(todo(`card.querySelector(".guide")?.textContent ?? ""`))) !== "只在你人在電腦前時做。")
    throw new Error("the guidance must be shown as plain text, apart from the commands");
  const shapeOf = (id) =>
    `(() => { const card = document.querySelector('[data-todo="${id}"]'); return JSON.stringify([[...card.querySelectorAll("pre.cmd")].map((pre) => pre.textContent), card.querySelectorAll(".cmd-row button").length, card.querySelector(".guide")?.textContent ?? null]); })()`;
  const shapes = {
    "old-note": [["只在你人在電腦前時做。"], 1, null],
    "old-only": [[], 0, null],
    "new-note": [[], 0, "只在你人在電腦前時做。"],
  };
  for (const [id, expected] of Object.entries(shapes)) {
    await page.waitFor(`the item ${id}`, `document.querySelector('[data-todo="${id}"]') !== null`);
    const shape = await page.evaluate(shapeOf(id));
    if (shape !== JSON.stringify(expected)) throw new Error(`${id} must show ${JSON.stringify(expected)}, got ${shape}`);
  }
  if (!(await page.evaluate(todo(`card.closest("section").querySelector("h2").textContent === "要你動手"`))))
    throw new Error("a hands-on item belongs in its own section, not among the decisions");
  // A closed hands-on item with no topic (one an older board adopted, stage-5-page.sh): 沒有議題,
  // right after 要你動手, folded as 已關 N like a topic page's, each row opening to its records.
  topic("todo", "done", "loose-hand");
  const noTopic = `document.querySelector('details[data-key="closed-no-topic"]')`;
  await page.waitFor("the closed items with no topic", `${noTopic} !== null`, 15000);
  if ((await page.evaluate(`${noTopic}.closest("section").querySelector("h2").textContent`)) !== "沒有議題")
    throw new Error("closed hands-on items with no topic belong under 沒有議題");
  if ((await page.evaluate(`${noTopic}.closest("section").previousElementSibling?.querySelector("h2")?.textContent ?? ""`)) !== "要你動手")
    throw new Error("沒有議題 comes right after 要你動手");
  if ((await page.evaluate(`${noTopic}.querySelector("summary").textContent`)) !== "已關 1")
    throw new Error("the fold counts the closed items with no topic");
  if (await page.evaluate(`${noTopic}.open`)) throw new Error("the closed items start folded");
  await page.click('details[data-key="closed-no-topic"] > summary', "已關 1");
  const noTopicRow = `${noTopic}.querySelector("details.closed")`;
  await page.waitFor("the closed item's line", `${noTopicRow}.querySelector("summary").innerText.includes("要你動手「沒有議題的動手」已關：做完了")`);
  if (await page.evaluate(`${noTopicRow}.open`)) throw new Error("a closed item's records start folded");
  await page.click('details[data-key="closed-no-topic"] details.closed > summary', "已關");
  await page.waitFor("the closed item's records", `${noTopicRow}.querySelectorAll(".upd").length === 1 && ${noTopicRow}.querySelector(".upd").innerText.includes("要你動手「沒有議題的動手」已關：做完了")`);

  await page.waitFor("the count on the topic card", `${cardOf("Login")}.includes("要你動手 1")`);
  await page.click('[data-todo="todo-1"] button', "複製指令");
  await page.waitFor("the commands selected when the browser refuses to copy", `getSelection().toString() === ${JSON.stringify(COMMAND)}`);
  await page.evaluate("getSelection().removeAllRanges()");
  await page.evaluate(todo(`card.querySelectorAll(".cmd-row button")[1].click()`));
  await page.waitFor("only the second command selected", `getSelection().toString() === ${JSON.stringify(SECOND)}`);
  await page.evaluate("getSelection().removeAllRanges()");
  await page.pointerClick('[data-todo="todo-1"] button', "已選取");
  await page.waitFor("the copy confirmed after a real click", todo(`card.innerText.includes("已複製")`));
  await page.click('[data-todo="todo-1"] button', "做完了");
  await page.waitFor("the claim shown", todo(`card.innerText.includes("你已按做完了，等 first mate 驗證")`));
  if ((await page.evaluate(todoButtons)).includes("做完了")) throw new Error("a claimed item must not offer its buttons again");
  await page.waitFor("the count gone from the topic card", `!${cardOf("Login")}.includes("要你動手")`);
  topic("todo", "failed", "todo-1", "--reason", "服務沒起來");
  await page.waitFor("firstmate's failed check", todo(`card.innerText.includes("first mate 驗證沒過：服務沒起來")`), 15000);
  await page.waitFor("the buttons back", `${todoButtons}.includes("做完了")`);
  topic("todo", "obsolete", "todo-1", "--reason", "改用別的做法");
  await page.waitFor("the item marked as no longer needed", todo(`card.innerText.includes("first mate：不再需要了。改用別的做法")`), 15000);
  if ((await page.evaluate(todoButtons)).includes("做完了")) throw new Error("an item that is no longer needed only offers to take it down");
  await page.click('[data-todo="todo-1"] button', "好，撤下");
  await page.waitFor("the confirmation", todo(`card.innerText.includes("會記成你的答覆「撤下」")`));
  await page.click('[data-todo="todo-1"] .confirm button', "確定");
  // The board takes the item off at once and tells firstmate through the deliverer.
  await page.waitFor("the item taken off the page", `document.querySelector('[data-todo="todo-1"]') === null`, 15000);
  const told = () => fs.readFileSync(process.env.TB_LOG, "utf8").includes("stdin=使用者在看板上：「Restart x」撤下（todo-1）");
  for (let tries = 0; tries < 60 && !told(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 150));
  if (!told()) throw new Error("taking the item down must tell firstmate in the captain's words");
  await page.waitFor("the agent", has("ship-a"));
  const rowOf = (task) =>
    `[...document.querySelectorAll(".row")].find((row) => row.innerText.includes("${task}")).innerText`;
  await page.waitFor("the worker that never started", `${rowOf("quiet-b")}.includes("還沒開始第一輪")`);
  if (await page.evaluate(`${rowOf("ship-a")}.includes("還沒開始第一輪")`))
    throw new Error("a worker that has started must not be marked as unstarted");

  // Answer the pending decision: option, then one send that says what it will do.
  await page.click(".card button", "合併");
  await page.waitFor("the second step", has("送出後解除等待，這一項回到排隊中"));
  await page.waitFor("the confirmation wording", has("看板自己不會合併或捨棄"));
  const sends = await page.evaluate(
    `[...document.querySelectorAll(".confirm button")].map((el) => el.textContent).join("|")`,
  );
  if (sends !== "送出|取消") throw new Error(`the second step must offer one send and a cancel, got ${sends}`);
  if (await page.evaluate(has("沒有註明"))) throw new Error("a recorded outcome must not be called the default");
  await page.click(".confirm button", "送出");
  await page.waitFor("the answer to be delivered", has("已送達"));
  const released = () => fs.readFileSync(process.env.TB_LOG, "utf8").includes("stdin=call-1\t合併\t合併\trelease");
  for (let tries = 0; tries < 60 && !released(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 150));
  if (!released()) throw new Error("the answer must release the decision as it recorded");
  // first mate puts the answered call off until December, so the loose call's turn comes.
  const backlog = `${process.env.TB_MAIN}/data/backlog.md`;
  const held = "(hold: 要合併嗎？ 選項：合併 | 先不要) (hold-kind: captain)";
  fs.writeFileSync(backlog, fs.readFileSync(backlog, "utf8").replace(held, `${held} (hold-until: 2026-12-01)`));
  await page.waitFor("the loose call's turn", has("這個要不要做？"), 15000);
  if (await page.evaluate(has("個決定排隊，輪到時才顯示"))) throw new Error("no decision waits once the loose call is in front");
  // A decision that records no outcome: a typed answer says it will be released by default.
  const looseCard = `[...document.querySelectorAll(".card")].find((card) => card.innerText.includes("這個要不要做？"))`;
  await page.evaluate(`(() => { const input = ${looseCard}.querySelector("input"); input.value = "先給我更多資訊"; input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await page.evaluate(`(() => { [...${looseCard}.querySelectorAll("button")].find((el) => el.textContent === "送出").click(); return true; })()`);
  await page.waitFor("the default outcome", `${looseCard}.innerText.includes("回到排隊中") && ${looseCard}.innerText.includes("沒有註明")`);
  await page.evaluate(`(() => { [...${looseCard}.querySelectorAll(".confirm button")].find((el) => el.textContent === "取消").click(); return true; })()`);
  await page.waitFor("the cancelled confirmation", `!${looseCard}.innerText.includes("沒有註明")`);

  // New topics are in the normal queue at once, last, in the order they were made; nothing waits.
  const normal = await page.evaluate(`[...document.querySelectorAll('.queue[data-queue="normal"] .topic .name')].map((el) => el.textContent).join(",")`);
  if (normal !== "Billing,Idea,Side idea") throw new Error(`new topics must land last in normal, got ${normal}`);
  if (await page.evaluate(`${has("提議中")} || [...document.querySelectorAll("button")].some((el) => el.textContent.startsWith("確認"))`))
    throw new Error("the page must not show anything waiting to be confirmed");

  // Merge a topic into another from its page.
  await page.click(".topic button", "Side idea");
  await page.waitFor("the side topic's page", `document.querySelector(".titleline h2")?.textContent === "Side idea"`);
  await page.click(".menu > button");
  await page.click(".menu .items button", "併入其他議題…");
  if (!(await page.evaluate(choose("Login")))) throw new Error("no merge menu offering Login");
  await page.waitFor("the merge warning", has("併入之後不能拆開"));
  await page.click(".confirm button", "併入「Login」");
  await page.waitFor("the merged topic gone", has("沒有這個議題"));
  await page.click("button.link", "回首頁");
  await page.waitFor("the home page after the merge", has("優先順序"));
  await page.waitFor("the merged topic to disappear", `!${has("Side idea")}`);

  // Drag a topic out of "later": the order follows, and the notice is announced.
  await page.evaluate(`(() => { const d = ${drag("Parked", "high", "Login")}; d.fire(d.onto, "drop", 0); d.fire(d.card, "dragend", 0); return true; })()`);
  await page.waitFor("the dragged topic in the high queue", queueHas("high", "Parked"));
  await page.waitFor("the dispatch notice countdown", has("秒後會通知 first mate；拖回"));
  const order = await page.evaluate(`[...document.querySelectorAll('.queue[data-queue="high"] .topic .name')].map((el) => el.textContent).join(",")`);
  if (order !== "Parked,Login") throw new Error(`dropping above a card must insert before it, got ${order}`);
  // A drag that ends without a drop puts the card back.
  await page.evaluate(`(() => { const d = ${drag("Parked", "later", null)}; d.fire(d.card, "dragend", 0); return true; })()`);
  await page.waitFor("the cancelled drag to snap back", queueHas("high", "Parked"));

  // A topic card has no menu: every move the page offers is a drag. Each drop below lands
  // where the old menu's "first" or "last" of a queue did, and is checked against what the
  // board sent back: the drag's end redraws from the board's view, so only an accepted move
  // shows the new order. The last move restores the order the rest of the walk expects.
  if ((await page.evaluate(`document.querySelectorAll(".topic").length`)) === 0)
    throw new Error("the sidebar must show topic cards");
  if ((await page.evaluate(`document.querySelectorAll(".topic select, .topic option").length`)) !== 0)
    throw new Error("a topic card must not carry a menu for moving it");
  const moves = [
    ["Login", "later", null, "upper", "Parked|Billing,Idea|Login", "into an empty queue, into later"],
    ["Billing", "later", "Login", "lower", "Parked|Idea|Login,Billing", "last of later"],
    ["Idea", "later", "Login", "upper", "Parked||Idea,Login,Billing", "first of later"],
    ["Billing", "later", "Idea", "upper", "Parked||Billing,Idea,Login", "first, within one queue"],
    ["Billing", "normal", null, "upper", "Parked|Billing|Idea,Login", "out of later into an empty queue"],
    ["Login", "high", "Parked", "lower", "Parked,Login|Billing|Idea", "last of high, out of later"],
    ["Login", "high", "Parked", "upper", "Login,Parked|Billing|Idea", "first of high, within one queue"],
    ["Login", "high", "Parked", "lower", "Parked,Login|Billing|Idea", "last, within one queue"],
    ["Idea", "normal", "Billing", "upper", "Parked,Login|Idea,Billing|", "first of normal"],
    ["Idea", "normal", null, "upper", "Parked,Login|Billing,Idea|", "last of normal, dropped on the queue"],
  ];
  for (const [name, queue, onto, half, expected, what] of moves) {
    await page.evaluate(`(() => { const d = ${drag(name, queue, onto, half)}; d.fire(d.onto, "drop", 0); d.fire(d.card, "dragend", 0); return true; })()`);
    await page.waitFor(`a drag ${what}: ${expected}`, `${queueOrder} === ${JSON.stringify(expected)}`);
  }

  // The topic page: rename, message firstmate, direct message.
  // Work that is queued but not dispatched yet: counted on the card, listed on the topic page.
  await page.waitFor("the queued count on the topic card", `[...document.querySelectorAll(".topic")].some((card) => card.innerText.includes("Billing") && card.innerText.includes("排隊 3"))`);
  await page.click(".topic button", "Billing");
  await page.waitFor("the topic page", has("關聯 agent"));
  await page.waitFor("the folded queued section", `[...document.querySelectorAll("details:not([open]) > summary")].some((entry) => entry.textContent === "排隊中 3")`);
  await page.click("summary", "排隊中 3");
  for (const text of ["Next step", "可以派", "停著：waiting for a vendor", "等你決定"]) {
    await page.waitFor(`queued row text ${text}`, `[...document.querySelectorAll("details[open]")].some((box) => box.innerText.includes(${JSON.stringify(text)}))`);
  }
  // The decision answered on the page is closed: under 待決, after the open ones, folded as
  // 已關 N like the hands-on items, its row opening to its records; its line stays in 更新.
  const closedDecisions = `document.querySelector('details[data-key="closed-decisions:billing"]')`;
  await page.waitFor("the closed decisions", `${closedDecisions} !== null`, 15000);
  if ((await page.evaluate(`${closedDecisions}.closest("section").querySelector("h2").textContent`)) !== "待決")
    throw new Error("closed decisions belong under 待決");
  if (!(await page.evaluate(`${closedDecisions}.closest("section").lastElementChild === ${closedDecisions}`)))
    throw new Error("closed decisions come after the open ones");
  if ((await page.evaluate(`${closedDecisions}.querySelector("summary").textContent`)) !== "已關 1")
    throw new Error("the fold counts the closed decisions");
  if (await page.evaluate(`${closedDecisions}.open`)) throw new Error("the closed decisions start folded");
  await page.click('details[data-key="closed-decisions:billing"] > summary', "已關 1");
  const decisionRow = `${closedDecisions}.querySelector("details.closed")`;
  await page.waitFor("the closed decision's line", `${decisionRow}.querySelector("summary").innerText.includes("main/call-1 在看板回答 main/call-1：合併")`);
  await page.click('details[data-key="closed-decisions:billing"] details.closed > summary', "在看板回答");
  await page.waitFor("the closed decision's records, newest first", `${decisionRow}.querySelectorAll(".upd").length === 2 && ${decisionRow}.querySelector(".upd").innerText.includes("在看板回答") && ${decisionRow}.querySelectorAll(".upd")[1].innerText.includes("待決事項「A call」已開")`);
  if (!(await page.evaluate(`[...document.querySelectorAll("section")].find((box) => box.querySelector("h2")?.textContent === "更新").innerText.includes("在看板回答 main/call-1：合併")`)))
    throw new Error("a closed decision's lines stay in 更新");
  await page.click("button", "編輯");
  await page.type('[data-key="name:billing"]', "Billing X");
  await page.click("button", "儲存");
  await page.waitFor("the new name", `document.querySelector(".titleline h2")?.textContent === "Billing X"`);
  await page.type('[data-key="message:billing"]', "先做這個");
  await page.click("button", "送給 first mate");
  await page.waitFor("the message to be delivered", `document.querySelector(".composer").innerText.includes("已送達")`);
  await page.type('[data-key="direct:main/ship-a"]', "/compact");
  await page.click("button", "直送");
  await page.waitFor("the refusal of a command-like message", has("會被當成指令"));
  await page.type('[data-key="direct:main/ship-a"]', "看一下 CI");
  await page.click("button", "直送");
  await page.waitFor("the direct message to be delivered", `[...document.querySelectorAll(".wr")].some((row) => row.innerText.includes("看一下 CI") && row.innerText.includes("已送達"))`);

  // Archive from the menu, then reopen from the sidebar.
  await page.click(".menu > button");
  await page.click(".menu .items button", "封存");
  await page.waitFor("the archive explanation", has("已經在跑的不會停"));
  await page.click(".confirm button.danger", "封存");
  await page.waitFor("the archived mark", has("已封存"));
  await page.click("button.link", "← 回首頁");
  await page.waitFor("the home page again", has("優先順序"));
  await page.click("summary", "已封存");
  await page.click("details button", "重開");
  await page.waitFor("the reopened topic in its queue", queueHas("normal", "Billing X"));
  if (process.env.TB_SHOTS) await page.screenshot(`${process.env.TB_SHOTS}/home.png`);

  // A tab left in the background does not poll; it catches up the moment it is shown again,
  // also when the board was restarted meanwhile.
  const setHidden = (hidden) =>
    `(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => ${hidden} }); document.dispatchEvent(new Event("visibilitychange")); return true; })()`;
  await page.evaluate(setHidden(true));
  topic("create", "背景分頁新議題", "--goal", "分頁在背景時建的");
  topic("restart");
  await new Promise((resolve) => setTimeout(resolve, 7000));
  if (await page.evaluate(has("背景分頁新議題"))) throw new Error("a hidden tab must not poll");
  await page.evaluate(setHidden(false));
  await page.waitFor("the topic made while the tab was hidden", has("背景分頁新議題"), 5000);

  // The board stops answering: the page says so, refuses to send, and recovers by itself.
  topic("stop");
  await page.waitFor("the service-down banner", has("看板服務沒有回應"), 30000);
  if (process.env.TB_SHOTS) await page.screenshot(`${process.env.TB_SHOTS}/down.png`);
  topic("open");
  await page.waitFor("the banner to clear", `!${has("看板服務沒有回應")}`, 30000);

  // The token is reset under an open page: it says so, and the new link works in the same tab,
  // although opening it there changes only the fragment.
  topic("reset-token");
  await page.waitFor("the reset-token banner", has("token 已重置或無效"), 30000);
  await page.waitFor("the board still on screen", has("優先順序"));
  const fresh = topic("open").trim();
  await page.evaluate(`void location.assign(${JSON.stringify(fresh)})`);
  await page.waitFor("the page to load with the new token", `${has("優先順序")} && !${has("token 已重置或無效")}`, 30000);
  await page.waitFor("the token gone from the address bar", "location.hash === ''");

  // A scheduled topic: its open occurrence sits in 現在 above 高, the topic is listed under 排程
  // and nowhere in 待辦's box or 排定的, and the captain's close takes it out of 現在.
  const strip = `document.querySelector('[data-strip="now"]')`;
  const column = `document.querySelector('[data-column="schedules"]')`;
  await page.waitFor("the open occurrence in 現在", `${strip} !== null && ${strip}.innerText.includes("Weekly") && ${strip}.innerText.includes("快到了") && ${strip}.innerText.includes("hard-rt")`);
  if (!(await page.evaluate(`${strip}.compareDocumentPosition(document.querySelector('.queue[data-queue="high"]')) === Node.DOCUMENT_POSITION_FOLLOWING`)))
    throw new Error("現在 belongs above 高");
  await page.waitFor("the scheduled topic under 排程", `${column}.innerText.includes("Weekly") && ${column}.innerText.includes("下一場")`);
  if (await page.evaluate(queueHas("later", "Weekly"))) throw new Error("a scheduled topic is not a card in 待辦's box");
  const later = `[...document.querySelectorAll("section h2")].find((title) => title.textContent === "排定的").closest("section").innerText`;
  if (await page.evaluate(`${later}.includes("Weekly")`)) throw new Error("排定的 must not list a scheduled topic");
  if (await page.evaluate(`${strip}.querySelector("[draggable]") !== null || ${column}.querySelector("[draggable]") !== null`))
    throw new Error("nothing under 現在 or 排程 can be dragged");
  await page.click('[data-strip="now"] button', "這一場結束…");
  await page.waitFor("the close question", `${strip}.innerText.includes("不用準備了")`);
  await page.click('[data-strip="now"] .confirm button.danger', "標成做完");
  await page.waitFor("現在 to empty", `${strip} === null`);
  await page.waitFor("the schedule still under 排程", `${column}.innerText.includes("Weekly")`);
}
