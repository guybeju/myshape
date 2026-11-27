import { describe, expect, it } from "vitest";

import { preToolUseHook, REASONS } from "./guard.js";
import { CANARY, denyReason, ENV, preToolUseInput } from "./harness.test-helper.js";
import {
  denyRules,
  PLANNER_OUTPUT_SCHEMA,
  plannerOptions,
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
  token: CANARY,
  guard,
  abortController: abort,
};
const SESSION = { worktree: "/work/t-1", mainCheckout: "/repos/app", resume: undefined };

const ENV_ALL = {
  PATH: ENV.PATH,
  HOME: ENV.HOME,
  LANG: ENV.LANG,
  TMPDIR: ENV.TMPDIR,
  CLAUDE_CODE_OAUTH_TOKEN: CANARY,
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

describe("workerOptions", () => {
  it("is exactly the object of plan sections 4.3 and 5.3", () => {
    const options = workerOptions(SESSION, CTX);
    const { hooks, ...rest } = options;
    expect(rest).toEqual({
      cwd: "/work/t-1",
      permissionMode: "auto",
      permissionPrompts: "none",
      disallowedTools: RULES,
      settingSources: ["project"],
      projectConfigRoot: "/repos/app",
      strictMcpConfig: true,
      env: ENV_ALL,
      maxTurns: 200,
      outputFormat: { type: "json_schema", schema: WORKER_OUTPUT_SCHEMA },
      persistSession: true,
      abortController: abort,
    });
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse[0]?.onFailure).toBe("block");
    expect(hooks.PreToolUse[0]?.hooks).toHaveLength(1);
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

  it("passes the user's model unchanged, and resumes a session", () => {
    const options = workerOptions(
      { ...SESSION, resume: "sess-1" },
      { ...CTX, model: "users-choice" },
    );
    expect(options.model).toBe("users-choice");
    expect(options.resume).toBe("sess-1");
  });

  it("lets a scout push nothing and start no subagent", async () => {
    const options = workerOptions({ ...SESSION, scout: true }, CTX);
    const pushes = RULES.filter((rule) => rule.startsWith("Bash(git push"));
    const rest = RULES.filter((rule) => !pushes.includes(rule));
    expect(options.disallowedTools).toEqual([
      ...rest.slice(0, 5),
      "Bash(git push*)",
      ...rest.slice(5),
      "Agent",
    ]);
    const [hook] = options.hooks.PreToolUse[0]?.hooks ?? [];
    const input = preToolUseInput("Bash", { command: "git push origin agg/t-1" }, "/work/t-1");
    const out = await hook?.(input, "u", { signal: abort.signal });
    expect(denyReason(out)).toBe(REASONS.noPush);
    expect(workerOptions(SESSION, CTX).disallowedTools).not.toContain("Agent");
  });

  it("names no model when the user set none", () => {
    expect(workerOptions(SESSION, CTX)).not.toHaveProperty("model");
    expect(workerOptions(SESSION, CTX)).not.toHaveProperty("resume");
  });
});

describe("plannerOptions", () => {
  it("is read-only tools in dontAsk, with no push at all", () => {
    const { hooks, ...rest } = plannerOptions("/work", {
      ...CTX,
      guard: { ...guard, defaultBranch: null },
    });
    expect(rest).toEqual({
      cwd: "/work",
      permissionMode: "dontAsk",
      tools: ["Read", "Grep", "Glob"],
      allowedTools: ["Read", "Grep", "Glob"],
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
      ],
      settingSources: [],
      strictMcpConfig: true,
      env: ENV_ALL,
      maxTurns: 20,
      outputFormat: { type: "json_schema", schema: PLANNER_OUTPUT_SCHEMA },
      persistSession: false,
      abortController: abort,
    });
    expect(hooks.PreToolUse[0]?.onFailure).toBe("block");
  });
});

describe("sessionEnv", () => {
  it("holds one credential name and no name that outranks it", () => {
    const env = sessionEnv({ ...ENV }, CANARY);
    expect(Object.keys(env).toSorted()).toEqual(Object.keys(ENV_ALL).toSorted());
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK"]) {
      expect(env).not.toHaveProperty(name);
    }
  });

  it("takes nothing but the four names from what it is given", () => {
    const loaded = { ...ENV, ANTHROPIC_API_KEY: "x", SSH_AUTH_SOCK: "/s" } as typeof ENV;
    expect(Object.keys(sessionEnv(loaded, CANARY))).not.toContain("ANTHROPIC_API_KEY");
  });
});

describe("denyRules", () => {
  it("uses the repository's default branch", () => {
    expect(denyRules("/h", 1, "trunk")).toContain("Bash(git push * trunk)");
  });
});
