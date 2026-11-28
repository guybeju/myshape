// The page with an aggregator on the other side, run by browser.mjs in a
// headless Firefox for stage-7-page.sh. TB_PAGE_MODE=connected walks a board
// fed by stub-plain, bound outside the root as TB_PROGRAM and confirmed on the
// page first, on a PC's 1300 px; TB_PAGE_MODE=alone walks a board with nothing
// connected on a phone's 390 px with a touch screen (TB_POINTER=coarse), where
// a finger drags cards by their ⠿; TB_PAGE_MODE=remote opens a board whose
// program waits for confirmation by its remote name, through
// serve-stand-in.mjs, on a phone's 390 px.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { serveStandIn } from "./kit/serve-stand-in.mjs";

const topic = (...args) => execFileSync(process.env.TB_TOPIC, args, { encoding: "utf8" });
const has = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** True when the first element `css` matches is on screen, not only in the page. */
const visible = (css) =>
  `(() => { const el = document.querySelector(${JSON.stringify(css)}); return el !== null && el.getClientRects().length > 0; })()`;
const TABS = ["等你", "佇列", "動態", "更多"];

/** Shows a part of the home page by its tab, as the captain does. */
async function showTab(page, label) {
  await page.click(".tabs button", label);
  await page.waitFor(`the ${label} tab`, `document.querySelector(".tabs button.on")?.textContent.startsWith(${JSON.stringify(label)}) === true`);
}

/** The page must never call the agent side by Firstmate's name. */
async function noFirstmate(page, where) {
  const text = await page.text();
  if (/first mate|firstmate/i.test(text)) throw new Error(`the page names Firstmate on ${where}:\n${text}`);
}

/**
 * Every tab of the home page: the 等你 count is on screen on each, and none
 * names Firstmate (only the tab on screen is in the page's text). Ends on 等你.
 */
async function everyTab(page, where) {
  for (const label of TABS) {
    await showTab(page, label);
    if (!(await page.evaluate(`${visible('.tabs button[data-tab="wait"] .count')} && /^\\d+$/.test(document.querySelector('.tabs button[data-tab="wait"] .count').textContent)`)))
      throw new Error(`the 等你 count must be on screen on the ${label} tab`);
    await noFirstmate(page, `${where}, ${label} tab`);
  }
  await showTab(page, "等你");
}

function received() {
  const file = `${process.env.TB_AGG}/received.jsonl`;
  return fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
}

/** Drags a topic card onto a queue with synthetic drag events, the way stage-5-page.mjs does. */
function dropOnQueue(name, queue) {
  return `(() => {
    const card = [...document.querySelectorAll(".topic")].find((entry) => entry.innerText.includes(${JSON.stringify(name)}));
    const box = document.querySelector('.queue[data-queue="${queue}"]');
    const data = new DataTransfer();
    const fire = (target, type) => target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, clientY: box.getBoundingClientRect().bottom - 1 }));
    fire(card, "dragstart");
    fire(box, "dragover");
    fire(box, "drop");
    fire(card, "dragend");
    return true;
  })()`;
}

/** Drags a topic card onto the upper half of another card with synthetic drag events, as the mouse does. */
function dropOnCard(name, ontoName) {
  return `(() => {
    const card = [...document.querySelectorAll(".topic")].find((entry) => entry.innerText.includes(${JSON.stringify(name)}));
    const onto = [...document.querySelectorAll(".topic")].find((entry) => entry.innerText.includes(${JSON.stringify(ontoName)}));
    const data = new DataTransfer();
    const fire = (target, type) => target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, clientY: onto.getBoundingClientRect().top + 1 }));
    fire(card, "dragstart");
    fire(onto, "dragover");
    fire(onto, "drop");
    fire(card, "dragend");
    return true;
  })()`;
}

/** Keeps the body of every move the page asks the board for, in window.__moves. */
const RECORD_MOVES = `(() => {
  window.__moves = [];
  const send = window.fetch;
  window.fetch = (url, init) => {
    if (String(url).endsWith("/topics/move")) window.__moves.push(init.body);
    return send(url, init);
  };
  return true;
})()`;
const LAST_MOVE = "window.__moves.at(-1) ?? null";
/** A queue's cards on the page, by topic id. */
const order = (queue) =>
  `[...document.querySelectorAll('.queue[data-queue="${queue}"] .topic')].map((card) => card.dataset.topic).join(",")`;

