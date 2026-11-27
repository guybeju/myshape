// The entry point with everything real but the model: a real supervisor on
// a scratch board home, real git in a sandbox repository under the test's own
// temporary directory, a stand-in for the board's command that only answers
// `status`, and a query double that is never asked (no topic is
// dispatchable). No board service, no claude, no model.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { boardHome, CANARY, removeScratch, ScriptedQuery } from "./harness.test-helper.js";
import { main, plainEnv, USAGE, type MainDeps } from "./main.js";
import { LOCK_NAME } from "./settings.js";
import { PLANNER_DIR } from "./supervisor.js";

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "claude-agg-main-")));
afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
  removeScratch();
});
const uid = process.getuid?.() ?? 0;
const ENV = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  HOME: join(sandbox, "h"),
  LANG: "C.UTF-8",
  TMPDIR: tmpdir(),
};
mkdirSync(ENV.HOME);

let n = 0;

/** A board home, a worktree root, a sandbox repository, a stand-in board command and the files. */
function scene(auth = "subscription-token", line = `CLAUDE_CODE_OAUTH_TOKEN=${CANARY}`) {
  n += 1;
  const { home, root } = boardHome({ normal: [] });
  const repo = join(sandbox, `repo-${n}`);
  mkdirSync(repo);
  spawnSync("git", ["-C", repo, "init", "-q", "-b", "main"], { env: ENV });
  const board = join(sandbox, `myshape-${n}.sh`);
  writeFileSync(board, '#!/bin/sh\n[ "$1" = status ] && echo "看板服務：在跑"\nexit 0\n');
  chmodSync(board, 0o755);
  const credentialFile = join(sandbox, `credential-${n}`);
  writeFileSync(credentialFile, `${line}\n`);
  chmodSync(credentialFile, 0o600);
  const settings = join(sandbox, `settings-${n}.json`);
  const file = {
    v: 1,
    home,
    worktreeRoot: root,
    boardCommand: board,
    repos: { app: { path: repo, base: "origin/main", defaultBranch: "main" } },
    auth,
    credentialFile,
  };
  writeFileSync(settings, JSON.stringify(file));
  chmodSync(settings, 0o600);
  return { home, root, settings, credentialFile };
}

function deps(root: string, stop: Promise<string>, logs: string[]): MainDeps {
  return {
    query: new ScriptedQuery(root).query,
    env: { ...ENV, ANTHROPIC_API_KEY: "sk-ant-terminal-not-real" },
    uid,
    pid: process.pid,
    log: (line) => logs.push(line),
    stopSignal: stop,
    pollMs: 60_000,
  };
}

describe("main", () => {
  it("prints its usage for anything but one argument", async () => {
    const logs: string[] = [];
    expect(await main([], deps(sandbox, new Promise(() => {}), logs))).toBe(2);
    expect(await main(["a", "b"], deps(sandbox, new Promise(() => {}), logs))).toBe(2);
    expect(logs).toEqual([USAGE, USAGE]);
  });

  it("starts, runs a pass, and on the signal stops and gives the lock back", async () => {
    const { home, root, settings } = scene();
    const logs: string[] = [];
    let signal: (name: string) => void = () => {};
    const stop = new Promise<string>((done) => (signal = done));
    const running = main([settings], deps(root, stop, logs));
    await expect.poll(() => existsSync(join(home, "agg", "tasks.json"))).toBe(true);
    expect(readFileSync(join(root, LOCK_NAME), "utf8")).toBe(`${process.pid}\n`);
    expect(existsSync(join(root, PLANNER_DIR))).toBe(true);
    signal("SIGTERM");
    expect(await running).toBe(0);
    expect(existsSync(join(root, LOCK_NAME))).toBe(false);
    expect(logs.at(-1)).toBe("claude-agg: stopped");
    expect(logs.join("\n")).not.toContain(CANARY);
  });

  it("takes the API key mode from the settings", async () => {
    const { root, settings } = scene("api-key", `ANTHROPIC_API_KEY=${CANARY}`);
    const logs: string[] = [];
    const running = main([settings], deps(root, Promise.resolve("SIGINT"), logs));
    expect(await running).toBe(0);
  });

  it("does not start a second supervisor on the same worktree root", async () => {
    const { root, settings } = scene();
    const logs: string[] = [];
    let signal: (name: string) => void = () => {};
    const first = main([settings], deps(root, new Promise((done) => (signal = done)), logs));
    await expect.poll(() => existsSync(join(root, LOCK_NAME))).toBe(true);
    expect(await main([settings], deps(root, new Promise(() => {}), logs))).toBe(1);
    expect(logs).toContainEqual(expect.stringContaining("another supervisor"));
    signal("SIGINT");
    expect(await first).toBe(0);
  });

  it.each([
    [
      "a settings file others can read",
      (s: ReturnType<typeof scene>) => chmodSync(s.settings, 0o644),
      "chmod 600",
    ],
    [
      "a credential file of the other mode",
      (s: ReturnType<typeof scene>) =>
        writeFileSync(s.credentialFile, `ANTHROPIC_API_KEY=${CANARY}\n`),
      "CLAUDE_CODE_OAUTH_TOKEN=<value>",
    ],
    [
      "a missing credential file",
      (s: ReturnType<typeof scene>) => rmSync(s.credentialFile),
      "ENOENT",
    ],
  ])("does not start with %s, and says why", async (_what, spoil, why) => {
    const s = scene();
    spoil(s);
    const logs: string[] = [];
    expect(await main([s.settings], deps(s.root, new Promise(() => {}), logs))).toBe(1);
    expect(logs).toEqual([expect.stringContaining(why)]);
    expect(logs.join("\n")).not.toContain(CANARY);
    expect(existsSync(join(s.root, LOCK_NAME))).toBe(false);
  });
});

describe("plainEnv", () => {
  it("takes four names and nothing else of the terminal's environment", () => {
    const env = plainEnv({ ...ENV, ANTHROPIC_API_KEY: "x", GH_TOKEN: "y", SSH_AUTH_SOCK: "/s" });
    expect(env).toEqual(ENV);
  });

  it("fills LANG and TMPDIR, and needs PATH and an absolute HOME", () => {
    expect(plainEnv({ PATH: "/bin", HOME: "/h" })).toEqual({
      PATH: "/bin",
      HOME: "/h",
      LANG: "C.UTF-8",
      TMPDIR: "/tmp",
    });
    expect(() => plainEnv({ HOME: "/h" })).toThrow("PATH is not set");
    expect(() => plainEnv({ PATH: "/bin", HOME: "h" })).toThrow("HOME is not an absolute path");
  });
});
