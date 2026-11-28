// The page at a phone's width and in each colour scheme, run by browser.mjs in
// a headless Firefox for stage-7-page.sh: at 390 px nothing reaches past the
// window's edge on any of the home page's tabs, with the deadline, hashtag and
// schedule settings open under 更多, and on the topic page, and 佇列 is a tab
// of its own as wide as the page; at 1300 px 佇列 is the left column.
// With TB_COLOR_SCHEME=dark the page must be dark at both widths and keep no
// white background. With TB_SHOTS set to a directory, each width is saved
// there as <scheme>-<width>-<page>.png for a person to look at.
import path from "node:path";

const has = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scheme = process.env.TB_COLOR_SCHEME ?? "light";
const NARROW = [390, 844];
const WIDE = [1300, 950];

async function resize(page, [width, height]) {
  await page.setViewport(width, height);
  await page.waitFor(`the window at ${width} px`, `innerWidth === ${width}`);
  await sleep(300);
}

async function shot(page, name) {
  const dir = process.env.TB_SHOTS;
  if (dir) await page.screenshot(path.join(dir, `${scheme}-${name}.png`));
}

/** Fails when the page scrolls sideways or any element reaches past the window's right edge. */
async function fitsTheWidth(page, where) {
  const report = JSON.parse(await page.evaluate(`(() => {
    const width = document.documentElement.clientWidth;
    const over = [...document.querySelectorAll("body *")]
      .filter((el) => el.getBoundingClientRect().right > width + 0.5)
      .map((el) => el.tagName.toLowerCase() + (typeof el.className === "string" && el.className !== "" ? "." + el.className.split(" ").join(".") : ""));
    return JSON.stringify({ width, scroll: document.documentElement.scrollWidth, over: over.slice(0, 5) });
  })()`));
  if (report.scroll > report.width || report.over.length > 0) {
    throw new Error(`${where} must fit ${report.width} px: scrollWidth ${report.scroll}, past the edge: ${report.over.join(", ")}`);
  }
}

/** Whether 佇列 (the sidebar) is hidden, fills the page's width (one column), or sits left of the tabs (two). */
const sidebarPlace = `(() => {
  const side = document.querySelector("#sidebar").getBoundingClientRect();
  const tabbed = document.querySelector(".tabbed").getBoundingClientRect();
  if (side.width === 0) return "hidden";
  if (side.width > document.documentElement.clientWidth - 40) return "full";
  return side.right <= tabbed.left ? "left" : "overlapping";
})()`;

/** Shows a part of the home page by its tab, as the captain does. */
async function showTab(page, label) {
  await page.click(".tabs button", label);
  await page.waitFor(`the ${label} tab`, `document.querySelector(".tabs button.on")?.textContent.startsWith(${JSON.stringify(label)}) === true`);
}

/** In dark: the scheme is seen, the body is dark, and nothing keeps a white background. */
async function checkScheme(page, where) {
  const report = JSON.parse(await page.evaluate(`(() => {
    const rgb = (css) => (css.match(/[0-9.]+/g) ?? []).map(Number);
    const [r, g, b] = rgb(getComputedStyle(document.body).backgroundColor);
    const white = [...document.querySelectorAll("body *")]
      .filter((el) => { const [r, g, b, a = 1] = rgb(getComputedStyle(el).backgroundColor); return r === 255 && g === 255 && b === 255 && a > 0; })
      .map((el) => el.tagName.toLowerCase() + "." + el.className);
    return JSON.stringify({ dark: matchMedia("(prefers-color-scheme: dark)").matches, light: (r + g + b) / 3, white: white.slice(0, 5) });
  })()`));
  if (scheme === "dark") {
    if (!report.dark) throw new Error(`${where}: the page must see prefers-color-scheme: dark`);
    if (report.light > 60) throw new Error(`${where}: the dark page's background must be dark, its mean channel is ${report.light}`);
    if (report.white.length > 0) throw new Error(`${where}: nothing may keep a white background in dark: ${report.white.join(", ")}`);
  } else if (report.dark) {
    throw new Error(`${where}: the page must not see prefers-color-scheme: dark`);
  }
}

/** Opens the deadline settings and the hashtag and schedule settings panels, under 更多. */
async function openTheSettings(page) {
  await showTab(page, "更多");
  await page.evaluate(`document.querySelector('details[data-key="lifecycle-settings"]').open = true`);
  await page.click("button.link", "hashtag 設定");
  await page.click("button.link", "排程設定");
  await page.waitFor("the settings tables", `document.querySelectorAll("table.settings").length === 2`);
  const rows = await page.evaluate(`document.querySelectorAll('details[data-key="lifecycle-settings"] .row input.days').length`);
  if (rows === 0) throw new Error("the deadline settings must show their inputs");
}

/** Where the order buttons can be seen: the sidebar's and 等你's copies, each true when on screen. */
const orderSeen = `JSON.stringify([...document.querySelectorAll(".order")].map((box) => [box.closest("#sidebar") === null ? "wait" : "sidebar", box.getClientRects().length > 0]))`;

export default async (page) => {
  await page.waitFor("the board", has("優先順序"));
  await checkScheme(page, "the home page at 1300 px");
  await shot(page, "1300-home");
  // One set of order buttons per width (spec/card-sort.markdown decision 12): the sidebar's at
  // 1300 px, beside 等你; 等你's own at 390 px, where the sidebar is a tab of its own.
  const wideOrder = await page.evaluate(orderSeen);
  if (wideOrder !== JSON.stringify([["sidebar", true], ["wait", false]])) throw new Error(`at 1300 px only the sidebar's order buttons show, got ${wideOrder}`);

  await resize(page, NARROW);
  if ((await page.evaluate(sidebarPlace)) !== "hidden") throw new Error("at 390 px 佇列 is a tab of its own, not under 等你");
  for (const label of ["等你", "佇列", "動態"]) {
    await showTab(page, label);
    await fitsTheWidth(page, `the ${label} tab`);
    await checkScheme(page, `the ${label} tab at 390 px`);
  }
  await showTab(page, "等你");
  const narrowOrder = await page.evaluate(orderSeen);
  if (narrowOrder !== JSON.stringify([["sidebar", false], ["wait", true]])) throw new Error(`at 390 px 等你 shows its own order buttons, got ${narrowOrder}`);
  await showTab(page, "佇列");
  if ((await page.evaluate(sidebarPlace)) !== "full") throw new Error("at 390 px the 佇列 tab must be one column as wide as the page (C42)");
  await shot(page, "390-queue");
  await openTheSettings(page);
  await fitsTheWidth(page, "the home page with its settings open");
  await checkScheme(page, "the home page at 390 px");
  await shot(page, "390-home");

  await page.click(".topic button", "窄螢幕");
  await page.waitFor("the topic page", has("關聯 agent"));
  const labels = await page.evaluate(`[...document.querySelectorAll("button.edit")].map((b) => b.getAttribute("aria-label")).join(",")`);
  if (labels !== "編輯名稱,編輯目標") throw new Error(`the name and goal must each have a labelled edit button: ${labels}`);
  await fitsTheWidth(page, "the topic page");
  await checkScheme(page, "the topic page at 390 px");
  await shot(page, "390-topic");

  await page.click("button.link", "回首頁");
  await page.waitFor("the home page back on 更多", `${has("期限設定")} && document.querySelector(".tabs") !== null`);
  await resize(page, WIDE);
  if ((await page.evaluate(sidebarPlace)) !== "left") throw new Error("at 1300 px the sidebar must sit to the left");
};
