// Step 3 of the plan: one worker end to end, with a scripted query and the
// fake commands. No model, no process, no board service.

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir as systemTmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { runProgram } from "#agg/test-home.js";

import { Git, type RunCommand } from "./commands.js";
import { endingOf } from "./ending.js";
import { Forge, FORGE_TEXT } from "./forge.js";
import { SKILL_RULE } from "./prompts.js";
import {
  CANARY,
  ENV,
  errorResult,
  Gate,
  init,
  LOADED_PLUGIN,
  maxTurns,
  plan,
  removeScratch,
  result,
  workerOutput,
} from "./harness.test-helper.js";
import { PLUGIN_DIR, PluginError } from "./plugin.js";
import { LOCK_NAME, SettingsError } from "./settings.js";
import { Supervisor, withForge } from "./supervisor.js";
import { REPO, World } from "./world.test-helper.js";

afterAll(removeScratch);

const PR = "https://github.com/owner/app/pull/7";
const BUILD_PLAN = plan([{ title: "建起來", repo: "app", kind: "ship", prompt: "照目標做" }]);

/** A world whose topic `build` gets one task from the planner, and that task's worker script. */
function oneTask(worker: object[], queues = { normal: ["build"] }): World {
  const world = new World(queues);
  world.query.planner.push({ messages: [init("p1", "default"), result(BUILD_PLAN, 0.01)] });
  world.query.worker.push({ messages: worker });
  return world;
}

