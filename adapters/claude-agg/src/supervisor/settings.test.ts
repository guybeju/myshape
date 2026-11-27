import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { CANARY } from "./harness.test-helper.js";
import { parsePlannerOutput, parseWorkerOutput } from "./outputs.js";
import {
  boardPort,
  checkSettings,
  LOCK_NAME,
  SettingsError,
  takeLock,
  type Settings,
} from "./settings.js";
import { StateStore } from "./state-store.js";
import { redactor } from "./credential.js";

const dir = mkdtempSync(join(tmpdir(), "claude-agg-settings-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SETTINGS: Settings = {
  home: "/srv/home",
  worktreeRoot: "/work",
  boardCommand: "/checkout/bin/myshape.sh",
  port: 47_829,
  repos: { app: { path: "/repos/app", base: "origin/main", defaultBranch: "main" } },
  model: undefined,
  credentialFile: "/secrets/claude-agg/credential",
  readPaths: ["/opt/toolchain"],
};
const same = (path: string): string => path;
const USER_HOME = "/home/u";

describe("checkSettings", () => {
  it("takes good settings", () => {
    expect(checkSettings(SETTINGS, same, USER_HOME)).toEqual(SETTINGS);
  });

  it.each([
    [{ home: "srv/home" }, "home must be an absolute path"],
    [{ worktreeRoot: "/srv/home/work" }, "must not contain each other"],
    [{ worktreeRoot: "/srv" }, "must not contain each other"],
    [{ port: 0 }, "not a TCP port"],
    [{ repos: {} }, "no repository"],
    [{ repos: { "../x": SETTINGS.repos["app"] } }, "not a plain name"],
    [
      { repos: { app: { path: "repos/app", base: "origin/main", defaultBranch: "main" } } },
      "absolute",
    ],
    [
      { repos: { app: { path: "/srv/home/app", base: "origin/main", defaultBranch: "main" } } },
      "inside the board home",
    ],
    [{ repos: { app: { path: "/r", base: " ", defaultBranch: "main" } } }, "must be set"],
  ])("refuses %j", (change, message) => {
    expect(() => checkSettings({ ...SETTINGS, ...change } as Settings, same, USER_HOME)).toThrow(
      message,
    );
  });

  it.each([
    ["the home directory", "/home/u", "is the home directory or holds it"],
    ["the home directory with a trailing slash", "/home/u/", "is the home directory or holds it"],
    ["a directory above it", "/home", "is the home directory or holds it"],
    ["the root", "/", "is the home directory or holds it"],
    ["a directory holding the credential file", "/secrets", "holds /secrets/claude-agg/credential"],
    [
      "the credential file itself",
      "/secrets/claude-agg/credential",
      "holds /secrets/claude-agg/credential",
    ],
    ["a directory holding the board home", "/srv", "holds /srv/home"],
    ["the gh login", "/home/u/.config/gh", "holds /home/u/.config/gh"],
    ["a directory holding the gh login", "/home/u/.config", "holds /home/u/.config/gh"],
    ["~/.ssh", "/home/u/.ssh", "holds /home/u/.ssh"],
    [
      "a directory holding Claude's credentials",
      "/home/u/.claude",
      "holds /home/u/.claude/.credentials.json",
    ],
  ])("refuses a readPaths entry that is %s", (_what, entry, message) => {
    expect(() => checkSettings({ ...SETTINGS, readPaths: [entry] }, same, USER_HOME)).toThrow(
      message,
    );
  });

  it("takes readPaths entries beside the secrets, and inside the home directory", () => {
    const readPaths = ["/home/u/.local/bin", "/home/u/.gitconfig", "/opt/toolchain", "/home/u2"];
    expect(checkSettings({ ...SETTINGS, readPaths }, same, USER_HOME).readPaths).toEqual(readPaths);
  });

  it("refuses a readPaths entry whose links lead to the home directory", () => {
    const realPath = (path: string): string => (path === "/opt/link" ? "/home/u" : path);
    expect(() =>
      checkSettings({ ...SETTINGS, readPaths: ["/opt/link"] }, realPath, USER_HOME),
    ).toThrow("is the home directory or holds it");
  });

  it("compares paths with their links resolved", () => {
    const realPath = (path: string): string => (path === "/work" ? "/srv/home/work" : path);
    expect(() => checkSettings(SETTINGS, realPath, USER_HOME)).toThrow(SettingsError);
  });
});

describe("boardPort", () => {
  it("reads config/myshape-port, else 47819", () => {
    const home = join(dir, "home");
    mkdirSync(join(home, "config"), { recursive: true });
    expect(boardPort(home)).toBe(47_819);
    writeFileSync(join(home, "config", "myshape-port"), "47829\n");
    expect(boardPort(home)).toBe(47_829);
    writeFileSync(join(home, "config", "myshape-port"), "x\n");
    expect(() => boardPort(home)).toThrow(SettingsError);
  });
});

describe("takeLock", () => {
  it("lets one process hold it, takes over a dead one's, and gives it back", () => {
    const root = join(dir, "root");
    mkdirSync(root);
    const release = takeLock(root, 10, () => false);
    expect(readFileSync(join(root, LOCK_NAME), "utf8")).toBe("10\n");
    expect(() => takeLock(root, 11, (pid) => pid === 10)).toThrow("another supervisor (pid 10)");
    const again = takeLock(root, 11, () => false);
    expect(readFileSync(join(root, LOCK_NAME), "utf8")).toBe("11\n");
    again();
    expect(existsSync(join(root, LOCK_NAME))).toBe(false);
    expect(typeof release).toBe("function");
  });
});

describe("StateStore", () => {
  it("writes 0600 files through a temporary file and the redactor, and leaves no temporary file", () => {
    const agg = join(dir, "agg");
    const store = new StateStore(agg, redactor(CANARY), () => 100);
    store.setUp();
    expect(statSync(agg).mode & 0o777).toBe(0o700);
    store.writeTasks(new Map([["t-1", { kind: "ship", state: "working", detail: `x ${CANARY}` }]]));
    store.appendLedger({ event: "task.status", task: "t-1", state: "working", text: CANARY });
    expect(readFileSync(join(agg, "tasks.json"), "utf8")).not.toContain(CANARY);
    expect(readFileSync(join(agg, "ledger.jsonl"), "utf8")).toBe(
      '{"v":1,"ts":100,"event":"task.status","task":"t-1","state":"working","text":"[redacted]"}\n',
    );
    expect(statSync(join(agg, "tasks.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(agg).filter((name) => name.startsWith("."))).toEqual([]);
    expect(store.readTasks().get("t-1")?.detail).toBe("x [redacted]");
  });

  it("refuses a state file that is not its format", () => {
    const agg = join(dir, "bad");
    const store = new StateStore(agg, redactor(CANARY), () => 1);
    store.setUp();
    writeFileSync(join(agg, "tasks.json"), "{");
    expect(() => store.readTasks()).toThrow("is not valid JSON");
    writeFileSync(join(agg, "holds.json"), '{"v":2}');
    expect(() => store.readHolds()).toThrow("is not a v 1 object");
    writeFileSync(join(agg, "queued.json"), '{"v":1,"queued":{}}');
    expect(() => store.readQueued()).toThrow("bad queued");
  });
});

describe("outputs", () => {
  it("takes a worker's output only in its schema", () => {
    const base = { summary: "s", todos: [], question: null };
    expect(parseWorkerOutput({ ...base, outcome: "report", pr_url: null })?.outcome).toBe("report");
    expect(
      parseWorkerOutput({ ...base, outcome: "ready", pr_url: "https://github.com/o/r/pull/2" }),
    ).toMatchObject({
      pr_url: "https://github.com/o/r/pull/2",
    });
    for (const bad of [
      { ...base, outcome: "ready", pr_url: "http://evil/pull/2" },
      { ...base, outcome: "merged" },
      { ...base, outcome: "report", summary: "x".repeat(601) },
      { ...base, outcome: "report", todos: [{ id: "x" }] },
      { ...base, outcome: "report", question: { title: "q", text: "t", options: ["A"] } },
      "text",
    ]) {
      expect(parseWorkerOutput(bad)).toBeUndefined();
    }
  });

  it("takes the planner's output only in its schema", () => {
    const task = { title: "t", repo: "app", kind: "ship", prompt: "p" };
    expect(parsePlannerOutput({ tasks: [task], question: null, nothing: false })?.tasks).toEqual([
      task,
    ]);
    expect(
      parsePlannerOutput({ tasks: [{ ...task, kind: "merge" }], question: null, nothing: false }),
    ).toBeUndefined();
    expect(parsePlannerOutput({ tasks: [], question: null })).toBeUndefined();
  });
});
