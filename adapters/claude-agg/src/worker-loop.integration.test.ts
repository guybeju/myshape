// Step 3's acceptance on a real board: a topic gets a task, its light goes
// from in progress to done, its summary appears under the topic, and its
// worktree is removed so `git worktree list` matches tasks.json. Steps 5 and
// 6 on the same board: a worker's question answered on the page in two
// steps, its 要你動手 item claimed on the page and verified, a direct to the
// ended worker refused, the close proposal, and the guarded hashtag
// operation with the captain's settings. Step 7 on the same board: a
// schedule the captain makes on the page is taken on its coming-up notice,
// its work starts at its time though its topic is in 待辦, and it is closed
// done when the worker ends (that test waits about three real minutes for the
// board's clock), and a missed hard-rt occurrence landed through deliver gets
// its report summary under the topic. The board is
// a scratch board-only root and home on a free port that is never the live
// board's 47819, started with the root's bin/myshape.sh open and stopped with
// bin/myshape.sh stop; no test sends a signal. The program is confirmed on
// the page the way the board's own tests do it. The supervisor runs the
// root's real bin/myshape.sh and real git in sandbox repositories under the
// scratch directory; the query() is a double, and gh is played in memory.
//
// These tests start a board service, so they run only when CI is set.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AGENT_NAME } from "./agent-name.js";
import { spawnCommand, type PlainEnv, type RunCommand } from "./supervisor/commands.js";
import { existingRealPath } from "./supervisor/guard.js";
import {
  CANARY,
  FakeCommands,
  Gate,
  init,
  plan,
  result,
  ScriptedQuery,
  workerOutput,
} from "./supervisor/harness.test-helper.js";
import { BoardCommand } from "./supervisor/commands.js";
import { HASHTAG_REASON, Tagger } from "./supervisor/hashtags.js";
import { Supervisor } from "./supervisor/supervisor.js";
import { REPO_ROOT } from "./test-home.js";

const LIVE_BOARD_PORT = 47_819;
const IN_CI = (process.env["CI"] ?? "") !== "";
const STEP_MS = 120_000;
const PR = "https://github.com/owner/app/pull/11";

type Json = Record<string, unknown>;

interface Scratch {
  dir: string;
  root: string;
  home: string;
  main: string;
  work: string;
  port: number;
  boardEnv: Record<string, string>;
  env: PlainEnv;
}

let scratch: Scratch;
let started = false;
/** The supervisor's log lines, shown with every failure. */
const logs: string[] = [];

function serviceLog(): string {
  const path = join(scratch.home, "state", "myshape", "service.log");
  const service = existsSync(path) ? readFileSync(path, "utf8").slice(-4000) : "no service.log";
  return `supervisor log:\n${logs.join("\n")}\nservice.log:\n${service}`;
}

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

function inScratch(dir: string): boolean {
  return dir.startsWith(`${scratch.dir}/`);
}

function git(dir: string, ...args: string[]): string {
  if (!inScratch(dir)) throw new Error(`refused: git outside the scratch directory (${dir})`);
  const identity = [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.invalid",
    "-c",
    "commit.gpgsign=false",
  ];
  const out = spawnSync("git", ["-C", dir, ...identity, ...args], {
    env: { ...scratch.env },
    encoding: "utf8",
  });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout;
}

function myshape(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const out = spawnSync(join(scratch.root, "bin", "myshape.sh"), args, {
    env: scratch.boardEnv,
    encoding: "utf8",
  });
  if (out.error !== undefined) throw out.error;
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}