/** The middle and the top of the first element `css` matches, in the window. */
async function spot(page, css) {
  return JSON.parse(await page.evaluate(`(() => { const box = document.querySelector(${JSON.stringify(css)}).getBoundingClientRect(); return JSON.stringify({ x: box.left + box.width / 2, y: box.top + box.height / 2, top: box.top }); })()`));
}

/** A finger holds a card's ⠿ past the long press, slides it to `to` and lets go. */
async function fingerDrag(page, id, to) {
  const handle = await spot(page, `.topic[data-topic="${id}"] .handle`);
  const away = { x: handle.x, y: handle.y + (to.y > handle.y ? 30 : -30) };
  await page.touchDrag([handle, away, to], 600);
}

/**
 * A finger's long press on ⠿ drags a card on a phone: within the list it
 * reorders, and on the 待辦 segment button it puts the card last there. Each
 * asks the board for exactly what the mouse's drag of the same move does.
 * Starts and ends on 佇列 with 一般 shown, 一 in 待辦 and 二 in 一般.
 */
async function fingerDrags(page) {
  await page.evaluate(RECORD_MOVES);
  await page.evaluate("window.scrollTo(0, 0)");
  await page.waitFor("一 and 二 in 一般", `${order("normal")} === "one,two"`);
  await page.evaluate(dropOnCard("二", "一"));
  await page.waitFor("the mouse's reorder", `${order("normal")} === "two,one"`, 15000);
  const mouseReorder = await page.evaluate(LAST_MOVE);
  topic("move", "one", "normal", "--first");
  await page.waitFor("一 back first in 一般", `${order("normal")} === "one,two"`, 15000);
  const one = await spot(page, '.topic[data-topic="one"]');
  await fingerDrag(page, "two", { x: one.x, y: one.top + 8 });
  await page.waitFor("the finger's reorder", `${order("normal")} === "two,one"`, 15000);
  const fingerReorder = await page.evaluate(LAST_MOVE);
  if (fingerReorder !== mouseReorder || mouseReorder !== JSON.stringify({ id: "two", queue: "normal", before: "one" }))
    throw new Error(`a finger's reorder must ask what the mouse's does: finger ${fingerReorder}, mouse ${mouseReorder}`);

  await page.evaluate(dropOnQueue("一", "later"));
  await page.waitFor("一 in 待辦 by the mouse", `${order("later")} === "one"`, 15000);
  const mouseToLater = await page.evaluate(LAST_MOVE);
  topic("move", "one", "normal");
  await page.waitFor("一 back in 一般", `${order("normal")} === "two,one"`, 15000);
  await fingerDrag(page, "one", await spot(page, '.segs button[data-segment="later"]'));
  await page.waitFor("一 in 待辦 by the finger", `${order("later")} === "one"`, 15000);
  const fingerToLater = await page.evaluate(LAST_MOVE);
  if (fingerToLater !== mouseToLater || mouseToLater !== JSON.stringify({ id: "one", queue: "later" }))
    throw new Error(`a finger's drop on 待辦 must ask what the mouse's drag to its end does: finger ${fingerToLater}, mouse ${mouseToLater}`);
  const listed = JSON.parse(topic("list", "--json")).find((entry) => entry.id === "one");
  if (listed?.queue !== "later") throw new Error(`list --json must agree with the finger's drop, got ${JSON.stringify(listed)}`);
}

/**
 * AT10.4 and the hands-on states of AT10.7: the card shows the guidance as
 * plain text and one block per command, each copy button copying exactly its
 * command, an item with no command shows no block, and no state or confirm
 * step names Firstmate.
 */
