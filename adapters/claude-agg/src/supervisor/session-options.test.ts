import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { Git, type RunCommand } from "./commands.js";
import { Forge, FORGE_TEXT } from "./forge.js";

import { preToolUseHook, REASONS } from "./guard.js";
import { CANARY, denyReason, ENV, preToolUseInput } from "./harness.test-helper.js";
import {
  denyRules,
  FORGE_SERVER,
  PLANNER_OUTPUT_SCHEMA,
  plannerOptions,
  projectSandboxProblem,
  sessionEnv,
  WORKER_OUTPUT_SCHEMA,
  workerOptions,
  type SessionContext,
} from "./session-options.js";

const abort = new AbortController();
const guard = {
  home: "/srv/home",
  port: 47_829,
  defaultBranch: "main",
  realPath: (p: string) => p,
  userHome: ENV.HOME,
};
const CTX: SessionContext = {
  model: undefined,
  env: ENV,
  credential: { mode: "subscription-token", secret: CANARY },
  credentialFile: "/secrets/credential",
  readPaths: ["/opt/toolchain"],
  plugin: "/opt/claude-agg/plugin",
  tmpdir: "/tmp/cagg-test",
  platform: "linux",
  guard,
  abortController: abort,
};
/** A runner every command fails in: the forge refuses before it would push. */
const failing: RunCommand = async () => ({ status: 1, stdout: "", stderr: "no\n" });
const FORGE = new Forge(new Git(failing, ENV), failing, ENV, {
  task: "t-1",
  branch: "agg/t-1",
  mainCheckout: "/repos/app",
  defaultBranch: "main",
  pushRepo: "/work/.claude-agg-push/app.git",
});
const SESSION = {
  worktree: "/work/t-1",
  mainCheckout: "/repos/app",
  resume: undefined,
  forge: FORGE,
};

const ENV_ALL = {
  PATH: ENV.PATH,
  HOME: ENV.HOME,
  LANG: ENV.LANG,
  TMPDIR: "/tmp/cagg-test",
  CLAUDE_CODE_TMPDIR: "/tmp/cagg-test",
  CLAUDE_CODE_OAUTH_TOKEN: CANARY,
  CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
  CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
  CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "2",
};

const RULES = [
  "Bash(*myshape.sh*)",
  "Read(//srv/home/**)",
  "Edit(//srv/home/**)",
  "Bash(gh pr merge*)",
  "Bash(gh api *merge*)",
  "Bash(git push * main)",
  "Bash(git push * HEAD:main)",
  "Bash(git push * +main)",
  "Bash(git push * refs/heads/main)",
  "Bash(git push * *:main)",
  "Bash(git push --all*)",
  "Bash(git push --mirror*)",
  "Bash(*127.0.0.1:47829*)",
  "Bash(*localhost:47829*)",
  "WebFetch(domain:127.0.0.1)",
  "WebFetch(domain:localhost)",
];

const SANDBOX_SETTINGS = {
  permissions: {
    blockWritesOutsideWorkingDirectories: true,
    workingDirectoriesExclude: ["/repos/app"],
  },
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    network: {
      allowedDomains: [
        "registry.npmjs.org",
        "pypi.org",
        "files.pythonhosted.org",
        "crates.io",
        "index.crates.io",
        "static.crates.io",
      ],
      deniedDomains: ["github.com", "api.github.com"],
      strictAllowlist: true,
    },
    filesystem: {
      denyRead: [
        "~/",
        "~/.config/gh",
        "~/.ssh",
        "~/.claude/.credentials.json",
        "/secrets/credential",
        "/srv/home",
        "/home",
        "/Users",
        "/root",
        "/Volumes",
        "/mnt",
        "/media",
        "/tmp",
        "/var/tmp",
        "/dev/shm",
        "/run/user",
        "/var/log",
      ],
      allowRead: ["/work/t-1", "/repos/app/.git", "/tmp/cagg-test", "/opt/toolchain"],
      allowWrite: ["/tmp/cagg-test"],
    },
  },
};

const CREDENTIAL_RULES = [
  "Read(~/.config/gh/**)",
  "Read(~/.ssh/**)",
  "Read(~/.claude/.credentials.json/**)",
  "Read(~/.config/gh)",
  "Read(~/.ssh)",
  "Read(~/.claude/.credentials.json)",
  "Read(//secrets/credential)",
];

const WORKTREE_GIT_RULES = [
  "Edit(//work/t-1/.git)",
  "Edit(//work/t-1/.git/**)",
  "Write(//work/t-1/.git)",
  "Write(//work/t-1/.git/**)",
];

