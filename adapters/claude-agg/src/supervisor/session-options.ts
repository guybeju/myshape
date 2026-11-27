// The options of every `query()` the supervisor starts, built by two pure
// functions so a test and a security reader see the whole object (plan
// sections 4.2, 4.3 and 5.3).

import type { PlainEnv } from "./commands.js";
import { AUTH_VARIABLE, type Credential } from "./credential.js";
import { preToolUseHook, type GuardContext } from "./guard.js";
import type { QueryOptions } from "./sdk.js";

export const WORKER_MAX_TURNS = 200;
export const PLANNER_MAX_TURNS = 20;
export const MAX_SUBAGENT_DEPTH = "1";
export const MAX_CONCURRENT_SUBAGENTS = "2";
export const SUMMARY_MAX = 600;

/** A question for the captain, or null. */
const QUESTION_SCHEMA: Record<string, unknown> = {
  oneOf: [
    { type: "null" },
    {
      type: "object",
      additionalProperties: false,
      required: ["title", "text", "options"],
      properties: {
        title: { type: "string" },
        text: { type: "string" },
        options: { type: "array", items: { type: "string" }, minItems: 2 },
      },
    },
  ],
};

/** What a worker hands back at the end (plan section 4.5). */
export const WORKER_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "summary", "pr_url", "todos", "question"],
  properties: {
    outcome: { enum: ["ready", "report", "failed", "landed"] },
    summary: { type: "string", minLength: 1, maxLength: SUMMARY_MAX },
    pr_url: { type: ["string", "null"] },
    todos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "do", "cmds"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          do: { type: "string" },
          cmds: { type: "array", items: { type: "string" } },
        },
      },
    },
    question: QUESTION_SCHEMA,
  },
};

/** What the planner hands back for one topic (plan section 4.2). */
export const PLANNER_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["tasks", "question", "nothing"],
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "repo", "kind", "prompt"],
        properties: {
          title: { type: "string", minLength: 1, maxLength: 200 },
          repo: { type: "string" },
          kind: { enum: ["ship", "scout"] },
          prompt: { type: "string", minLength: 1 },
        },
      },
    },
    question: QUESTION_SCHEMA,
    nothing: { type: "boolean" },
  },
};

/**
 * A session's whole environment. The SDK's `env` replaces the child's
 * environment, so this is everything it gets: four plain names picked one by
 * one from `base` (nothing else of the supervisor's environment), exactly one
 * credential under its mode's name, never `ANTHROPIC_AUTH_TOKEN` or a cloud
 * provider name, and the subprocess scrub always on, so the credential is
 * taken out of every Bash command, hook and stdio MCP server the session
 * starts.
 */
export function sessionEnv(base: PlainEnv, credential: Credential): Record<string, string> {
  return {
    PATH: base.PATH,
    HOME: base.HOME,
    LANG: base.LANG,
    TMPDIR: base.TMPDIR,
    [AUTH_VARIABLE[credential.mode]]: credential.secret,
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: MAX_SUBAGENT_DEPTH,
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: MAX_CONCURRENT_SUBAGENTS,
  };
}

/**
 * The `disallowedTools` rules of plan section 5.3 for the board home `home` on
 * `port`; with no default branch (the planner), every push.
 */
export function denyRules(home: string, port: number, defaultBranch: string | null): string[] {
  const pushes =
    defaultBranch === null
      ? ["Bash(git push*)"]
      : [
          `Bash(git push * ${defaultBranch})`,
          `Bash(git push * HEAD:${defaultBranch})`,
          `Bash(git push * +${defaultBranch})`,
          `Bash(git push * refs/heads/${defaultBranch})`,
          `Bash(git push * *:${defaultBranch})`,
          "Bash(git push --all*)",
          "Bash(git push --mirror*)",
        ];
  return [
    "Bash(*myshape.sh*)",
    `Read(/${home}/**)`,
    `Edit(/${home}/**)`,
    "Bash(gh pr merge*)",
    "Bash(gh api *merge*)",
    ...pushes,
    `Bash(*127.0.0.1:${port}*)`,
    `Bash(*localhost:${port}*)`,
    "WebFetch(domain:127.0.0.1)",
    "WebFetch(domain:localhost)",
  ];
}

export interface WorkerSession {
  /** The worker's git worktree, outside the board home. */
  worktree: string;
  /** The target repository's main checkout: project settings and `.claude/` come from here. */
  mainCheckout: string;
  /** The session to resume, or undefined for a new one. */
  resume: string | undefined;
  /**
   * A scout task only reports: it may push nothing and start no subagent
   * (plan section 4.3).
   */
  scout?: boolean;
}

export interface SessionContext {
  /**
   * The model setting of whoever runs the supervisor, passed on unchanged;
   * undefined passes no model, so the SDK's own default applies.
   */
  model: string | undefined;
  env: PlainEnv;
  credential: Credential;
  guard: GuardContext;
  abortController: AbortController;
}

/** The options of one worker's `query()` (plan sections 4.3 and 5.3). */
export function workerOptions(session: WorkerSession, ctx: SessionContext): QueryOptions {
  const guard = session.scout === true ? { ...ctx.guard, defaultBranch: null } : ctx.guard;
  const deny = denyRules(guard.home, guard.port, guard.defaultBranch);
  const options: QueryOptions = {
    cwd: session.worktree,
    permissionMode: "auto",
    permissionPrompts: "none",
    disallowedTools: session.scout === true ? [...deny, "Agent"] : deny,
    hooks: { PreToolUse: [{ hooks: [preToolUseHook(guard)], onFailure: "block" }] },
    settingSources: ["project"],
    projectConfigRoot: session.mainCheckout,
    strictMcpConfig: true,
    env: sessionEnv(ctx.env, ctx.credential),
    maxTurns: WORKER_MAX_TURNS,
    outputFormat: { type: "json_schema", schema: WORKER_OUTPUT_SCHEMA },
    persistSession: true,
    abortController: ctx.abortController,
  };
  if (ctx.model !== undefined) options.model = ctx.model;
  if (session.resume !== undefined) options.resume = session.resume;
  return options;
}

/** The options of the planner's `query()` for one topic (plan section 4.2). */
export function plannerOptions(cwd: string, ctx: SessionContext): QueryOptions {
  const options: QueryOptions = {
    cwd,
    permissionMode: "dontAsk",
    tools: ["Read", "Grep", "Glob"],
    allowedTools: ["Read", "Grep", "Glob"],
    disallowedTools: denyRules(ctx.guard.home, ctx.guard.port, ctx.guard.defaultBranch),
    hooks: { PreToolUse: [{ hooks: [preToolUseHook(ctx.guard)], onFailure: "block" }] },
    settingSources: [],
    strictMcpConfig: true,
    env: sessionEnv(ctx.env, ctx.credential),
    maxTurns: PLANNER_MAX_TURNS,
    outputFormat: { type: "json_schema", schema: PLANNER_OUTPUT_SCHEMA },
    persistSession: false,
    abortController: ctx.abortController,
  };
  if (ctx.model !== undefined) options.model = ctx.model;
  return options;
}