function http(method: string, route: string, body?: Json): Promise<Json> {
  const token = readFileSync(join(scratch.home, "state", "myshape", "token"), "utf8").trim();
  const base = `http://127.0.0.1:${scratch.port}`;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = {
    Authorization: `Bearer ${token}`,
    ...(payload === undefined ? {} : { Origin: base, "Content-Type": "application/json" }),
  };
  return new Promise((resolve, reject) => {
    const call = request(`${base}/api/${route}`, { method, headers }, (response) => {
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
    });
    call.on("error", reject);
    call.end(payload);
  });
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

async function light(task: string): Promise<string> {
  await http("POST", "refresh", {});
  const agents = (await http("GET", "state"))["agents"] as {
    home: string;
    task: string;
    topic: string | null;
    light: string;
  }[];
  const agent = agents.find((entry) => entry.home === "main" && entry.task === task);
  return agent === undefined ? "missing" : `${String(agent.topic)}:${agent.light}`;
}

async function summaries(): Promise<
  { task: string; kind: string; topic: string | null; text: string }[]
> {
  return (await http("GET", "state"))["summaries"] as {
    task: string;
    kind: string;
    topic: string | null;
    text: string;
  }[];
}

function makeRoot(root: string): void {
  const lines = readFileSync(join(REPO_ROOT, "myshape", "vendor-files"), "utf8").split("\n");
  const blank = lines.indexOf("");
  for (const path of [
    ...(blank === -1 ? lines : lines.slice(0, blank)),
    "adapters/claude-agg/bin/agg-board.mjs",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(REPO_ROOT, path), join(root, path), { recursive: true });
  }
  chmodSync(join(root, "adapters/claude-agg/bin/agg-board.mjs"), 0o755);
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "board-only root");
}

function makeRepository(dir: string): string {
  const remote = join(dir, "remote.git");
  const main = join(dir, "main");
  mkdirSync(remote);
  mkdirSync(main);
  git(remote, "init", "-q", "--bare", "-b", "main");
  git(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, "README"), "x\n");
  git(main, "add", "README");
  git(main, "commit", "-qm", "first");
  git(main, "remote", "add", "origin", remote);
  git(main, "push", "-q", "origin", "main");
  return main;
}

async function setUp(): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agg-loop-it-")));
  const home = join(dir, "home");
  for (const sub of [
    "h",
    "tmp",
    "root",
    "work",
    "repo",
    "home/state",
    "home/data",
    "home/config",
  ]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  const env: PlainEnv = {
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    HOME: join(dir, "h"),
    LANG: "C.UTF-8",
    TMPDIR: join(dir, "tmp"),
  };
  const port = await freePort();
  scratch = {
    dir,
    root: join(dir, "root"),
    home,
    main: "",
    work: join(dir, "work"),
    port,
    env,
    boardEnv: {
      ...env,
      MYSHAPE_HOME: home,
      MYSHAPE_TEST: "1",
      MYSHAPE_NOTIFY_MS: "2000",
      MYSHAPE_READ_MS: "300",
      MYSHAPE_IDLE_MS: "600000",
    },
  };
  makeRoot(scratch.root);
  scratch.main = makeRepository(join(dir, "repo"));
  writeFileSync(join(home, "config", "myshape-port"), `${port}\n`);
  const program = join(scratch.root, "adapters", "claude-agg", "bin", "agg-board.mjs");
  const binding = join(home, "config", "myshape-aggregator.json");
  writeFileSync(
    binding,
    `${JSON.stringify({ v: 1, name: AGENT_NAME, feed: program, deliver: program })}\n`,
  );
  chmodSync(binding, 0o644);
  started = true;
}

let confirmed = false;

/** Opens the scratch board and confirms the program on the page, once. */
async function openBoard(): Promise<void> {
  expect(scratch.port).not.toBe(LIVE_BOARD_PORT);
  const open = myshape("open");
  expect(open.status, open.stderr).toBe(0);
  if (confirmed) return;
  const first = await http("POST", "programs/confirm", { role: "feed" });
  const reply = await http("POST", "programs/confirm", { role: "feed", confirm: first["confirm"] });
  expect(reply["ok"], JSON.stringify(reply)).toBe(true);
  confirmed = true;
}

/** A page action that takes two steps: the first answers a code, the second sends it. */
async function twoStep(route: string, body: Json): Promise<Json> {
  const first = await http("POST", route, body);
  if (typeof first["confirm"] !== "string")
    throw new Error(`no code from ${route}: ${JSON.stringify(first)}`);
  return http("POST", route, { ...body, confirm: first["confirm"] });
}

async function writeState(id: unknown): Promise<{ state?: string; error?: string } | undefined> {
  const writes = (await http("GET", "state"))["writes"] as {
    id: string;
    state: string;
    error?: string;
  }[];
  return writes.find((write) => write.id === id);
}