/** A forge tool, called the way Claude Code calls it: over MCP, by its name. */
async function callTool(
  options: ReturnType<typeof workerOptions>,
  name: string,
  args: Record<string, unknown>,
) {
  const server = options.mcpServers?.[FORGE_SERVER];
  if (server === undefined || !("instance" in server)) throw new Error("no forge server");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

describe("workerOptions", () => {
  it("is exactly the object of plan sections 4.3 and 5.3 and option A", () => {
    const options = workerOptions(SESSION, CTX);
    const { hooks, mcpServers, ...rest } = options;
    expect(rest).toEqual({
      cwd: "/work/t-1",
      permissionMode: "default",
      permissionPrompts: "none",
      allowedTools: [
        "Edit(//work/t-1/**)",
        "Write(//work/t-1/**)",
        "Skill(claude-agg:claude-agg-worker)",
        "mcp__forge__push_branch",
        "mcp__forge__open_pr",
      ],
      disallowedTools: [
        ...RULES,
        ...CREDENTIAL_RULES,
        ...WORKTREE_GIT_RULES,
        "WebFetch",
        "WebSearch",
      ],
      settingSources: ["project"],
      projectConfigRoot: "/repos/app",
      strictMcpConfig: true,
      plugins: [{ type: "local", path: "/opt/claude-agg/plugin", skipMcpDiscovery: true }],
      settings: SANDBOX_SETTINGS,
      sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false },
      verbatimPrompts: true,
      env: ENV_ALL,
      maxTurns: 200,
      outputFormat: { type: "json_schema", schema: WORKER_OUTPUT_SCHEMA },
      persistSession: true,
      abortController: abort,
    });
    expect(Object.keys(mcpServers ?? {})).toEqual(["forge"]);
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse[0]?.onFailure).toBe("block");
    expect(hooks.PreToolUse[0]?.hooks).toHaveLength(1);
  });

  it("gives the worker push_branch and open_pr and no tool that merges", async () => {
    const options = workerOptions(SESSION, CTX);
    const server = options.mcpServers?.[FORGE_SERVER];
    if (server === undefined || !("instance" in server)) throw new Error("no forge server");
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverSide);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(clientSide);
    const names = (await client.listTools()).tools.map((each) => each.name).toSorted();
    await client.close();
    expect(names).toEqual(["open_pr", "push_branch"]);
  });

  it("runs the forge's push_branch and open_pr when the worker calls them", async () => {
    const pushed = await callTool(workerOptions(SESSION, CTX), "push_branch", {});
    expect(pushed).toMatchObject({
      isError: true,
      content: [{ type: "text", text: FORGE_TEXT.refused(FORGE_TEXT.remote) }],
    });
    const opened = await callTool(workerOptions(SESSION, CTX), "open_pr", {
      title: "t",
      body: "b",
    });
    expect(opened).toMatchObject({
      isError: true,
      content: [{ type: "text", text: FORGE_TEXT.notPushed }],
    });
  });

  it("runs the guard as its PreToolUse hook", async () => {
    const [hook] = workerOptions(SESSION, CTX).hooks.PreToolUse[0]?.hooks ?? [];
    const input = preToolUseInput(
      "Read",
      { file_path: "/srv/home/state/myshape/token" },
      "/work/t-1",
    );
    const out = await hook?.(input, "u", { signal: abort.signal });
    expect(denyReason(out)).toBe(REASONS.home);
    expect(typeof preToolUseHook).toBe("function");
  });

  it("passes the user's model unchanged, and resumes a session with the same settings", () => {
    const resumed = workerOptions(
      { ...SESSION, resume: "sess-1" },
      { ...CTX, model: "users-choice" },
    );
    expect(resumed.model).toBe("users-choice");
    expect(resumed.resume).toBe("sess-1");
    const fresh = workerOptions(SESSION, CTX);
    for (const key of ["settingSources", "projectConfigRoot", "settings", "sandbox"] as const) {
      expect(resumed[key]).toEqual(fresh[key]);
    }
  });

  it("lets a scout push nothing, start no subagent and have no forge tools", async () => {
    const options = workerOptions({ ...SESSION, forge: null }, CTX);
    const pushes = RULES.filter((rule) => rule.startsWith("Bash(git push"));
    const rest = RULES.filter((rule) => !pushes.includes(rule));
    expect(options.disallowedTools).toEqual([
      ...rest.slice(0, 5),
      "Bash(git push*)",
      ...rest.slice(5),
      ...CREDENTIAL_RULES,
      ...WORKTREE_GIT_RULES,
      "WebFetch",
      "WebSearch",
      "Agent",
    ]);
    expect(options).not.toHaveProperty("mcpServers");
    expect(options.allowedTools).toEqual([
      "Edit(//work/t-1/**)",
      "Write(//work/t-1/**)",
      "Skill(claude-agg:claude-agg-worker)",
    ]);
    expect(options.settings).toEqual(SANDBOX_SETTINGS);
    const [hook] = options.hooks.PreToolUse[0]?.hooks ?? [];
    const input = preToolUseInput("Bash", { command: "git push origin agg/t-1" }, "/work/t-1");
    const out = await hook?.(input, "u", { signal: abort.signal });
    expect(denyReason(out)).toBe(REASONS.noPush);
    expect(workerOptions(SESSION, CTX).disallowedTools).not.toContain("Agent");
  });

  it("approves no Bash call by a rule and no MCP tool by a wildcard", () => {
    for (const forge of [FORGE, null]) {
      const allowed = workerOptions({ ...SESSION, forge }, CTX).allowedTools ?? [];
      expect(allowed.filter((rule) => rule.startsWith("Bash"))).toEqual([]);
      expect(allowed.filter((rule) => rule.includes("*") && rule.startsWith("mcp__"))).toEqual([]);
    }
    expect(SANDBOX_SETTINGS.sandbox.autoAllowBashIfSandboxed).toBe(true);
  });

  it("denies macOS's shared temporary and log directories there too", () => {
    const settings = workerOptions(SESSION, { ...CTX, platform: "darwin" }).settings;
    if (typeof settings !== "object") throw new Error("no inline settings");
    expect(settings.sandbox?.filesystem?.denyRead).toEqual([
      ...SANDBOX_SETTINGS.sandbox.filesystem.denyRead,
      "/private/tmp",
      "/private/var/folders",
      "/private/var/log",
    ]);
  });

  it("has no file-read allow rule and no settings hook, the guard callback being the only hook", () => {
    for (const forge of [FORGE, null]) {
      const options = workerOptions({ ...SESSION, forge }, CTX);
      const allowed = options.allowedTools ?? [];
      expect(allowed.filter((rule) => /^(Read|Grep|Glob)\b/.test(rule))).toEqual([]);
      expect(options.settings).not.toHaveProperty("hooks");
      expect(Object.keys(options.hooks)).toEqual(["PreToolUse"]);
      expect(options.hooks.PreToolUse.flatMap((matcher) => matcher.hooks)).toHaveLength(1);
    }
    const planner = plannerOptions("/w/p", ["/repos/app"], CTX);
    expect(planner).not.toHaveProperty("settings");
    expect(Object.keys(planner.hooks)).toEqual(["PreToolUse"]);
  });

  it("lets the worker's guard approve sandboxed Bash, and the planner's approve nothing", async () => {
    const bash = preToolUseInput("Bash", { command: "npm test" }, "/work/t-1");
    const [worker] = workerOptions(SESSION, CTX).hooks.PreToolUse[0]?.hooks ?? [];
    expect(await worker?.(bash, "u", { signal: abort.signal })).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "allow",
        permissionDecisionReason: REASONS.sandboxed,
      },
    });
    const [scout] =
      workerOptions({ ...SESSION, forge: null }, CTX).hooks.PreToolUse[0]?.hooks ?? [];
    expect(await scout?.(bash, "u", { signal: abort.signal })).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    const [planner] = plannerOptions("/w/p", ["/repos/app"], CTX).hooks.PreToolUse[0]?.hooks ?? [];
    expect(await planner?.(bash, "u", { signal: abort.signal })).toEqual({});
  });

  it("loads exactly one plugin, the supervisor's own, for scouts too, and the planner none", () => {
    for (const forge of [FORGE, null]) {
      const options = workerOptions({ ...SESSION, forge }, CTX);
      expect(options.plugins).toEqual([
        { type: "local", path: CTX.plugin, skipMcpDiscovery: true },
      ]);
      const skills = (options.allowedTools ?? []).filter((rule) => rule.startsWith("Skill"));
      expect(skills).toEqual(["Skill(claude-agg:claude-agg-worker)"]);
    }
    const planner = plannerOptions("/w/p", ["/repos/app"], CTX);
    expect(planner).not.toHaveProperty("plugins");
    expect(planner.allowedTools?.filter((rule) => rule.startsWith("Skill"))).toEqual([]);
  });

  it("names no model when the user set none", () => {
    expect(workerOptions(SESSION, CTX)).not.toHaveProperty("model");
    expect(workerOptions(SESSION, CTX)).not.toHaveProperty("resume");
  });
});