describe("one worker end to end", () => {
  it("plans the topic, runs the worker in its worktree, and lands the PR", async () => {
    const world = oneTask([init("w1"), result(workerOutput("ready", { pr_url: PR }), 0.42)]);
    const supervisor = await world.start();
    supervisor.tick();
    await supervisor.idle();

    const worktree = join(world.root, "build-1");
    expect(world.commands.allWorktrees()).toContain(worktree);
    expect(world.tasks()["build-1"]).toMatchObject({
      kind: "ship",
      state: "done",
      title: "建起來",
      repo: "app",
      worktree,
      branch: "agg/build-1",
      pr_url: PR,
      session_id: "w1",
      model: "test-model",
      cost_usd_estimate: 0.42,
      unstarted: false,
    });
    expect(world.events("build-1")).toEqual([
      "task.dispatched",
      "status working worker 在做（模型：test-model）",
      `task.pr_ready ${PR}`,
      "status done PR 就緒，等合併（估計花費 0.42 美元）",
    ]);
    expect(world.commands.summaries).toEqual([
      { task: "build-1", kind: "ready", text: "worker ready" },
    ]);
    expect(world.queued()).toEqual([]);

    world.commands.prStates.set(PR, "MERGED");
    await supervisor.pollPullRequests();
    expect(world.events("build-1").slice(4)).toEqual([
      `task.merged ${PR}`,
      "status done 已合併",
      "task.cleaned_up",
    ]);
    expect(world.commands.summaries.at(-1)).toEqual({
      task: "build-1",
      kind: "landed",
      text: `已合併：${PR}`,
    });
    expect(world.commands.allWorktrees()).toEqual([]);
    expect(world.tasks()["build-1"]?.worktree).toBeUndefined();
    expect(world.tasks()["build-1"]?.state).toBe("done");
    supervisor.close();
  });

  it("puts the task under its topic in what the board program reports", async () => {
    const world = oneTask([init("w1"), result(workerOutput("report"))]);
    const supervisor = await world.start();
    supervisor.tick();
    await supervisor.idle();
    const feed = runProgram(world.home, ["feed", "main", "0", "-"]);
    expect(feed.status, feed.stderr).toBe(0);
    const report = JSON.parse(feed.stdout) as {
      tasks: { id: string; state: string }[];
      topics: Record<string, string>;
      ledger: { lines: string[] };
    };
    expect(report.tasks).toEqual([expect.objectContaining({ id: "build-1", state: "done" })]);
    expect(report.topics["build-1"]).toBe("build 2026-11-27T02:00:00Z");
    expect(
      report.ledger.lines.map((line) => (JSON.parse(line) as { event: string }).event),
    ).toEqual(["task.dispatched", "task.status", "task.status", "task.cleaned_up"]);
    supervisor.close();
  });

  it("starts the worker with the options of plan section 4.3 and the planner with 4.2's", async () => {
    const world = oneTask([init("w1"), result(workerOutput("report"))]);
    const supervisor = await world.start();
    supervisor.tick();
    await supervisor.idle();
    const [planner, worker] = world.query.calls;
    expect(planner?.options).toMatchObject({
      cwd: world.plannerDir,
      permissionMode: "default",
      permissionPrompts: "none",
      tools: ["Read", "Grep", "Glob"],
      allowedTools: [`Read(/${REPO}/**)`],
      settingSources: [],
      verbatimPrompts: true,
      persistSession: false,
    });
    expect(existsSync(world.plannerDir)).toBe(true);
    expect(readdirSync(world.plannerDir)).toEqual([]);
    expect(worker?.options).toMatchObject({
      cwd: join(world.root, "build-1"),
      permissionMode: "default",
      permissionPrompts: "none",
      settingSources: ["project"],
      projectConfigRoot: REPO,
      strictMcpConfig: true,
      maxTurns: 200,
      persistSession: true,
      allowedTools: [
        `Edit(/${join(world.root, "build-1")}/**)`,
        `Write(/${join(world.root, "build-1")}/**)`,
        "Skill(claude-agg:claude-agg-worker)",
        "mcp__forge__push_branch",
        "mcp__forge__open_pr",
      ],
      plugins: [{ type: "local", path: LOADED_PLUGIN.path, skipMcpDiscovery: true }],
      verbatimPrompts: true,
    });
    expect(worker?.options.settings).toMatchObject({
      sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false },
    });
    expect(worker?.options.disallowedTools).toEqual(
      expect.arrayContaining([
        "WebFetch",
        "WebSearch",
        `Read(/${world.settings().credentialFile})`,
      ]),
    );
    for (const call of [planner, worker]) {
      expect(call?.options).not.toHaveProperty("model");
      expect(call?.options).not.toHaveProperty("maxBudgetUsd");
      expect(call?.options.env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe(CANARY);
    }
    expect(worker?.prompts[0]).toContain('"goal": "目標 build"');
    expect(worker?.prompts[0]).toContain("呼叫 push_branch 工具推送");
    expect(worker?.prompts[0]).toContain("open_pr 工具開 PR");
    expect(worker?.prompts[0]).not.toContain("git push origin");
    expect(worker?.prompts[0]).toContain(SKILL_RULE);
    for (const call of [planner, worker]) {
      const tmpdir = call?.options.env["TMPDIR"] ?? "";
      expect(tmpdir.startsWith(join(world.root, "cagg-"))).toBe(true);
      expect(call?.options.env["CLAUDE_CODE_TMPDIR"]).toBe(tmpdir);
      expect(existsSync(tmpdir), "removed once the session ended").toBe(false);
    }
    expect(planner?.options.env["TMPDIR"]).not.toBe(worker?.options.env["TMPDIR"]);
    expect(worker?.prompts[0]).toContain('"prompt": "照目標做"');
    supervisor.close();
  });

  it("passes the user's model setting to every session unchanged", async () => {
    const world = oneTask([
      init("w1", "default", "none", "whatever-ran"),
      result(workerOutput("report")),
    ]);
    world.model = "the-user-setting";
    const supervisor = await world.start();
    supervisor.tick();
    await supervisor.idle();
    expect(world.query.calls.map((call) => call.options.model)).toEqual([
      "the-user-setting",
      "the-user-setting",
    ]);
    expect(world.tasks()["build-1"]?.model).toBe("whatever-ran");
    supervisor.close();
  });
});

