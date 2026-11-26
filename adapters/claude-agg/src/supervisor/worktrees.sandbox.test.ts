// The supervisor's worktrees with real git, in sandbox repositories this test
// makes under its own temporary directory: a bare "remote" and a main
// checkout. Every git call, the test's own and the supervisor's, goes through
// a runner that refuses any directory outside that temporary directory, so
// no worktree is ever made, listed or removed anywhere else. The query and
// the board's command stay doubles.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { spawnCommand, type RunCommand } from "./commands.js";
import { Gate, init, removeScratch, result, workerOutput } from "./harness.test-helper.js";
import { World } from "./world.test-helper.js";

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "claude-agg-git-")));
afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
  removeScratch();
});

const GIT_ENV = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  HOME: join(sandbox, "h"),
  LANG: "C.UTF-8",
  TMPDIR: tmpdir(),
  GIT_CONFIG_NOSYSTEM: "1",
};
mkdirSync(GIT_ENV.HOME);

/** Whether `dir` is in one of the test's own temporary directories. */
function insideSandbox(dir: string | undefined, roots: readonly string[] = [sandbox]): boolean {
  return dir !== undefined && roots.some((root) => dir === root || dir.startsWith(`${root}/`));
}

/** git -C <dir> for the test itself, only inside the sandbox. */
function git(dir: string, ...args: string[]): string {
  if (!insideSandbox(dir, [sandbox, ...worktreeRoots]))
    throw new Error(`refused: git outside the sandbox (${dir})`);
  const identity = [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.invalid",
    "-c",
    "commit.gpgsign=false",
  ];
  const out = spawnSync("git", ["-C", dir, ...identity, ...args], {
    env: GIT_ENV,
    encoding: "utf8",
  });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout;
}

/** The supervisor's runner: real git inside the sandbox only, the world's fakes for the rest. */
function guarded(world: World): RunCommand {
  return async (request) => {
    if (request.file !== "git") return world.commands.run(request);
    const where = request.args[1];
    if (request.args[0] !== "-C" || !insideSandbox(where, [sandbox, world.root])) {
      throw new Error(`refused: git outside the sandbox (${request.args.join(" ")})`);
    }
    return spawnCommand({ ...request, env: { ...request.env, ...GIT_ENV } });
  };
}

let n = 0;
/** The worktree roots of this file's worlds, also the test's own temporary directories. */
const worktreeRoots: string[] = [];

/** A sandbox repository with one commit pushed to its bare remote; returns the main checkout. */
function repository(): string {
  n += 1;
  const remote = join(sandbox, `remote-${n}.git`);
  const main = join(sandbox, `main-${n}`);
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

function worktreeList(main: string): string[] {
  return git(main, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

async function start(world: World, main: string) {
  worktreeRoots.push(world.root);
  const { Supervisor } = await import("./supervisor.js");
  const settings = {
    ...world.settings(),
    repos: { app: { path: main, base: "origin/main", defaultBranch: "main" } },
  };
  return Supervisor.start(settings, { ...world.deps(), run: guarded(world) });
}

describe("worktrees with real git, in a sandbox", () => {
  it("adds the worktree on agg/<task> from the base, removes it, and git agrees with tasks.json", async () => {
    const main = repository();
    const world = new World({ normal: ["a"] });
    world.seedQueued([{ id: "a-1", topic: "a" }]);
    const gate = new Gate();
    world.query.worker.push({ messages: [init("s"), result(workerOutput("report"))], gate });
    const supervisor = await start(world, main);
    supervisor.tick();
    for (let i = 0; i < 50 && world.query.active.size === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const worktree = join(world.root, "a-1");
    expect(worktreeList(main)).toEqual([main, worktree]);
    expect(git(worktree, "branch", "--show-current").trim()).toBe("agg/a-1");
    expect(world.tasks()["a-1"]?.worktree).toBe(worktree);
    gate.open();
    await supervisor.idle();
    expect(worktreeList(main)).toEqual([main]);
    expect(existsSync(worktree)).toBe(false);
    expect(world.tasks()["a-1"]?.worktree).toBeUndefined();
    supervisor.close();
  });

  it("keeps a worktree with a commit no remote has, and removes it once the branch is pushed", async () => {
    const main = repository();
    const world = new World({ normal: ["a"] });
    world.seedQueued([{ id: "a-1", topic: "a" }]);
    const gate = new Gate();
    const pr = "https://github.com/owner/app/pull/3";
    world.query.worker.push({
      messages: [init("s"), result(workerOutput("ready", { pr_url: pr }))],
      gate,
    });
    const supervisor = await start(world, main);
    supervisor.tick();
    for (let i = 0; i < 50 && world.query.active.size === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const worktree = join(world.root, "a-1");
    writeFileSync(join(worktree, "work.txt"), "done\n");
    git(worktree, "add", "work.txt");
    git(worktree, "commit", "-qm", "work");
    gate.open();
    await supervisor.idle();
    world.commands.prStates.set(pr, "CLOSED");
    await supervisor.pollPullRequests();
    expect(world.tasks()["a-1"]).toMatchObject({
      state: "blocked",
      detail: "worktree 還有沒推的提交",
    });
    expect(worktreeList(main)).toEqual([main, worktree]);

    git(worktree, "push", "-q", "origin", "agg/a-1");
    const tasks = world.tasks();
    tasks["a-1"] = { ...tasks["a-1"], kind: "ship", state: "done", pr_url: pr };
    writeFileSync(join(world.agg, "tasks.json"), JSON.stringify({ v: 1, tasks }));
    supervisor.close();
    const again = await start(world, main);
    world.commands.prStates.set(pr, "MERGED");
    await again.pollPullRequests();
    expect(worktreeList(main)).toEqual([main]);
    expect(world.events("a-1").slice(-2)).toEqual(["status done 已合併", "task.cleaned_up"]);
    again.close();
  });

  it("refuses git outside the sandbox", async () => {
    const world = new World({ normal: [] });
    await expect(
      guarded(world)({ file: "git", args: ["-C", "/", "status"], env: {} }),
    ).rejects.toThrow("refused");
    expect(() => git("/", "status")).toThrow("refused");
  });
});
