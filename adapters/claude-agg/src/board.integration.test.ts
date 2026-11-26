// The program wired to a real board (plan section 7, step 1's acceptance items
// 1, 3, 4, 5, 6 and 7), in a scratch board-only root and a scratch home on a
// free port that is never the live board's 47819. The root is a git
// repository holding the board's runtime files (the first block of
// myshape/vendor-files, as the board's own tests copy them) plus
// adapters/claude-agg/bin/agg-board.mjs, so the program sits in the code root
// but outside its bin/, as it does in a real checkout, and the tests may
// change its mode and bytes. The board is started and stopped only through
// the root's bin/myshape.sh; the page's confirmation is done the way the
// board's own tests do it (myshape/test/standalone-lib.sh, sa_confirm). No
// test sends a signal to any process.
//
// These tests start a board service, so they run only when CI is set: on
// GitHub's runner, not on a workstation.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AGENT_NAME } from "./agent-name.js";
import type { LandedRecord } from "./state-files.js";
import { appendTag, REPO_ROOT, writeHolds, writeTasks } from "./test-home.js";

const LIVE_BOARD_PORT = 47819;
const IN_CI = (process.env["CI"] ?? "") !== "";
const STEP_MS = 120_000;
const FIVE_NAMES = ["HOME", "LANG", "MYSHAPE_HOME", "PATH", "TMPDIR"];
const QUESTION = "要用新的快取嗎？\n選項：A | B";

type Json = Record<string, unknown>;

interface Board {
  scratch: string;
  root: string;
  home: string;
  agg: string;
  program: string;
  probe: string;
  port: number;
  env: Record<string, string>;
  starterPid: number | undefined;
}

let board: Board;
let started = false;

async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const picked = typeof address === "object" && address !== null ? address.port : 0;
        server.close(() => resolve(picked));
      });
    });
    if (port !== 0 && port !== LIVE_BOARD_PORT) return port;
  }
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=claude-agg tests",
      "-c",
      "user.email=tests@example.invalid",
    ].concat(["-c", "commit.gpgsign=false", ...args]),
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

/** A board-only root: the board's files and the program, committed as one commit. */
function makeRoot(root: string): void {
  const lines = readFileSync(join(REPO_ROOT, "myshape", "vendor-files"), "utf8").split("\n");
  const blank = lines.indexOf("");
  const files = blank === -1 ? lines : lines.slice(0, blank);
  for (const path of [...files, "adapters/claude-agg/bin/agg-board.mjs"]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(REPO_ROOT, path), join(root, path), { recursive: true });
  }
  chmodSync(join(root, "adapters/claude-agg/bin/agg-board.mjs"), 0o755);
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "board-only root");
}

/** The probe of acceptance item 3: feed and deliver that record their environment's names. */
function probeSource(out: string): string {
  return [
    "#!/usr/bin/env node",
    'import { readFileSync, writeFileSync } from "node:fs";',
    'const role = process.argv[2] === "deliver" ? "deliver" : "feed";',
    `writeFileSync(${JSON.stringify(out)} + "/env." + role, Object.keys(process.env).sort().join("\\n"));`,
    'if (role === "deliver") { readFileSync(0); process.stdout.write(\'{"outcome":"delivered"}\\n\'); }',
    'else process.stdout.write(JSON.stringify({ schema: 1, code_commit: "probe", ledger_enabled: false,',
    "  tasks: [], queued: [], holds: [], status_decisions: [], topics: {},",
    '  ledger: { status: "absent", to_offset: 0, to_prefix_sha256: "-", more: false, lines: [] } }) + "\\n");',
    "",
  ].join("\n");
}

function bind(program: string): void {
  const path = join(board.home, "config", "myshape-aggregator.json");
  writeFileSync(
    path,
    `${JSON.stringify({ v: 1, name: AGENT_NAME, feed: program, deliver: program })}\n`,
  );
  chmodSync(path, 0o644);
}