describe("how a worker can end", () => {
  async function runOne(worker: object[]): Promise<World> {
    const world = oneTask(worker);
    const supervisor = await world.start();
    supervisor.tick();
    await supervisor.idle();
    supervisor.close();
    return world;
  }

  it("records failed with a summary when maxTurns runs out", async () => {
    const world = await runOne([init("w1"), maxTurns(1.5)]);
    const text = "worker 用完了 200 輪還沒做完。";
    expect(world.tasks()["build-1"]).toMatchObject({ state: "failed", cost_usd_estimate: 1.5 });
    expect(world.events("build-1")).toContain(`status failed ${text}（估計花費 1.50 美元）`);
    expect(world.commands.summaries).toEqual([{ task: "build-1", kind: "failed", text }]);
    expect(world.events("build-1").at(-1)).toBe("task.cleaned_up");
  });

  it("stops a session that does not start in default, and says why", async () => {
    const world = await runOne([init("w1", "auto"), result(workerOutput("report"))]);
    const text = "session 開始時的權限模式是 auto，不是 default，已停下。";
    expect(world.tasks()["build-1"]?.state).toBe("failed");
    expect(world.commands.summaries).toEqual([{ task: "build-1", kind: "failed", text }]);
    expect(world.query.aborted).toBe(1);
  });

  it("stops a session whose credential is an API key", async () => {
    const world = await runOne([
      init("w1", "default", "ANTHROPIC_API_KEY"),
      result(workerOutput("report")),
    ]);
    expect(world.commands.summaries[0]?.text).toBe(
      "session 的認證來源是 ANTHROPIC_API_KEY，不是設定的 none，已停下。",
    );
    expect(world.query.aborted).toBe(1);
  });

  it("stops a worker whose start does not list the plugin, and logs what was missing", async () => {
    const { plugins: _plugins, ...noPlugin } = init("w1");
    const world = await runOne([noPlugin, result(workerOutput("report"))]);
    const text = `session 開始時沒有載入 plugin claude-agg（${LOADED_PLUGIN.path}），已停下。`;
    expect(world.tasks()["build-1"]?.state).toBe("failed");
    expect(world.commands.summaries).toEqual([{ task: "build-1", kind: "failed", text }]);
    expect(world.logs).toContain(`task build-1: ${text}`);
    expect(world.query.aborted).toBe(1);
  });

  it("records failed when the output does not match the schema", async () => {
    const world = await runOne([init("w1"), result({ outcome: "ready", summary: "x" })]);
    expect(world.commands.summaries).toEqual([
      { task: "build-1", kind: "failed", text: "worker 沒有交回合格的結果。" },
    ]);
  });

  it("fails the task with an error result's text", async () => {
    const world = await runOne([init("w1"), errorResult(["boom"])]);
    expect(world.commands.summaries[0]?.text).toBe("worker 意外結束：boom");
  });

  it("records failed when the session breaks off", async () => {
    const world = oneTask([]);
    world.query.worker[0] = { messages: [init("w1")], error: new Error("the process exited 1") };
    const supervisor = await world.start();
    supervisor.tick();
    await supervisor.idle();
    expect(world.commands.summaries[0]?.text).toBe("worker 意外結束：the process exited 1");
  });

  it("keeps a worktree that holds unpushed commits and says so", async () => {
    const world = oneTask([init("w1"), result(workerOutput("failed"))]);
    world.commands.unpushed.set("agg/build-1", 2);
    const supervisor = await world.start();
    supervisor.tick();
    await supervisor.idle();
    expect(world.tasks()["build-1"]).toMatchObject({
      state: "blocked",
      detail: "worktree 還有沒推的提交",
    });
    expect(world.events("build-1").at(-1)).toBe("status blocked worktree 還有沒推的提交");
    expect(world.commands.allWorktrees()).toEqual([join(world.root, "build-1")]);
  });

  it("fails the task when its worktree cannot be made, and starts no session", async () => {
    const world = oneTask([init("w1"), result(workerOutput("report"))]);
    world.commands.failAdd = true;
    const supervisor = await world.start();
    supervisor.tick();
    await supervisor.idle();
    expect(world.tasks()["build-1"]).toMatchObject({ state: "failed" });
    expect(world.tasks()["build-1"]?.worktree).toBeUndefined();
    expect(world.commands.summaries[0]?.text).toBe("建不出 worktree：fatal: cannot add");
    expect(world.query.calls).toHaveLength(1);
  });

  it("does not drop a question or todos it cannot handle yet: the task stays blocked", async () => {
    const question = { title: "快取", text: "要換嗎？", options: ["A", "B"] };
    const world = await runOne([init("w1"), result(workerOutput("report", { question }))]);
    expect(world.tasks()["build-1"]?.state).toBe("blocked");
    expect(world.commands.allWorktrees()).toHaveLength(1);
  });

  it("closes the worktree of a PR closed without a merge, with no landed summary", async () => {
    const world = oneTask([init("w1"), result(workerOutput("ready", { pr_url: PR }))]);
    const supervisor = await world.start();
    supervisor.tick();
    await supervisor.idle();
    world.commands.prStates.set(PR, "CLOSED");
    await supervisor.pollPullRequests();
    expect(world.events("build-1").slice(-2)).toEqual([
      "status done PR 關掉了，沒有合併",
      "task.cleaned_up",
    ]);
    expect(world.commands.summaries.map((summary) => summary.kind)).toEqual(["ready"]);
    supervisor.close();
  });
});

