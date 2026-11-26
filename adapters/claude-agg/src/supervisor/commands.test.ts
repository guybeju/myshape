import { describe, expect, it } from "vitest";

import {
  BoardCommand,
  clip,
  Git,
  pullRequestState,
  spawnCommand,
  type CommandRequest,
  type CommandResult,
  type RunCommand,
} from "./commands.js";
import { ENV } from "./harness.test-helper.js";

/** A runner that answers from a list and records each request. */
function scripted(...answers: CommandResult[]): { run: RunCommand; calls: CommandRequest[] } {
  const calls: CommandRequest[] = [];
  return {
    calls,
    run: async (request) => {
      calls.push(request);
      return answers.shift() ?? { status: 0, stdout: "", stderr: "" };
    },
  };
}

const ok = (stdout = ""): CommandResult => ({ status: 0, stdout, stderr: "" });
const BOARD = "/checkout/bin/myshape.sh";

describe("BoardCommand", () => {
  it("writes a summary with myshape.sh summary <task> <kind> - and the text on stdin", async () => {
    const { run, calls } = scripted(ok("建置：\n"));
    const board = new BoardCommand(run, BOARD, "/srv/home", ENV);
    expect(await board.summary("build-1", "ready", "PR 就緒")).toBeUndefined();
    expect(calls).toEqual([
      {
        file: BOARD,
        args: ["summary", "build-1", "ready", "-"],
        env: { MYSHAPE_HOME: "/srv/home", ...ENV },
        input: "PR 就緒",
      },
    ]);
  });

  it("repeats once when the outcome is unknown (exit 3), then reports a refusal", async () => {
    const { run, calls } = scripted(
      { status: 3, stdout: "", stderr: "x" },
      { status: 1, stdout: "", stderr: "看板拒收\n摘要太長" },
    );
    const board = new BoardCommand(run, BOARD, "/srv/home", ENV);
    expect(await board.summary("t", "report", "x")).toBe("myshape.sh summary exited 1: 摘要太長");
    expect(calls).toHaveLength(2);
  });

  it("opens the board only when status does not say it runs", async () => {
    const running = scripted(ok("看板服務：在跑（pid：1）\n"));
    expect(await new BoardCommand(running.run, BOARD, "/h", ENV).ensureRunning()).toBeUndefined();
    expect(running.calls.map((call) => call.args)).toEqual([["status"]]);
    const stopped = scripted(
      { status: 0, stdout: "看板服務：沒在跑\n", stderr: "" },
      ok("http://x/\n"),
    );
    expect(await new BoardCommand(stopped.run, BOARD, "/h", ENV).ensureRunning()).toBeUndefined();
    expect(stopped.calls.map((call) => call.args)).toEqual([["status"], ["open"]]);
    const broken = scripted(
      { status: 1, stdout: "", stderr: "" },
      { status: 69, stdout: "", stderr: "" },
    );
    expect(await new BoardCommand(broken.run, BOARD, "/h", ENV).ensureRunning()).toBe(
      "myshape.sh open exited 69",
    );
  });

  it("needs an absolute path", () => {
    expect(() => new BoardCommand(scripted().run, "bin/myshape.sh", "/h", ENV)).toThrow("absolute");
  });
});

describe("clip", () => {
  it("cuts by code points, not UTF-16 units", () => {
    const text = "😀".repeat(601);
    expect([...clip(text)]).toHaveLength(600);
    expect(clip(text).endsWith("…")).toBe(true);
    expect(clip("😀".repeat(600))).toBe("😀".repeat(600));
    expect(clip("  a  ")).toBe("a");
  });
});

describe("Git", () => {
  it("always runs git -C <dir> with its own environment", async () => {
    const { run, calls } = scripted(
      ok(),
      ok("3\n"),
      ok(),
      ok("worktree /r\nHEAD x\n\nworktree /w/t-1\n"),
    );
    const git = new Git(run, ENV);
    expect(await git.addWorktree("/r", "/w/t-1", "agg/t-1", "origin/main")).toBeUndefined();
    expect(await git.unpushedCommits("/w/t-1")).toBe(3);
    expect(await git.removeWorktree("/r", "/w/t-1")).toBeUndefined();
    expect(await git.worktrees("/r")).toEqual(["/r", "/w/t-1"]);
    expect(calls.map((call) => call.args)).toEqual([
      ["-C", "/r", "worktree", "add", "/w/t-1", "-b", "agg/t-1", "origin/main"],
      ["-C", "/w/t-1", "rev-list", "--count", "HEAD", "--not", "--remotes"],
      ["-C", "/r", "worktree", "remove", "/w/t-1"],
      ["-C", "/r", "worktree", "list", "--porcelain"],
    ]);
    expect(calls[0]?.env).toEqual({ ...ENV, GIT_TERMINAL_PROMPT: "0" });
  });

  it("reports failures as one line or undefined", async () => {
    const fail = { status: 128, stdout: "", stderr: "fatal: one\nfatal: two\n" };
    const { run } = scripted(fail, fail, fail, fail);
    const git = new Git(run, ENV);
    expect(await git.addWorktree("/r", "/w", "b", "o")).toBe("fatal: two");
    expect(await git.unpushedCommits("/w")).toBeUndefined();
    expect(await git.removeWorktree("/r", "/w")).toBe("fatal: two");
    expect(await git.worktrees("/r")).toBeUndefined();
  });

  it("refuses a relative directory", async () => {
    await expect(new Git(scripted().run, ENV).git("repo", "status")).rejects.toThrow("absolute");
  });
});

