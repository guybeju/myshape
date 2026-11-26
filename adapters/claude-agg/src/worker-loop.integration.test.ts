// Step 3's acceptance on a real board: a topic gets a task, its light goes
// from in progress to done, its summary appears under the topic, and its
// worktree is removed so `git worktree list` matches tasks.json. The board is
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
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
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
        expect(scratch.port).not.toBe(LIVE_BOARD_PORT);
        const open = myshape("open");
        expect(open.status, open.stderr).toBe(0);
        const first = await http("POST", "programs/confirm", { role: "feed" });
        const confirmed = await http("POST", "programs/confirm", {
          role: "feed",
          confirm: first["confirm"],
        });
        expect(confirmed["ok"], JSON.stringify(confirmed)).toBe(true);
        const made = myshape("create", "建置", "--goal", "把看板接上", "--id", "build");
        expect(made.status, made.stderr).toBe(0);

        const fake = new FakeCommands("/nowhere/myshape.sh");
        const query = new ScriptedQuery(scratch.work);
        query.planner.push({
          messages: [
            init("p", "dontAsk"),
            result(plan([{ title: "接上", repo: "app", kind: "ship", prompt: "照目標做" }])),
          ],
        });
        const gate = new Gate();
        query.worker.push({
          messages: [init("w"), result(workerOutput("ready", { pr_url: PR }), 0.3)],
          gate,
        });
        const supervisor = await Supervisor.start(
          {
            home: scratch.home,
            worktreeRoot: scratch.work,
            boardCommand: join(scratch.root, "bin", "myshape.sh"),
            port: scratch.port,
            repos: { app: { path: scratch.main, base: "origin/main", defaultBranch: "main" } },
            model: undefined,
          },
          {
            query: query.query,
            run: runner(fake),
            token: CANARY,
            env: scratch.env,
            nowMs: () => Date.now(),
            log: () => {},
            realPath: existingRealPath,
            pid: process.pid,
            isAlive: () => false,
          },
        );
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
        supervisor.close();
      },
      STEP_MS,
    );
  },
);