describe("the subscription token", () => {
  it("reaches no state file, ledger line, summary, log line or other command", async () => {
    const leakyTodo = { id: `v${CANARY}`, title: CANARY, do: CANARY, cmds: [CANARY] };
    const leakyQuestion = { title: CANARY, text: CANARY, options: [CANARY, "B"] };
    const leaky = workerOutput("failed", {
      summary: `token is ${CANARY}`,
      todos: [leakyTodo],
      question: leakyQuestion,
    });
    const world = oneTask([init("w1"), result(leaky)]);
    world.query.worker.push({ messages: [init("w2")], error: new Error(`died: ${CANARY}`) });
    world.query.planner[0] = {
      messages: [
        init("p1", "default"),
        result(
          plan([
            { title: "一", repo: "app", kind: "ship", prompt: "a" },
            { title: "二", repo: "app", kind: "ship", prompt: "b" },
          ]),
        ),
      ],
    };
    const supervisor = await world.start();
    supervisor.tick();
    await supervisor.idle();
    supervisor.close();
    expect(world.commands.summaries.map((summary) => summary.text)).toEqual([
      "token is [redacted]",
      "worker 意外結束：died: [redacted]",
    ]);
    for (const text of [...world.everyFile(), ...world.logs]) expect(text).not.toContain(CANARY);
    for (const call of world.commands.calls) {
      expect(JSON.stringify(call)).not.toContain(CANARY);
    }
  });

  it("starts nothing when its plugin fails the check or lies in a place a worker supplies", async () => {
    const world = new World({ normal: ["build"] });
    const elsewhere = mkdtempSync(join(systemTmpdir(), "cagg-repo-"));
    try {
      const repos = { app: { path: elsewhere, base: "origin/main", defaultBranch: "main" } };
      const placed = [
        ["the worktree root", join(world.root, "plugin"), world.root],
        ["repo app", join(elsewhere, "plugin"), elsewhere],
      ] as const;
      for (const [what, dir, place] of placed) {
        cpSync(PLUGIN_DIR, dir, { recursive: true });
        const deps = { ...world.deps(), pluginDir: dir };
        await expect(Supervisor.start({ ...world.settings(), repos }, deps)).rejects.toThrow(
          `must lie outside ${what} (${realpathSync(place)})`,
        );
      }
      const broken = join(elsewhere, "broken");
      cpSync(PLUGIN_DIR, broken, { recursive: true });
      writeFileSync(join(broken, "hooks.json"), "{}");
      await expect(
        Supervisor.start(world.settings(), { ...world.deps(), pluginDir: broken }),
      ).rejects.toThrow(
        new PluginError("hooks.json not allowed: the plugin carries two skills only"),
      );
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
    expect(world.commands.calls).toEqual([]);
    expect(existsSync(join(world.root, LOCK_NAME))).toBe(false);
  });

  it("starts nothing without a token", async () => {
    const world = new World({ normal: ["build"] });
    const deps = { ...world.deps(), credential: { mode: "api-key" as const, secret: "" } };
    await expect(Supervisor.start(world.settings(), deps)).rejects.toThrow("no credential");
    expect(world.commands.calls).toEqual([]);
  });
});

describe("the planner", () => {
  it("skips a task whose repo is not in the settings, and plans a topic once", async () => {
    const world = new World({ normal: ["build"] });
    world.query.planner.push({
      messages: [
        init("p1", "default"),
        result(plan([{ title: "外面", repo: "elsewhere", kind: "ship", prompt: "x" }])),
      ],
    });
    const supervisor = await world.start();
    supervisor.tick();
    await supervisor.idle();
    supervisor.tick();
    await supervisor.idle();
    expect(world.queued()).toEqual([]);
    expect(world.query.calls).toHaveLength(1);
    expect(world.logs.some((line) => line.includes("repo elsewhere"))).toBe(true);
    supervisor.close();
  });

  it("stops a planner session that does not start in default", async () => {
    const world = new World({ normal: ["build"] });
    world.query.planner.push({ messages: [init("p1", "auto"), result(BUILD_PLAN)] });
    const supervisor = await world.start();
    supervisor.tick();
    await supervisor.idle();
    expect(world.queued()).toEqual([]);
    expect(world.query.aborted).toBe(1);
    supervisor.close();
  });
});

describe("start", () => {
  it("refuses a second supervisor while the first one's process is alive", async () => {
    const world = new World({ normal: ["build"] });
    const first = await world.start();
    world.alive.add(world.pid);
    await expect(world.start()).rejects.toThrow(SettingsError);
    first.close();
  });

  it("refuses a worktree root inside the board home", async () => {
    const world = new World({ normal: ["build"] });
    const settings = { ...world.settings(), worktreeRoot: join(world.home, "work") };
    await expect(Supervisor.start(settings, world.deps())).rejects.toThrow(
      "must not contain each other",
    );
  });

  it("asks the board's status and opens no second board while it runs", async () => {
    const world = new World({ normal: [] });
    const supervisor = await world.start();
    expect(world.commands.calls.map((call) => call.args)).toEqual([
      ["status"],
      ["-C", REPO, "worktree", "list", "--porcelain"],
    ]);
    expect(world.commands.calls[0]?.env).toEqual({ MYSHAPE_HOME: world.home, ...ENV });
    supervisor.close();
  });
});

describe("the forge tools", () => {
  const PUSH = { mcp: { server: "forge", tool: "push_branch", args: {} } };

  it("reports a refused push as the task's summary, whatever the worker says", async () => {
    const world = oneTask([init("w1"), PUSH, result(workerOutput("ready", { pr_url: PR }))]);
    const supervisor = await world.start();
    supervisor.tick();
    await supervisor.idle();
    const [, worker] = world.query.calls;
    const refusal = FORGE_TEXT.refused(FORGE_TEXT.remote);
    expect(worker?.mcp).toEqual([
      expect.objectContaining({
        tool: "push_branch",
        answer: expect.objectContaining({ isError: true }),
      }),
    ]);
    expect(world.commands.summaries).toEqual([{ task: "build-1", kind: "failed", text: refusal }]);
    expect(world.tasks()["build-1"]).toMatchObject({ state: "failed", pr_url: null });
    expect(world.events("build-1")).not.toContain(`task.pr_ready ${PR}`);
    supervisor.close();
  });

  it("gives a scout task no forge server at all", async () => {
    const world = new World({ normal: ["build"] });
    const scout = plan([{ title: "看看", repo: "app", kind: "scout", prompt: "只交報告" }]);
    world.query.planner.push({ messages: [init("p1", "default"), result(scout)] });
    world.query.worker.push({ messages: [init("w1"), PUSH, result(workerOutput("report"))] });
    const supervisor = await world.start();
    supervisor.tick();
    await supervisor.idle();
    const [, worker] = world.query.calls;
    expect(worker?.options).not.toHaveProperty("mcpServers");
    expect(worker?.prompts[0]).toContain("這個 task 只交報告：不推任何分支、不開 PR。");
    expect(worker?.prompts[0]).not.toContain("push_branch");
    expect(worker?.mcp).toEqual([{ ...PUSH.mcp, answer: undefined }]);
    supervisor.close();
  });
});

describe("a main checkout that sets sandbox settings", () => {
  it.each([".claude/settings.json", ".claude/settings.local.json"])(
    "starts no worker when %s sets sandbox, and says why",
    async (name) => {
      const world = oneTask([init("w1"), result(workerOutput("report"))]);
      const main = join(world.root, "..", `main-${name.replaceAll(/\W/g, "")}`);
      mkdirSync(join(main, ".claude"), { recursive: true });
      writeFileSync(join(main, name), JSON.stringify({ sandbox: { excludedCommands: ["git"] } }));
      world.repoPath = main;
      const supervisor = await world.start();
      supervisor.tick();
      await supervisor.idle();
      const text = `主 checkout 的 ${name} 設了 sandbox，worker 不啟動。`;
      expect(world.tasks()["build-1"]).toMatchObject({ state: "failed" });
      expect(world.commands.summaries).toEqual([{ task: "build-1", kind: "failed", text }]);
      expect(world.query.calls).toHaveLength(1);
      supervisor.close();
      rmSync(main, { recursive: true, force: true });
    },
  );
});

describe("withForge", () => {
  const failing: RunCommand = async () => ({ status: 1, stdout: "", stderr: "" });
  function forge(): Forge {
    return new Forge(new Git(failing, ENV), failing, ENV, {
      task: "t-1",
      branch: "agg/t-1",
      mainCheckout: "/r",
      defaultBranch: "main",
      pushRepo: "/p",
    });
  }
  const ready = endingOf({ kind: "output", output: workerOutput("ready", { pr_url: PR }) });

  it("names the PR open_pr opened over the worker's pr_url", () => {
    const tools = forge();
    tools.prUrl = "https://github.com/owner/app/pull/8";
    expect(withForge(ready, tools).prReady).toBe("https://github.com/owner/app/pull/8");
  });

  it("keeps the worker's pr_url when this session opened none (a resumed session)", () => {
    expect(withForge(ready, forge()).prReady).toBe(PR);
    expect(withForge(ready, null)).toBe(ready);
  });

  it("keeps a waiting task waiting, with the refusal as its summary", () => {
    const tools = forge();
    tools.refusal = "refused";
    const asks = endingOf({
      kind: "output",
      output: workerOutput("report", {
        question: { title: "要不要", text: "要不要？", options: ["要", "不要"] },
      }),
    });
    const ending = withForge(asks, tools);
    expect(ending.state).toBe("blocked");
    expect(ending.summary).toEqual({ kind: "failed", text: "refused" });
    expect(ending.hold).not.toBeNull();
  });
});

describe("stop", () => {
  it("aborts the running worker, leaves its task to the next start, and gives the lock back", async () => {
    const gate = new Gate();
    const world = new World({ normal: ["build"] });
    world.query.planner.push({ messages: [init("p1", "default"), result(BUILD_PLAN, 0.01)] });
    world.query.worker.push({ messages: [init("w1"), result(workerOutput("report"))], gate });
    const supervisor = await world.start();
    supervisor.tick();
    await vi.waitFor(() => {
      expect(world.query.calls).toHaveLength(2);
      expect(world.query.active.size).toBe(1);
    });
    await supervisor.stop();
    expect(world.query.aborted).toBe(1);
    expect(world.query.active.size).toBe(0);
    expect(world.tasks()["build-1"]).toMatchObject({
      state: "working",
      worktree: join(world.root, "build-1"),
    });
    expect(world.commands.summaries).toEqual([]);
    supervisor.tick();
    expect(world.query.calls).toHaveLength(2);

    const again = await world.start();
    expect(world.tasks()["build-1"]?.state).toBe("paused");
    again.close();
  });
});