async function handsOn(page) {
  const commands = ["sudo openconnect vpn.example.com", "ping -c1 intra \\\n  && echo ok"];
  topic("todo", "add", "k1", "登入 VPN", "--topic", "solo", "--do", "用公司帳號登入", "--note", "只在公司網路外",
    "--cmd", commands[0], "--cmd", commands[1]);
  topic("todo", "add", "k2", "按一下", "--topic", "solo", "--do", "按一下就好");
  topic("todo", "add", "k3", "舊的", "--topic", "solo", "--do", "x", "--captain-closes");
  const card = (id, expression) =>
    `(() => { const card = document.querySelector('[data-todo="${id}"]'); return ${expression}; })()`;
  await page.waitFor("the hands-on cards", `document.querySelectorAll("[data-todo]").length === 3`, 15000);
  const shape = await page.evaluate(card("k1",
    `JSON.stringify([[...card.querySelectorAll("pre.cmd")].map((pre) => pre.textContent), card.querySelectorAll(".cmd-row button").length, card.querySelector(".guide")?.textContent ?? null])`));
  if (shape !== JSON.stringify([commands, 2, "只在公司網路外"]))
    throw new Error(`the card must show the guidance apart and each command in its own block: ${shape}`);
  if ((await page.evaluate(card("k2", `card.querySelectorAll("pre.cmd, .cmd-row").length`))) !== 0)
    throw new Error("an item with no command must show no command block");
  for (const [index, command] of commands.entries()) {
    await page.evaluate(card("k1", `card.querySelectorAll(".cmd-row button")[${index}].click()`));
    await page.waitFor(`copy button ${index} to answer`, card("k1", `["已複製", "已選取"].some((word) => card.querySelectorAll(".cmd-row button")[${index}].textContent.startsWith(word))`));
    const copied = await page.evaluate(card("k1",
      `card.querySelectorAll(".cmd-row button")[${index}].textContent === "已複製" ? "clipboard" : getSelection().toString()`));
    if (copied !== "clipboard" && copied !== command) throw new Error(`copy button ${index} must copy exactly its command, selected: ${JSON.stringify(copied)}`);
  }
  await noFirstmate(page, "a hands-on card still to do");
  await page.click('[data-todo="k1"] button', "做完了");
  await page.waitFor("the claim shown", card("k1", `card.innerText.includes("你已按做完了，等 plain 驗證")`), 15000);
  await noFirstmate(page, "a claimed card");
  topic("todo", "failed", "k1", "--reason", "連不上");
  await page.waitFor("the failed check", card("k1", `card.innerText.includes("plain 驗證沒過：連不上")`), 15000);
  topic("todo", "obsolete", "k3", "--reason", "不用了");
  await page.waitFor("the item no longer needed", card("k3", `card.innerText.includes("plain：不再需要了。不用了")`), 15000);
  await noFirstmate(page, "a rejected card and a card no longer needed");
  await page.click('[data-todo="k3"] button', "好，撤下");
  await page.waitFor("the takedown's confirm step", card("k3", `card.querySelector(".confirm") !== null`));
  await noFirstmate(page, "the takedown's confirm step");
  await page.click('[data-todo="k3"] .confirm button', "確定");
  await page.waitFor("k3 gone", `document.querySelector('[data-todo="k3"]') === null`, 15000);
  await page.click('[data-todo="k2"] button', "不做了");
  await page.waitFor("不做了's confirm step", card("k2", `card.querySelector(".confirm") !== null`));
  await page.click('[data-todo="k2"] .confirm button', "確定");
  await page.waitFor("k2 gone", `document.querySelector('[data-todo="k2"]') === null`, 15000);
  for (let tries = 0; tries < 60 && received().filter((entry) => entry.event === "todo.closed").length < 2; tries += 1) await sleep(150);
  const closes = received().filter((entry) => entry.event === "todo.closed").map((entry) => `${entry.item.id}:${entry.by}:${entry.words}`);
  if (closes.join(" ") !== "k3:captain:撤下 k2:captain:不做了") throw new Error(`each press must reach the stub: ${closes.join(" ")}`);
  topic("todo", "done", "k1");
  await page.waitFor("k1 gone", `document.querySelector('[data-todo="k1"]') === null`, 15000);
  await noFirstmate(page, "the home page after the items closed");
}

/**
 * The program bound outside the root runs only after the captain confirms it
 * on the page in two steps that show its full path; both steps' texts are
 * pinned here.
 */