describe("plannerOptions", () => {
  it("reads the listed main checkouts only, in default with no prompts, with no push at all", () => {
    const { hooks, ...rest } = plannerOptions("/work/.claude-agg-planner", ["/repos/app", "/r/b"], {
      ...CTX,
      guard: { ...guard, defaultBranch: null },
    });
    expect(rest).toEqual({
      cwd: "/work/.claude-agg-planner",
      permissionMode: "default",
      permissionPrompts: "none",
      tools: ["Read", "Grep", "Glob"],
      allowedTools: ["Read(//repos/app/**)", "Read(//r/b/**)"],
      disallowedTools: [
        "Bash(*myshape.sh*)",
        "Read(//srv/home/**)",
        "Edit(//srv/home/**)",
        "Bash(gh pr merge*)",
        "Bash(gh api *merge*)",
        "Bash(git push*)",
        "Bash(*127.0.0.1:47829*)",
        "Bash(*localhost:47829*)",
        "WebFetch(domain:127.0.0.1)",
        "WebFetch(domain:localhost)",
        ...CREDENTIAL_RULES,
      ],
      settingSources: [],
      strictMcpConfig: true,
      verbatimPrompts: true,
      env: ENV_ALL,
      maxTurns: 20,
      outputFormat: { type: "json_schema", schema: PLANNER_OUTPUT_SCHEMA },
      persistSession: false,
      abortController: abort,
    });
    expect(hooks.PreToolUse[0]?.onFailure).toBe("block");
  });
});