/** Runs the root's bin/myshape.sh in the scratch home with a clean environment. */
function myshape(...args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
  pid: number | undefined;
} {
  const result = spawnSync(join(board.root, "bin", "myshape.sh"), args, {
    env: board.env,
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, pid: result.pid };
}

function http(method: string, route: string, body?: Json): Promise<Json> {
  const token = readFileSync(join(board.home, "state", "myshape", "token"), "utf8").trim();
  const base = `http://127.0.0.1:${board.port}`;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const call = request(
      `${base}/api/${route}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload === undefined ? {} : { Origin: base, "Content-Type": "application/json" }),
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => {
          try {
            resolve(JSON.parse(text) as Json);
          } catch {
            reject(new Error(`${method} /api/${route} answered ${response.statusCode}: ${text}`));
          }
        });
      },
    );
    call.on("error", reject);
    call.end(payload);
  });
}

const state = (): Promise<Json> => http("GET", "state");
const post = (route: string, body: Json): Promise<Json> => http("POST", route, body);

/** A page action that takes two steps: the first request, then the second with its code. */
async function twoStep(route: string, body: Json): Promise<Json> {
  const first = await post(route, body);
  if (typeof first["confirm"] !== "string")
    throw new Error(`no code from ${route}: ${JSON.stringify(first)}`);
  return post(route, { ...body, confirm: first["confirm"] });
}

/** Confirms the program the binding names, on the page, as sa_confirm does. */
async function confirmOnPage(): Promise<void> {
  const reply = await twoStep("programs/confirm", { role: "feed" });
  expect(reply["ok"], JSON.stringify(reply)).toBe(true);
}

async function waitFor(
  what: string,
  check: () => Promise<boolean> | boolean,
  ms = 30_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${serviceLog()}`);
    await sleep(200);
  }
}

function serviceLog(): string {
  const path = join(board.home, "state", "myshape", "service.log");
  return existsSync(path)
    ? `service.log:\n${readFileSync(path, "utf8").slice(-4000)}`
    : "no service.log";
}

interface Aggregator {
  connected: boolean;
  unavailable: string | null;
  confirm: { path: string }[];
}

async function aggregator(): Promise<Aggregator> {
  return (await state())["aggregator"] as Aggregator;
}

async function writeState(id: string): Promise<string | undefined> {
  const writes = (await state())["writes"] as { id: string; state: string }[];
  return writes.find((write) => write.id === id)?.state;
}

async function message(text: string): Promise<string> {
  const reply = await post("messages", { topic: "build", text });
  if (typeof reply["write_id"] !== "string")
    throw new Error(`no write id: ${JSON.stringify(reply)}`);
  return reply["write_id"];
}

const inboxFile = (id: string): string => join(board.agg, "inbox", `${id}.json`);
const landed = (path: string): LandedRecord =>
  JSON.parse(readFileSync(path, "utf8")) as LandedRecord;

async function agentLight(task: string): Promise<string> {
  const agents = (await state())["agents"] as {
    home: string;
    task: string;
    topic: string | null;
    light: string;
  }[];
  const agent = agents.find((entry) => entry.home === "main" && entry.task === task);
  return agent === undefined ? "missing" : `${String(agent.topic)}:${agent.light}`;
}

async function setUp(): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "agg-board-it-"));
  const root = join(scratch, "root");
  const home = join(scratch, "home");
  for (const dir of ["h", "tmp", "probe", "probe-bin", "home/state", "home/data", "home/config"]) {
    mkdirSync(join(scratch, dir), { recursive: true });
  }
  makeRoot(root);
  const port = await freePort();
  writeFileSync(join(home, "config", "myshape-port"), `${port}\n`);
  const program = join(root, "adapters", "claude-agg", "bin", "agg-board.mjs");
  const probe = join(scratch, "probe-bin", "env-probe.mjs");
  writeFileSync(probe, probeSource(join(scratch, "probe")));
  chmodSync(probe, 0o755);
  board = {
    scratch,
    root,
    home,
    agg: join(home, "agg"),
    program,
    probe,
    port,
    starterPid: undefined,
    env: {
      HOME: join(scratch, "h"),
      PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      LANG: "C.UTF-8",
      TMPDIR: join(scratch, "tmp"),
      MYSHAPE_HOME: home,
      MYSHAPE_TEST: "1",
      MYSHAPE_NOTIFY_MS: "2000",
      MYSHAPE_RETRY_MS: "100,200",
      MYSHAPE_READ_MS: "300",
      MYSHAPE_STALE_MS: "4000",
      MYSHAPE_IDLE_MS: "600000",
      AGG_CANARY: "leak",
      SSH_AUTH_SOCK: "/decoy",
      TMUX: "/decoy",
    },
  };
  for (const dir of ["inbox/handled", "answers/handled", "tags"]) {
    mkdirSync(join(board.agg, dir), { recursive: true, mode: 0o700 });
  }
  writeTasks(board.agg, {
    v: 1,
    tasks: {
      t1: { kind: "ship", state: "working", detail: "跑測試中" },
      t2: { kind: "ship", state: "blocked", detail: "等金鑰" },
      t3: { kind: "scout", state: "working" },
    },
  });
  writeHolds(board.agg, {
    v: 1,
    holds: {
      t3: {
        state: "open",
        title: "快取",
        question: QUESTION,
        on_answer: "release",
        hold_set: "2026-11-25T00:00:00Z",
      },
    },
  });
  for (const task of ["t1", "t2", "t3"])
    appendTag(board.agg, task, "build", "2026-11-25T00:00:00Z");
  bind(program);
  started = true;
}