async function confirmTheProgram(page) {
  const program = process.env.TB_PROGRAM;
  await page.waitFor("the dot on 更多", visible('.tabs button[data-tab="more"] .dot-new'), 15000);
  await showTab(page, "更多");
  await page.waitFor("the offer to confirm the program, first under 更多", `${visible(".program-confirm")} && document.querySelector('.pane[data-pane="more"]').firstElementChild.classList.contains("program-confirm")`, 15000);
  const offer = await page.evaluate(`document.querySelector(".program-confirm").innerText`);
  const expected = `要接上 plain，看板得在讀取與送出時執行 ${program}。這支程式不是看板程式目錄 bin/ 裡、和 commit 相同的檔，要你確認一次才會執行。`;
  if (!offer.startsWith(expected)) throw new Error(`the first step must read:\n${expected}\ngot:\n${offer}`);
  if (received().length !== 0) throw new Error("nothing may reach the program before it is confirmed");
  await page.click(".program-confirm button", "確認…");
  await page.waitFor("the second step", `document.querySelector(".confirm") !== null`);
  const step = await page.evaluate(`document.querySelector(".confirm").innerText`);
  const second = new RegExp(`^確定讓看板在每次讀取與送出時執行 ${program.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} 嗎？確認的是它現在的內容（SHA-256 [0-9a-f]{64}）與 config/myshape-aggregator.json 現在的內容；之後兩者有一個改了，看板就不執行，再問你一次。`);
  if (!second.test(step)) throw new Error(`the second step must name the program, its SHA-256 and the binding:\n${step}`);
  await noFirstmate(page, "the confirmation's two steps");
  await page.click(".confirm button", "確定執行");
  await page.waitFor("the offer gone", `document.querySelector(".program-confirm") === null`, 15000);
  await page.waitFor("the dot gone from 更多", `document.querySelector(".tabs .dot-new") === null`);
  await showTab(page, "等你");
}