describe("projectSandboxProblem", () => {
  const files = (map: Record<string, string>) => (path: string) => map[path];

  it("lets a main checkout with no sandbox setting through", () => {
    expect(projectSandboxProblem("/r", files({}))).toBeUndefined();
    expect(
      projectSandboxProblem("/r", files({ "/r/.claude/settings.json": '{"hooks":{}}' })),
    ).toBeUndefined();
  });

  it.each([".claude/settings.json", ".claude/settings.local.json"])(
    "refuses a %s that sets sandbox, or that is not JSON",
    (name) => {
      expect(projectSandboxProblem("/r", files({ [`/r/${name}`]: '{"sandbox":{}}' }))).toBe(
        `主 checkout 的 ${name} 設了 sandbox，worker 不啟動。`,
      );
      expect(projectSandboxProblem("/r", files({ [`/r/${name}`]: "{" }))).toBe(
        `主 checkout 的 ${name} 不是 JSON，worker 不啟動。`,
      );
    },
  );
});

describe("sessionEnv", () => {
  const OUTRANKING = [
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ];
  const AUTH_NAMES = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

  it.each([
    ["subscription-token", "CLAUDE_CODE_OAUTH_TOKEN"],
    ["api-key", "ANTHROPIC_API_KEY"],
  ] as const)("in %s mode holds exactly one credential, %s", (mode, name) => {
    const env = sessionEnv({ ...ENV }, { mode, secret: CANARY }, "/tmp/cagg-test");
    expect(AUTH_NAMES.filter((each) => each in env)).toEqual([name]);
    expect(env[name]).toBe(CANARY);
    for (const other of OUTRANKING) expect(env).not.toHaveProperty(other);
    expect(env["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"]).toBe("1");
  });

  it("takes nothing of the supervisor's environment but the four names", () => {
    const supervisorEnv = {
      ...ENV,
      ANTHROPIC_API_KEY: "sk-ant-supervisor-not-real",
      GH_TOKEN: "gh-not-real",
      SSH_AUTH_SOCK: "/s",
      MYSHAPE_HOME: "/srv/home",
      GIT_TERMINAL_PROMPT: "0",
    } as typeof ENV;
    const env = sessionEnv(
      supervisorEnv,
      { mode: "subscription-token", secret: CANARY },
      "/tmp/cagg-test",
    );
    expect(Object.keys(env).toSorted()).toEqual(Object.keys(ENV_ALL).toSorted());
    expect(Object.values(env)).not.toContain("sk-ant-supervisor-not-real");
  });
});

describe("denyRules", () => {
  it("uses the repository's default branch", () => {
    expect(denyRules("/h", 1, "trunk")).toContain("Bash(git push * trunk)");
  });
});
