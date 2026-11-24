// Drives a headless Firefox through WebDriver BiDi, with nothing but Node
// built-ins, so the page can be checked the way the captain uses it.
//
// Usage: node browser.mjs <url> <script.mjs>
// The script's default export receives { evaluate, waitFor, click, type,
// screenshot, text } and may throw to fail.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [url, scriptFile] = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Snap-packaged Firefox cannot read hidden directories in the home directory,
// so the throwaway profile sits directly in it, named after this process.
const PROFILE_PREFIX = "tb-firefox-tmp-";

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Removes the profiles of earlier runs that were killed before they could clean up. */
function sweepStaleProfiles() {
  for (const name of fs.readdirSync(os.homedir())) {
    const owner = /^tb-firefox-tmp-(\d+)-/.exec(name);
    if (owner === null || isRunning(Number(owner[1]))) continue;
    fs.rmSync(path.join(os.homedir(), name), { recursive: true, force: true });
  }
}

sweepStaleProfiles();
const profile = fs.mkdtempSync(path.join(os.homedir(), `${PROFILE_PREFIX}${process.pid}-`));
const port = 20000 + Math.floor(Math.random() * 20000);
const firefoxArgs = ["--headless", "--no-remote", "--profile", profile];
firefoxArgs.push(`--remote-debugging-port=${port}`, "about:blank");
// Firefox's stderr goes to a file beside the profile, so a failure to start can say why.
const stderrFile = `${profile}.stderr`;
const stderrFd = fs.openSync(stderrFile, "w");
const firefox = spawn("firefox", firefoxArgs, { stdio: ["ignore", "ignore", stderrFd] });
fs.closeSync(stderrFd);
const STDERR_TAIL = 4000;

/** The last part of what Firefox wrote on stderr, for a failure message. */
function firefoxStderr() {
  try {
    const text = fs.readFileSync(stderrFile, "utf8").trim();
    return text === "" ? "(Firefox wrote nothing on stderr)" : text.slice(-STDERR_TAIL);
  } catch {
    return "(Firefox's stderr could not be read)";
  }
}

async function cleanUp() {
  firefox.kill("SIGKILL");
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.rmSync(stderrFile, { force: true });
}

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
  process.once(signal, () => void cleanUp().finally(() => process.exit(code)));
}

// A loaded machine can take well over 20 seconds to start a headless Firefox.
const CONNECT_ATTEMPTS = 300;

async function connect() {
  for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt += 1) {
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/session`);
      await new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = reject;
      });
      return socket;
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`firefox did not open its BiDi port within 60 s; its stderr:\n${firefoxStderr()}`);
}

let exitCode = 0;
try {
  const socket = await connect();
  let nextId = 1;
  const waiting = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const pending = waiting.get(message.id);
    if (pending === undefined) return;
    waiting.delete(message.id);
    if (message.type === "error") pending.reject(new Error(`${message.error}: ${message.message}`));
    else pending.resolve(message.result);
  };
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send("session.new", { capabilities: {} });
  const { contexts } = await send("browsingContext.getTree", {});
  const context = contexts[0].context;
  await send("browsingContext.setViewport", { context, viewport: { width: 1300, height: 950 } });
  await send("browsingContext.navigate", { context, url, wait: "complete" });

  const evaluate = async (expression) => {
    const reply = await send("script.evaluate", { expression, target: { context }, awaitPromise: true, resultOwnership: "none" });
    if (reply.type === "exception") throw new Error(reply.exceptionDetails.text);
    return reply.result.value;
  };
  const tools = {
    evaluate,
    text: () => evaluate("document.body.innerText"),
    async waitFor(description, expression, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(`Boolean(${expression})`)) return;
        await sleep(150);
      }
      throw new Error(`timed out waiting for: ${description}\n--- page text ---\n${await tools.text()}`);
    },
    /** Clicks the first element matching `selector` whose text contains `label`. */
    async click(selector, label = "") {
      const found = await evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(label)})); if (!el) return false; el.click(); return true; })()`);
      if (!found) throw new Error(`nothing to click: ${selector} "${label}"\n--- page text ---\n${await tools.text()}`);
    },
    /** Clicks like `click`, but with a real pointer, which the browser counts as the user acting. */
    async pointerClick(selector, label = "") {
      const point = await evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(label)})); if (!el) return ""; el.scrollIntoView({ block: "center" }); const box = el.getBoundingClientRect(); return Math.round(box.left + box.width / 2) + "," + Math.round(box.top + box.height / 2); })()`);
      if (point === "") throw new Error(`nothing to click: ${selector} "${label}"\n--- page text ---\n${await tools.text()}`);
      const [x, y] = point.split(",").map(Number);
      const steps = [{ type: "pointerMove", x, y }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }];
      await send("input.performActions", { context, actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: steps }] });
    },
    async type(selector, value) {
      const found = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
      if (!found) throw new Error(`nothing to type into: ${selector}`);
    },
    async screenshot(file) {
      const { data } = await send("browsingContext.captureScreenshot", { context });
      fs.writeFileSync(file, Buffer.from(data, "base64"));
    },
  };
  const script = await import(pathToFileURL(path.resolve(scriptFile)).href);
  await script.default(tools);
  console.log("ok - browser script finished");
} catch (error) {
  console.error(`not ok - ${error.message}`);
  exitCode = 1;
} finally {
  await cleanUp();
}
process.exit(exitCode);