async function connected(page) {
  await confirmTheProgram(page);
  await page.waitFor("the fed work", has("建置"));
  await page.waitFor("the two decisions", has("選一個") + " && " + has("沒有議題的決定"), 15000);
  await page.waitFor("the 等你 count of the two decisions", `document.querySelector('.tabs button[data-tab="wait"] .count').textContent === "2"`);
  await showTab(page, "動態");
  await page.waitFor("the fed workers", has("j1 working"), 15000);
  await everyTab(page, "the home page");

  // The 用量 panel shows what the aggregator pushed, as it pushed it, and says what it left out.
  const usage = `(document.querySelector("#sidebar .usage")?.innerText ?? "")`;
  await page.waitFor("the 用量 panel", `${usage}.includes("42%")`);
  for (const text of ["用量", "帳號 A", "五小時", "後重置", "量的", "帳號 B", "讀不到", "這個帳號讀不到", "今天的花費", "3.25 USD", "看板略過了 1 筆"]) {
    if (!(await page.evaluate(`${usage}.includes(${JSON.stringify(text)})`))) throw new Error(`the 用量 panel must show ${text}`);
  }
  if (!(await page.evaluate(visible("#sidebar .usage")))) throw new Error("on a PC the 用量 panel heads the left column");
  const marks = await page.evaluate(`["#sidebar .usage-item.sev-warn", "#sidebar .usage-item.stale", "#sidebar .usage meter"].map((css) => document.querySelectorAll(css).length).join(",")`);
  if (marks !== "1,0,1") throw new Error(`one current warn metric, none stale, one meter for the one percentage: ${marks}`);

  // AT10.1: a drag out of later changes the order, and the toast names plain.
  await page.evaluate(dropOnQueue("之後", "normal"));
  await page.waitFor("the toast naming plain", has("會通知 plain"));
  await noFirstmate(page, "the toast");
  const listed = JSON.parse(topic("list", "--json")).find((entry) => entry.id === "later-one");
  if (listed?.queue !== "normal") throw new Error(`list --json must agree with the drag, got ${JSON.stringify(listed)}`);

  // AT10.2: 未分類 (under 動態) offers filing for a worker, answers for a decision, nothing for a queued item.
  await showTab(page, "動態");
  await page.waitFor("the unsorted worker", has("j-loose"));
  const unsorted = await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll(".row, .card, .meta")];
    // The innermost row or card that holds the text.
    const of = (text) => rows.filter((row) => row.textContent.includes(text)).sort((a, b) => a.textContent.length - b.textContent.length)[0];
    const worker = of("j-loose"), decision = of("沒有議題的決定"), queued = of("沒有議題的排隊");
    return [worker?.querySelector("select") !== null && worker !== undefined,
            decision !== undefined && [...decision.querySelectorAll("button")].some((b) => b.textContent === "要"),
            queued !== undefined && queued.querySelector("select, button, input") === null].join(",");
  })()`);
  if (unsorted !== "true,true,true") throw new Error(`未分類 must offer filing, answers, and nothing for a queued item: ${unsorted}`);
  // plain sets no decisions_at_once (contracts C10), so both live decisions show and none waits its turn.
  await showTab(page, "等你");
  if (await page.evaluate(has("個決定排隊"))) throw new Error("with no cap no decision may wait its turn");

  // AT10.2: the topic page has the timeline with the summary's PR link, the
  // worker question with no answer box, and the queued list with its waiting text.
  await page.click(".topic button", "建置");
  await page.waitFor("the topic page", has("關聯 agent"));
  await page.waitFor("the summary with its PR link", `[...document.querySelectorAll("a")].some((a) => a.href === "https://example.invalid/pr/9")`);
  await page.waitFor("the worker question", has("j2 問 agent 的事"));
  const questionHasInput = await page.evaluate(`[...document.querySelectorAll(".row")].filter((row) => row.innerText.includes("j2 問 agent 的事")).some((row) => row.querySelector("input, textarea") !== null)`);
  if (questionHasInput) throw new Error("a worker question must have no answer box");
  await page.evaluate(`(() => { const s = [...document.querySelectorAll("summary")].find((e) => e.textContent.startsWith("排隊中")); if (s) s.click(); return true; })()`);
  await page.waitFor("the queued item's waiting text", has("停著：等供應商"));
  await noFirstmate(page, "the topic page");

  // AT10.3: a hold answered by its button in two steps reaches the stub.
  await page.click("button", "A");
  await page.waitFor("the confirm step", `document.querySelector(".confirm") !== null`);
  await noFirstmate(page, "the confirm step");
  if (!(await page.evaluate(has("通知 plain")))) throw new Error("the confirm step must name plain");
  await page.click(".confirm button", "送出");
  for (let tries = 0; tries < 60 && !received().some((entry) => entry.kind === "answer"); tries += 1) await sleep(150);
  const answer = received().find((entry) => entry.kind === "answer");
  if (answer?.task !== "h1" || answer?.answer !== "A") throw new Error(`the answer must reach the stub: ${JSON.stringify(answer)}`);
  await page.click("button.link", "回首頁");
  await handsOn(page);

  // AT10.5: the service stopped, then back; a home that stops answering goes stale.
  topic("stop");
  await page.waitFor("the red banner", has("看板服務沒有回應"), 25000);
  topic("open");
  await page.waitFor("the page to recover", `!${has("看板服務沒有回應")}`, 25000);
  // The restarted board must have read w2 once before w2 stops answering; its worker has no topic, so it is under 動態's 未分類.
  await showTab(page, "動態");
  await page.waitFor("w2's worker after the restart", has("w2-job"), 25000);
  fs.writeFileSync(`${process.env.TB_AGG}/control/w2`, "sleep 30\n");
  await page.waitFor("the yellow banner for w2", has("home w2 已經"), 25000);
  fs.rmSync(`${process.env.TB_AGG}/control/w2`);
  await noFirstmate(page, "the banners");

  // AT10.8: a tab open before a code change reloads itself.
  await page.evaluate("window.__beforeTheChange = true");
  execFileSync(process.env.TB_RECOMMIT);
  topic("open");
  await page.waitFor("the page to reload itself", "window.__beforeTheChange !== true", 25000);
  await page.waitFor("the reloaded page", has("建置"));
}

/**
 * On a phone the four parts are tabs at the bottom, the 佇列 tab shows one
 * box at a time, and a topic page has no tabs. The tab stays in the URL
 * fragment, and the home page comes back to it.
 */
async function phoneTabs(page) {
  await page.waitFor("the tabs at the bottom", `(() => { const tabs = document.querySelector(".tabs"); return tabs !== null && Math.abs(tabs.getBoundingClientRect().bottom - innerHeight) < 2; })()`);
  if (await page.evaluate(visible("#sidebar"))) throw new Error("on a phone 佇列 is a tab of its own, not shown under 等你");
  await everyTab(page, "the home page on a phone");
  await showTab(page, "更多");
  if (!(await page.evaluate(visible('.pane[data-pane="more"] [data-bar="hashtags"]')))) throw new Error("the hashtag settings belong under 更多");
  await showTab(page, "佇列");
  if ((await page.evaluate("location.hash")) !== "#/f/tab=queue") throw new Error("the tab must be kept in the URL fragment");
  await page.click(".segs button", "待辦");
  await page.waitFor("only 待辦's box", `${visible('.queue[data-queue="later"]')} && !${visible('.queue[data-queue="high"]')} && !${visible('.queue[data-queue="normal"]')}`);
  if (!(await page.evaluate(`[...document.querySelectorAll('.queue[data-queue="later"] .topic')].some((card) => card.getClientRects().length > 0 && card.innerText.includes("二"))`)))
    throw new Error("二 must be on screen in 待辦's box");
  await page.click(".segs button", "一般");
  await page.waitFor("only 一般's box", `${visible('.queue[data-queue="normal"]')} && !${visible('.queue[data-queue="later"]')}`);
}

async function alone(page) {
  await page.setViewport(390, 844);
  await page.waitFor("the board", `document.querySelector('.topic[data-topic="one"]') !== null`);
  await page.waitFor("the not-connected note", `document.querySelector(".not-connected") !== null`);
  await phoneTabs(page);
  await page.evaluate(dropOnQueue("二", "normal"));
  await page.waitFor("一 on screen in 一般", visible('.queue[data-queue="normal"] .topic[data-topic="one"]'));
  await fingerDrags(page);
  await page.click(".topic button", "一");
  await page.waitFor("the topic page", has("關聯 agent"));
  if (await page.evaluate(`document.querySelector(".tabs") !== null`)) throw new Error("a topic page has no tabs");
  await page.type(`[data-key="message:one"]`, "沒人收也要留著");
  await page.click("button", "送給 aggregator");
  await page.waitFor("the waiting message", has("等 aggregator 接上"));
  await sleep(3000);
  await page.click("button.link", "回首頁");
  await page.waitFor("the home page back on 佇列", `${has("優先順序")} && location.hash === "#/f/tab=queue"`);
  const marks = await page.evaluate(`[document.querySelectorAll(".pill.red").length, [...document.querySelectorAll(".banner")].map((b) => b.innerText).join(" | ")].join(" # ")`);
  if (marks !== "0 # ") throw new Error(`nothing connected must show no red mark and no banner: ${marks}`);
  if (!(await page.evaluate(has("沒有接上 aggregator")))) throw new Error("the not-connected note must be shown");
  await noFirstmate(page, "the page with nothing connected");
}

/**
 * By the remote name the board refuses to confirm a program, so 更多 starts
 * with where to confirm it instead, and no page offers 確認….
 */
async function remote(page) {
  const stand = await serveStandIn({
    listen: Number(process.env.TB_PROXY_PORT),
    boardPort: Number(process.env.TB_BOARD_PORT),
    host: process.env.TB_REMOTE_HOST,
    login: process.env.TB_REMOTE_LOGIN,
  });
  try {
    await page.setViewport(390, 844);
    await page.evaluate(`void location.assign(${JSON.stringify(process.env.TB_REMOTE_URL)})`);
    await page.waitFor("the page by its remote name", `location.hostname === ${JSON.stringify(process.env.TB_REMOTE_HOST)} && document.querySelector(".tabs") !== null`, 20000);
    await page.waitFor("the dot on 更多", visible('.tabs button[data-tab="more"] .dot-new'), 15000);
    await everyTab(page, "the page by its remote name");
    await showTab(page, "更多");
    const first = `document.querySelector('.pane[data-pane="more"]').firstElementChild`;
    await page.waitFor("the confirmation's note first under 更多", `${first}.classList.contains("program-confirm") && ${visible(".program-confirm")}`);
    const note = await page.evaluate(`${first}.innerText`);
    if (!note.startsWith("要接上 plain，") || !note.endsWith("只能在 PC 上確認：在 PC 的瀏覽器打開看板再按「確認…」。"))
      throw new Error(`更多 must start with where to confirm the program:\n${note}`);
    if (await page.evaluate(`[...document.querySelectorAll("button")].some((button) => button.textContent.startsWith("確認"))`))
      throw new Error("by the remote name the page must offer no 確認…");
    if (received().length !== 0) throw new Error("nothing may reach the program before it is confirmed");
  } finally {
    stand.close();
  }
}

export default async (page) => {
  if (process.env.TB_PAGE_MODE === "alone") await alone(page);
  else if (process.env.TB_PAGE_MODE === "remote") await remote(page);
  else await connected(page);
};