function boardFile(path: string): string {
  const file = join(scratch.home, path);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function startSupervisor(query: ScriptedQuery, fake: FakeCommands): Promise<Supervisor> {
  return Supervisor.start(
    {
      home: scratch.home,
      worktreeRoot: scratch.work,
      boardCommand: join(scratch.root, "bin", "myshape.sh"),
      port: scratch.port,
      repos: { app: { path: scratch.main, base: "origin/main", defaultBranch: "main" } },
      model: undefined,
      credentialFile: join(scratch.dir, "no-credential"),
      readPaths: [],
    },
    {
      query: query.query,
      run: runner(fake),
      credential: { mode: "subscription-token", secret: CANARY },
      env: scratch.env,
      nowMs: () => Date.now(),
      log: (line) => logs.push(line),
      realPath: existingRealPath,
      pid: process.pid,
      isAlive: () => false,
      tmpRoot: scratch.dir,
    },
  );
}

/** The supervisor's runner: the scratch root's real myshape.sh, real git in the scratch directory, gh in memory. */
function runner(fake: FakeCommands): RunCommand {
  const board = join(scratch.root, "bin", "myshape.sh");
  return async (call) => {
    if (call.file === board) return spawnCommand(call);
    if (call.file === "git") {
      if (call.args[0] !== "-C" || !inScratch(call.args[1] ?? ""))
        throw new Error(`refused: ${call.args.join(" ")}`);
      return spawnCommand(call);
    }
    return fake.run(call);
  };
}

describe.skipIf(!IN_CI)(
  "one worker on a real board (runs only when CI is set; skipped otherwise)",
  () => {
    beforeAll(setUp, STEP_MS);

    afterAll(async () => {
      if (!started) return;
      try {
        const pidFile = join(scratch.home, "state", "myshape", "pid");
        const pid = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "";
        const stop = myshape("stop");
        expect(stop.status, stop.stderr).toBe(0);
        if (pid !== "")
          await waitFor("the board to stop", () => !existsSync(`/proc/${pid}`), 15_000);
      } finally {
        rmSync(scratch.dir, { recursive: true, force: true });
      }
    }, STEP_MS);

    it(
      "takes a topic to a task, a done light, a summary under the topic, and no worktree left",
      async () => {
        await openBoard();
        const made = myshape("create", "建置", "--goal", "把看板接上", "--id", "build");
        expect(made.status, made.stderr).toBe(0);

        const fake = new FakeCommands("/nowhere/myshape.sh");
        const query = new ScriptedQuery(scratch.work);
        query.planner.push({
          messages: [
            init("p", "default"),
            result(plan([{ title: "接上", repo: "app", kind: "ship", prompt: "照目標做" }])),
          ],
        });
        const gate = new Gate();
        query.worker.push({
          messages: [init("w"), result(workerOutput("ready", { pr_url: PR }), 0.3)],
          gate,
        });
        const supervisor = await startSupervisor(query, fake);
        supervisor.tick();
        await waitFor("the worker to start", () => query.active.size === 1);
        await waitFor(
          "an in-progress light",
          async () => (await light("build-1")) === "build:working",
        );

        gate.open();
        await supervisor.idle();
        await waitFor("a done light", async () => (await light("build-1")) === "build:done");
        expect(await summaries()).toContainEqual(
          expect.objectContaining({
            task: "build-1",
            kind: "ready",
            topic: "build",
            text: "worker ready",
          }),
        );

        fake.prStates.set(PR, "MERGED");
        await supervisor.pollPullRequests();
        expect(
          (await summaries()).map((entry) => `${entry.task} ${entry.kind} ${String(entry.topic)}`),
        ).toContain("build-1 landed build");
        const listed = git(scratch.main, "worktree", "list", "--porcelain")
          .split("\n")
          .filter((line) => line.startsWith("worktree "));
        const tasks = JSON.parse(readFileSync(join(scratch.home, "agg", "tasks.json"), "utf8")) as {
          tasks: Record<string, { worktree?: string }>;
        };
        expect(listed).toEqual([`worktree ${scratch.main}`]);
        expect(Object.values(tasks.tasks).filter((task) => task.worktree !== undefined)).toEqual(
          [],
        );
        expect(await light("build-1")).toBe("build:done");
        for (const file of [
          "data/myshape/summaries.jsonl",
          "data/myshape/events.jsonl",
          "agg/ledger.jsonl",
          "agg/tasks.json",
        ]) {
          expect(readFileSync(join(scratch.home, file), "utf8"), file).not.toContain(CANARY);
        }
        expect(proposed("build")).toBe(true);
        expect(
          logs.filter((line) => !line.startsWith("proposed closing topic build")),
          serviceLog(),
        ).toEqual([]);
        supervisor.close();
      },
      STEP_MS,
    );

    it(
      "takes a question, a two-step answer, a todo claim, a refused direct and hashtags through the board",
      async () => {
        await openBoard();
        logs.length = 0;
        const made = myshape("create", "問答", "--goal", "要 captain 決定", "--id", "ask");
        expect(made.status, made.stderr).toBe(0);
        const fake = new FakeCommands("/nowhere/myshape.sh");
        const query = new ScriptedQuery(scratch.work);
        const work = plan([{ title: "問", repo: "app", kind: "scout", prompt: "先問" }]);
        query.planner.push({ messages: [init("p2", "default"), result(work)] });
        const command = `${join(scratch.root, "bin", "myshape.sh")} todo done ask-1-vpn`;
        const tryBoard = { attempt: { tool: "Bash", input: { command } } };
        const question = { title: "要留快取嗎", text: "舊的快取要留嗎？", options: ["留", "不留"] };
        const vpn = { id: "vpn", title: "登入 VPN", do: "用公司帳號登入", cmds: ["sudo true"] };
        query.worker.push({
          messages: [
            init("w2"),
            tryBoard,
            result(workerOutput("report", { question, todos: [vpn] })),
          ],
        });
        query.worker.push({
          messages: [init("w2"), tryBoard, result(workerOutput("report", { todos: [vpn] }))],
        });
        query.worker.push({ messages: [init("w2"), result(workerOutput("report"))] });
        const supervisor = await startSupervisor(query, fake);
        supervisor.tick();
        await supervisor.idle();
        await waitFor(
          "a light waiting for the captain",
          async () => (await light("ask-1")) === "ask:decide",
        );
        expect(boardItems()).toEqual(["ask-1-vpn"]);

        const answer = await twoStep("holds/answer", {
          home: "main",
          task: "ask-1",
          answer: "不留",
          label: "不留",
        });
        await waitFor(
          "the answer",
          async () => (await writeState(answer["write_id"]))?.state === "delivered",
        );
        supervisor.tick();
        await supervisor.idle();
        expect(query.calls.at(-1)?.options.resume).toBe("w2");
        expect(query.calls.at(-1)?.prompts[0]).toContain('"answer": "不留"');
        await waitFor("a stuck light", async () => (await light("ask-1")) === "ask:stuck");

        const claim = await http("POST", "todos/claim", { task: "ask-1-vpn" });
        expect(claim["ok"], JSON.stringify(claim)).toBe(true);
        await waitFor("the claim's notice", () => hasNotice("todo.claimed"));
        supervisor.tick();
        await supervisor.idle();
        await waitFor("the item closed", () => !boardItems().includes("ask-1-vpn"));
        expect(records("todo.done").map((record) => record["by"])).toEqual(["aggregator"]);
        await waitFor("a done light", async () => (await light("ask-1")) === "ask:done");
        await waitFor("the close proposal", () => proposed("ask"));

        const direct = await http("POST", "direct", {
          home: "main",
          task: "ask-1",
          text: "還在嗎",
        });
        await waitFor(
          "the direct",
          async () => (await writeState(direct["write_id"]))?.state === "failed",
        );
        expect((await writeState(direct["write_id"]))?.error).toContain(
          "這個 worker 已經結束，訊息沒有送出。",
        );

        const boardCommand = join(scratch.root, "bin", "myshape.sh");
        const sent: string[][] = [];
        const recording: RunCommand = async (call) => {
          if (call.file === boardCommand) sent.push([...call.args]);
          return runner(fake)(call);
        };
        const board = new BoardCommand(recording, boardCommand, scratch.home, scratch.env);
        const tagger = new Tagger(scratch.home, board, () => Date.now());
        expect(await tagger.change("ask", "add", "AGG_TEST")).toEqual({ sent: true });
        expect(records("hashtag.added").map((record) => [record["by"], record["topic"]])).toEqual([
          ["aggregator", "ask"],
        ]);
        const hourly = await http("POST", "hashtags/settings", { aggregator_hourly_max: 1 });
        expect(hourly["ok"], JSON.stringify(hourly)).toBe(true);
        expect(await tagger.change("ask", "add", "AGG_MORE")).toEqual({
          sent: false,
          reason: HASHTAG_REASON.hourly(1, 1),
        });
        const off = await http("POST", "hashtags/settings", {
          aggregator_may_tag: false,
          aggregator_hourly_max: 20,
        });
        expect(off["ok"], JSON.stringify(off)).toBe(true);
        expect(await tagger.change("ask", "remove", "AGG_TEST")).toEqual({
          sent: false,
          reason: HASHTAG_REASON.mayTag,
        });
        expect(sent).toEqual([["hashtag", "ask", "+AGG_TEST"]]);
        expect(records("hashtag.removed")).toEqual([]);

        for (const call of query.calls) {
          expect(call.tools.filter((tool) => tool.ran)).toEqual([]);
        }
        expect(boardFile("data/myshape/events.jsonl")).not.toContain(CANARY);
        expect(
          logs.filter((line) => !/^(proposed closing|task ask-1: (the captain|passed))/.test(line)),
          serviceLog(),
        ).toEqual([]);
        supervisor.close();
      },
      STEP_MS,
    );

    it(
      "takes the captain's page schedule, starts its work at its time and closes it done",
      async () => {
        await openBoard();
        logs.length = 0;
        const made = myshape(
          "create",
          "週會",
          "--goal",
          "整理會議紀錄",
          "--id",
          "weekly",
          "--queue",
          "later",
        );
        expect(made.status, made.stderr).toBe(0);
        const fake = new FakeCommands("/nowhere/myshape.sh");
        const query = new ScriptedQuery(scratch.work);
        const work = plan([{ title: "整理", repo: "app", kind: "scout", prompt: "照目標做" }]);
        query.planner.push({ messages: [init("p3", "default"), result(work)] });
        const gate = new Gate();
        query.worker.push({ messages: [init("w3"), result(workerOutput("report"))], gate });
        const supervisor = await startSupervisor(query, fake);

        // The captain's schedule on the page: T on a minute at least 2 minutes from now
        // (recomputed right before the add), coming up 1 minute before it.
        const atMs = Math.ceil((Date.now() + 150_000) / 60_000) * 60_000;
        const added = await http("POST", "schedules/add", {
          topic: "weekly",
          daily: true,
          at: new Date(atMs).toISOString().slice(11, 16),
          tz: "UTC",
          lead: 1,
          duration: 15,
          rt: "hard-rt",
        });
        expect(added["ok"], JSON.stringify(added)).toBe(true);
        const utc = `${new Date(atMs).toISOString().slice(0, 16).replaceAll(/[-:]/g, "")}Z`;
        const key = `weekly:${utc}`;
        const task = `weekly-at-${utc}-1`;

        // The clock opens it at T - 1 minute, within its 30-second check.
        const opensBy = atMs - 60_000 + 30_000 + 15_000 - Date.now();
        await waitFor("the coming-up notice", () => hasNotice("schedule.upcoming"), opensBy);
        const noticed = Date.now();
        supervisor.tick();
        await waitFor("the take", () => occurrenceOf(key)?.["state"] === "taken", 15_000);
        expect(Date.now() - noticed).toBeLessThan(60_000);

        // Nothing starts before T; the work starts at T though the topic is in 待辦.
        await waitFor(
          "the occurrence's worker",
          () => {
            supervisor.tick();
            if (Date.now() < atMs) expect(query.calls).toEqual([]);
            return query.active.size === 1 && query.calls.length === 2;
          },
          atMs - Date.now() + 60_000,
        );
        expect(query.calls[1]?.options.cwd).toBe(join(scratch.work, task));
        await waitFor("an in-progress light", async () => (await light(task)) === "weekly:working");

        gate.open();
        await supervisor.idle();
        supervisor.tick();
        await waitFor("the close", () => recentOf("weekly").some((entry) => entry["key"] === key));
        expect(recentOf("weekly").find((entry) => entry["key"] === key)).toMatchObject({
          outcome: "done",
          by: "aggregator",
        });
        expect(records("occurrence.taken").map((record) => record["by"])).toEqual(["aggregator"]);
        expect(
          records("occurrence.closed").map((record) => [record["by"], record["outcome"]]),
        ).toEqual([["aggregator", "done"]]);
        expect(proposed("weekly")).toBe(false);

        // A missed hard-rt occurrence, landed through the program the board runs (no clock
        // wait): its report summary is filed under the topic, and no agent appears for it.
        const missedUtc = `${new Date(atMs - 86_400_000).toISOString().slice(0, 16).replaceAll(/[-:]/g, "")}Z`;
        const missed = `weekly:${missedUtc}`;
        const carrier = `weekly-at-${missedUtc}-missed`;
        expect(deliverNotice(missed, atMs - 86_400_000)).toBe("delivered");
        supervisor.tick();
        await waitFor("the missed report under its topic", async () => {
          await http("POST", "refresh", {});
          return (await summaries()).some(
            (entry) =>
              entry.task === carrier && entry.kind === "report" && entry.topic === "weekly",
          );
        });
        expect(await light(carrier)).toBe("missing");
        expect(
          logs.filter((line) => !/^((took|closed) occurrence|reported the missed) /.test(line)),
          serviceLog(),
        ).toEqual([]);
        supervisor.close();
      },
      8 * 60_000,
    );
  },
);

/** Lands a schedule.missed notice for `key` through the program's deliver, as the board does. */
function deliverNotice(key: string, atMs: number): string {
  const at = new Date(atMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  const record = {
    v: 1,
    id: `w-s-${key.replace(":", "-")}-missed`,
    attempt: 0,
    kind: "notice",
    event: "schedule.missed",
    text: "排程「週會」錯過了：看板當時沒在跑，這一場沒有通知（hard-rt）",
    topic: { id: "weekly", name: "週會" },
    occurrence: { key, at, local: at.slice(0, 16) + "Z", phase: "missed", rt: "hard-rt" },
  };
  const program = join(scratch.root, "adapters", "claude-agg", "bin", "agg-board.mjs");
  const out = spawnSync(process.execPath, [program, "deliver"], {
    env: { ...scratch.env, MYSHAPE_HOME: scratch.home },
    input: `${JSON.stringify(record)}\n`,
    encoding: "utf8",
  });
  if (out.status !== 0) throw new Error(`deliver exited ${String(out.status)}: ${out.stderr}`);
  const outcome = JSON.parse(out.stdout.trim().split("\n").at(-1) ?? "{}") as { outcome?: string };
  return outcome.outcome ?? "";
}

/** The open occurrence `key` in the board's schedules.json, or undefined. */
function occurrenceOf(key: string): Json | undefined {
  const doc = JSON.parse(boardFile("data/myshape/schedules.json") || "{}") as {
    occurrences?: Record<string, Json>;
  };
  return doc.occurrences?.[key];
}

/** The ended occurrences the board keeps for a schedule (`recent`). */
function recentOf(series: string): Json[] {
  const doc = JSON.parse(boardFile("data/myshape/schedules.json") || "{}") as {
    recent?: Record<string, Json[]>;
  };
  return doc.recent?.[series] ?? [];
}

/** Whether an inbox file (waiting or handled) holds a notice with this event. */
function hasNotice(event: string): boolean {
  for (const dir of ["inbox", "inbox/handled"]) {
    const path = join(scratch.home, "agg", dir);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path)) {
      if (
        name.endsWith(".json") &&
        readFileSync(join(path, name), "utf8").includes(`"event":"${event}"`)
      )
        return true;
    }
  }
  return false;
}

/** The board's system records of this kind in data/myshape/events.jsonl. */
function records(kind: string): Json[] {
  return boardFile("data/myshape/events.jsonl")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Json)
    .filter((record) => record["kind"] === kind);
}

/** The ids of the items on the board's 要你動手 list (todos.json `items`; its outbox names closed ones too). */
function boardItems(): string[] {
  const doc = JSON.parse(boardFile("data/myshape/todos.json") || "{}") as { items?: Json };
  return Object.keys(doc.items ?? {});
}

/** Whether the topic carries a close proposal in data/topics.json. */
function proposed(topic: string): boolean {
  const doc = JSON.parse(boardFile("data/topics.json") || "{}") as {
    topics?: Record<string, { close_proposal?: unknown }>;
  };
  return doc.topics?.[topic]?.close_proposal !== undefined;
}