describe.skipIf(!IN_CI)("on a real board (runs only when CI is set; skipped otherwise)", () => {
  beforeAll(setUp, STEP_MS);

  afterAll(async () => {
    if (!started) return;
    try {
      const pidFile = join(board.home, "state", "myshape", "pid");
      const pid = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "";
      const stop = myshape("stop");
      expect(stop.status, stop.stderr).toBe(0);
      if (pid !== "") await waitFor("the board to stop", () => !existsSync(`/proc/${pid}`), 15_000);
    } finally {
      rmSync(board.scratch, { recursive: true, force: true });
    }
  }, STEP_MS);

  it("scratch home, scratch port: never the live board's", () => {
    expect(board.port).not.toBe(LIVE_BOARD_PORT);
    expect(board.home.startsWith(board.scratch)).toBe(true);
  });

  it(
    "(7) asks for a confirmation of the program wired by absolute path from adapters/claude-agg/bin/",
    async () => {
      expect(git(board.root, "status", "--porcelain")).toBe("");
      expect(git(board.root, "ls-files", "--", "adapters/claude-agg/bin/agg-board.mjs")).not.toBe(
        "",
      );
      const open = myshape("open");
      expect(open.status, `${open.stderr}\n${serviceLog()}`).toBe(0);
      board.starterPid = open.pid;
      const before = await aggregator();
      expect(before.connected).toBe(false);
      expect(before.confirm.map((entry) => entry.path)).toEqual([board.program]);
    },
    STEP_MS,
  );

  it(
    "(1) once confirmed, shows a hand-written task under its topic with the C3 light",
    async () => {
      await confirmOnPage();
      const after = await aggregator();
      expect(after.connected).toBe(true);
      expect(after.confirm).toEqual([]);
      for (const [name, id] of [
        ["建置", "build"],
        ["其他", "other"],
      ] as const) {
        const made = myshape("create", name, "--goal", "把看板接上", "--id", id);
        expect(made.status, made.stderr).toBe(0);
      }
      await post("refresh", {});
      await waitFor("t1 under build", async () => (await agentLight("t1")) === "build:working");
      expect(await agentLight("t2")).toBe("build:stuck");
      expect(await agentLight("t3")).toBe("build:decide");
      const confirmations = readFileSync(
        join(board.home, "data", "myshape", "confirmations.json"),
        "utf8",
      );
      expect(confirmations).toContain(board.program);
    },
    STEP_MS,
  );

  it(
    "(2) takes the page's message, direct, tag and answer through the board",
    async () => {
      const id = await message("先看測試");
      await waitFor("the message", async () => (await writeState(id)) === "delivered");
      expect(landed(inboxFile(id)).record.kind).toBe("message");
      const direct = await post("direct", { home: "main", task: "t1", text: "看一下 CI" });
      await waitFor(
        "the direct",
        async () => (await writeState(String(direct["write_id"]))) === "delivered",
      );
      const tag = await post("agents/tag", { home: "main", task: "t1", topic: "other" });
      await waitFor(
        "the tag",
        async () => (await writeState(String(tag["write_id"]))) === "delivered",
      );
      await waitFor("t1 under other", async () => (await agentLight("t1")) === "other:working");
      const answer = await twoStep("holds/answer", {
        home: "main",
        task: "t3",
        answer: "A",
        label: "A",
      });
      await waitFor(
        "the answer",
        async () => (await writeState(String(answer["write_id"]))) === "delivered",
      );
      expect(landed(join(board.agg, "answers", "t3.json")).record.kind).toBe("answer");
      await waitFor(
        "t3 no longer waiting for the captain",
        async () => (await agentLight("t3")) === "build:working",
      );
    },
    STEP_MS,
  );

  it(
    "(3) hands its programs only the board's five environment names",
    async () => {
      bind(board.probe);
      await waitFor("the probe to be offered", async () =>
        (await aggregator()).confirm.some((entry) => entry.path === board.probe),
      );
      await confirmOnPage();
      await post("refresh", {});
      const id = await message("環境");
      await waitFor("the probe's deliver", async () => (await writeState(id)) === "delivered");
      await waitFor("the probe's feed", () => existsSync(join(board.scratch, "probe", "env.feed")));
      for (const role of ["feed", "deliver"]) {
        const names = readFileSync(join(board.scratch, "probe", `env.${role}`), "utf8").split("\n");
        expect(names, role).toEqual(FIVE_NAMES);
      }
      bind(board.program);
      const back = await message("回來了");
      await waitFor("the program's deliver again", async () => {
        if ((await writeState(back)) === "delivered") return true;
        if ((await aggregator()).confirm.some((entry) => entry.path === board.program)) {
          await twoStep("programs/confirm", { role: "feed" });
        }
        return false;
      });
      expect(existsSync(inboxFile(back))).toBe(true);
    },
    STEP_MS,
  );

  it(
    "(4) refuses the program while its group may write it, and takes it after chmod g-w",
    async () => {
      chmodSync(board.program, 0o775);
      await post("refresh", {});
      await waitFor("the refusal", async () => (await aggregator()).connected === false);
      expect((await aggregator()).unavailable).toContain("群組也能寫（權限 0775）");
      const id = await message("群組能寫時");
      await waitFor("the write to wait", async () => (await writeState(id)) === "waiting");
      expect(existsSync(inboxFile(id))).toBe(false);
      chmodSync(board.program, statSync(board.program).mode & 0o7777 & ~0o020);
      await post("refresh", {});
      await waitFor(
        "the write after chmod g-w",
        async () => (await writeState(id)) === "delivered",
      );
      expect((await aggregator()).connected).toBe(true);
      expect(existsSync(inboxFile(id))).toBe(true);
    },
    STEP_MS,
  );

  it(
    "(5) stops running it after one changed byte; writes wait, then go in order once re-confirmed",
    async () => {
      const bytes = readFileSync(board.program);
      const at = bytes.indexOf("the one program");
      expect(at).toBeGreaterThan(0);
      const changed = Buffer.from(bytes);
      changed[at] = "T".charCodeAt(0);
      const { atime, mtime } = statSync(board.program);
      writeFileSync(board.program, changed);
      utimesSync(board.program, atime, mtime);
      expect(statSync(board.program).size).toBe(bytes.length);
      const first = await message("改了一個位元組之後 1");
      const second = await message("改了一個位元組之後 2");
      await waitFor(
        "both writes to wait",
        async () =>
          (await writeState(first)) === "waiting" && (await writeState(second)) === "waiting",
      );
      expect([existsSync(inboxFile(first)), existsSync(inboxFile(second))]).toEqual([false, false]);
      expect((await aggregator()).confirm.map((entry) => entry.path)).toEqual([board.program]);
      await confirmOnPage();
      await waitFor(
        "both writes after the new confirmation",
        async () =>
          (await writeState(first)) === "delivered" && (await writeState(second)) === "delivered",
      );
      expect(landed(inboxFile(first)).received_ms).toBeLessThanOrEqual(
        landed(inboxFile(second)).received_ms,
      );
      const released = readFileSync(join(board.home, "data", "myshape", "events.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.includes('"writes.released"') && line.includes(first));
      expect(released).toHaveLength(1);
      const text = String((JSON.parse(released[0] ?? "{}") as Json)["text"]);
      expect(text.indexOf(first)).toBeLessThan(text.indexOf(second));
    },
    STEP_MS,
  );

  it(
    "(6) the board service outlives the process that started it",
    async () => {
      expect(board.starterPid).toBeDefined();
      const status = myshape("status");
      expect(status.status, status.stderr).toBe(0);
      expect(status.stdout).toContain("看板服務：在跑");
      const pid = /pid：(\d+)/.exec(status.stdout)?.[1];
      expect(pid).toBeDefined();
      expect(Number(pid)).not.toBe(board.starterPid);
      const parent = /^PPid:\s+(\d+)$/m.exec(
        readFileSync(`/proc/${String(pid)}/status`, "utf8"),
      )?.[1];
      expect(Number(parent)).not.toBe(board.starterPid);
      expect(Number(parent)).not.toBe(process.pid);
      expect((await aggregator()).connected).toBe(true);
    },
    STEP_MS,
  );
});