describe("pullRequestState", () => {
  it.each([
    [ok('{"state":"MERGED"}'), "MERGED"],
    [ok('{"state":"OPEN"}'), "OPEN"],
    [ok('{"state":"CLOSED"}'), "CLOSED"],
    [ok('{"state":"DRAFT"}'), undefined],
    [ok("not json"), undefined],
    [{ status: 1, stdout: "", stderr: "" }, undefined],
  ])("reads %j as %s", async (answer, state) => {
    const { run, calls } = scripted(answer);
    expect(await pullRequestState(run, ENV, "https://github.com/o/r/pull/1")).toBe(state);
    expect(calls[0]?.args).toEqual([
      "pr",
      "view",
      "https://github.com/o/r/pull/1",
      "--json",
      "state",
    ]);
  });
});

describe("spawnCommand", () => {
  const node = process.execPath;

  it("passes stdin and exactly the given environment", async () => {
    const script =
      "process.stdout.write(require('fs').readFileSync(0,'utf8') + Object.keys(process.env).sort().join(','))";
    const out = await spawnCommand({
      file: node,
      args: ["-e", script],
      env: { ONLY: "1" },
      input: "hi ",
    });
    expect(out).toEqual({ status: 0, stdout: "hi ONLY", stderr: "" });
  });

  it("gives the exit status of a program that ends before reading its input", async () => {
    const out = await spawnCommand({
      file: node,
      args: ["-e", "process.exit(3)"],
      env: {},
      input: "x".repeat(4_000_000),
    });
    expect(out.status).toBe(3);
  });

  it("gives a program with no input no stdin", async () => {
    const out = await spawnCommand({
      file: node,
      args: ["-e", "process.stdout.write(String(require('fs').fstatSync(0).isFIFO()))"],
      env: {},
    });
    expect(out.stdout).toBe("false");
  });

  it("rejects a program that does not exist", async () => {
    await expect(spawnCommand({ file: "/no/such/program", args: [], env: {} })).rejects.toThrow(
      "ENOENT",
    );
  });
});

describe("BoardCommand's board writes", () => {
  const board = (run: RunCommand) => new BoardCommand(run, BOARD, "/srv/home", ENV);

  it("puts an item on with todo add, one --cmd per command, the task as --ref, nothing on stdin", async () => {
    const { run, calls } = scripted(ok());
    const item = {
      id: "b-1-vpn",
      title: "登入 VPN",
      topic: "b",
      do: "登入",
      cmds: ["sudo a", "-x b"],
      ref: "b-1",
    };
    expect(await board(run).todoAdd(item)).toBeUndefined();
    expect(calls).toEqual([
      {
        file: BOARD,
        args: [
          "todo",
          "add",
          "b-1-vpn",
          "登入 VPN",
          "--topic",
          "b",
          "--do",
          "登入",
          "--cmd",
          "sudo a",
          "--cmd",
          "-x b",
          "--ref",
          "b-1",
        ],
        env: { MYSHAPE_HOME: "/srv/home", ...ENV },
      },
    ]);
  });

  it("closes, rejects and drops items, proposes a close and changes hashtags", async () => {
    const { run, calls } = scripted();
    const b = board(run);
    await b.todoDone("i");
    await b.todoFailed("i", "還沒好");
    await b.todoObsolete("i", "不需要");
    await b.closePropose("t", "都落地了");
    await b.hashtag("t", "add", "AI");
    await b.hashtag("t", "remove", "AI");
    expect(calls.map((call) => call.args)).toEqual([
      ["todo", "done", "i"],
      ["todo", "failed", "i", "--reason", "還沒好"],
      ["todo", "obsolete", "i", "--reason", "不需要"],
      ["close-propose", "t", "--reason", "都落地了"],
      ["hashtag", "t", "+AI"],
      ["hashtag", "t", "--remove", "AI"],
    ]);
    expect(calls.every((call) => call.input === undefined)).toBe(true);
  });

  it("repeats a write once on exit 3 and names the command in a refusal", async () => {
    const { run, calls } = scripted(
      { status: 3, stdout: "", stderr: "" },
      { status: 1, stdout: "", stderr: "沒有這個項目" },
    );
    expect(await board(run).todoDone("i")).toBe("myshape.sh todo done exited 1: 沒有這個項目");
    expect(calls).toHaveLength(2);
  });
});
