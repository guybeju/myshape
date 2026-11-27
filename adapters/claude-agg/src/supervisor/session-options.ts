// The options of every `query()` the supervisor starts, built by two
// functions so a test and a security reader see the whole object (plan
// sections 4.2, 4.3 and 5.3, and option A of the credential report): the
// worker's Bash runs in the SDK's sandbox with no route to GitHub and no read
// of the captain's credentials, its file tools stay in its worktree, and it
// reaches the forge only through the supervisor's two tools. Every session
// starts in `default` (SESSION_MODE) with no approval surface: only what is
// listed runs without a prompt, and everything else is denied. Every prompt
// carries board text (topic names and goals, messages, answers), so every
// session takes its prompts as written (`verbatimPrompts`): no `@path` file
// mention in them is expanded and no slash command runs.

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type Settings,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { PlainEnv } from "./commands.js";
import { AUTH_VARIABLE, CREDENTIAL_PATHS, type Credential } from "./credential.js";
import type { Forge, ToolAnswer } from "./forge.js";
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
 * environment, so this is everything it gets: three plain names picked one by
 * one from `base` (nothing else of the supervisor's environment), the
 * session's own temporary directory as TMPDIR and CLAUDE_CODE_TMPDIR (where
 * Claude Code keeps its temporary files and points sandboxed commands), exactly one
 * credential under its mode's name, never `ANTHROPIC_AUTH_TOKEN` or a cloud
 * provider name, and the subprocess scrub always on, so the credential is
 * taken out of every Bash command, hook and stdio MCP server the session
 * starts.
 */
export function sessionEnv(
  base: PlainEnv,
  credential: Credential,
  tmpdir: string,
): Record<string, string> {
  return {
    PATH: base.PATH,
    HOME: base.HOME,
    LANG: base.LANG,
    TMPDIR: tmpdir,
    CLAUDE_CODE_TMPDIR: tmpdir,
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

/**
 * The hosts a worker's sandboxed commands may reach: the npm, Python and Rust
 * package registries, so a worker can install a project's dependencies, and
 * nothing else (network.strictAllowlist).
 */
export const PACKAGE_REGISTRIES = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "index.crates.io",
  "static.crates.io",
];

/** Hosts a worker's commands never reach, whatever else allows them. */
export const DENIED_DOMAINS = ["github.com", "api.github.com"];

/**
 * Directories a worker's sandboxed commands never read (narrower allowRead
 * entries still open the worktree, its main checkout's .git, its own
 * temporary directory and readPaths): other users' and mounted files, and
 * the shared temporary and log directories other programs write to.
 */
export const DENIED_ROOTS = [
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
];

/** The same on macOS, where /tmp is /private/tmp and each user's TMPDIR is under /private/var/folders. */
export const DENIED_ROOTS_MACOS = ["/private/tmp", "/private/var/folders", "/private/var/log"];

/**
 * Where each session's temporary directory is made. It is short on purpose:
 * Claude Code hands sandboxed commands its own temporary directory
 * (`<CLAUDE_CODE_TMPDIR>/claude-<uid>`) only while that path is at most 44
 * bytes, and otherwise a shared one under the system default.
 */
export const SESSION_TMP_ROOT = "/tmp";

/** The forge server's name in `mcpServers`, and the two tool names it gives the worker. */
export const FORGE_SERVER = "forge";
export const FORGE_TOOLS = [
  `mcp__${FORGE_SERVER}__push_branch`,
  `mcp__${FORGE_SERVER}__open_pr`,
] as const;

export interface WorkerSession {
  /** The worker's git worktree, outside the board home. */
  worktree: string;
  /** The target repository's main checkout: project settings and `.claude/` come from here. */
  mainCheckout: string;
  /** The session to resume, or undefined for a new one. */
  resume: string | undefined;
  /**
   * The session's forge tools; null for a scout task, which only reports: it
   * may push nothing and start no subagent (plan section 4.3).
   */
  forge: Forge | null;
}

export interface SessionContext {
  /**
   * The model setting of whoever runs the supervisor, passed on unchanged;
   * undefined passes no model, so the SDK's own default applies.
   */
  model: string | undefined;
  env: PlainEnv;
  credential: Credential;
  /** The file the credential was read from, absolute: no session reads it. */
  credentialFile: string;
  /** Absolute paths a worker's sandboxed commands may read besides its worktree. */
  readPaths: readonly string[];
  /**
   * The session's own temporary directory, made for it alone: absolute, links
   * resolved, short (see SESSION_TMP_ROOT).
   */
  tmpdir: string;
  /** The platform the sessions run on, which decides the system paths denied to them. */
  platform: NodeJS.Platform;
  /** The guard's context; each kind of session decides whether the guard approves Bash. */
  guard: Omit<GuardContext, "approvesSandboxedBash">;
  abortController: AbortController;
}

/** Read deny rules for the captain's credentials, as permission rules (`//` is absolute). */
export function credentialReadRules(credentialFile: string): string[] {
  return [
    ...CREDENTIAL_PATHS.map((path) => `Read(${path}/**)`),
    ...CREDENTIAL_PATHS.map((path) => `Read(${path})`),
    `Read(/${credentialFile})`,
  ];
}

/**
 * The flag-settings layer of a worker session: the sandbox around its shell
 * commands, and its file tools kept to its working directory. The main
 * checkout is also listed in workingDirectoriesExclude; the SDK documents
 * that a listed path that is itself a working directory is still let
 * through, so whether `projectConfigRoot` makes it one is what real-binary
 * check 7 settles. Its .git stays readable for the worktree's git.
 */
export function workerSettings(session: WorkerSession, ctx: SessionContext): Settings {
  return {
    permissions: {
      blockWritesOutsideWorkingDirectories: true,
      workingDirectoriesExclude: [session.mainCheckout],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      network: {
        allowedDomains: [...PACKAGE_REGISTRIES],
        deniedDomains: [...DENIED_DOMAINS],
        strictAllowlist: true,
      },
      filesystem: {
        denyRead: [
          "~/",
          ...CREDENTIAL_PATHS,
          ctx.credentialFile,
          ctx.guard.home,
          ...DENIED_ROOTS,
          ...(ctx.platform === "darwin" ? DENIED_ROOTS_MACOS : []),
        ],
        allowRead: [session.worktree, `${session.mainCheckout}/.git`, ctx.tmpdir, ...ctx.readPaths],
        allowWrite: [ctx.tmpdir],
      },
    },
  } satisfies Settings;
}

function answer({ ok, text }: ToolAnswer) {
  return { content: [{ type: "text" as const, text }], isError: !ok };
}

/** The in-process MCP server that gives a worker push_branch and open_pr, and nothing that merges. */
export function forgeServer(forge: Forge): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: FORGE_SERVER,
    version: "1",
    tools: [
      tool(
        "push_branch",
        `Push this task's branch ${forge.target.branch} to GitHub. The supervisor refuses a branch that changes anything under .github/. Takes no input.`,
        {},
        async () => answer(await forge.pushBranch()),
      ),
      tool(
        "open_pr",
        `Open a pull request from ${forge.target.branch} into ${forge.target.defaultBranch}, after push_branch went through.`,
        { title: z.string().min(1).max(256), body: z.string().max(60_000) },
        async ({ title, body }) => answer(await forge.openPr(title, body)),
      ),
    ],
  });
}

/**
 * The permission mode every session starts in. With
 * CLAUDE_CODE_SUBPROCESS_ENV_SCRUB set (always, sessionEnv), Claude Code
 * forces this mode whatever is asked ("Permission mode forced to default —
 * CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is set"), so no session asks for another:
 * what runs without a prompt is listed explicitly, and with no approval
 * surface everything else is denied.
 */
export const SESSION_MODE = "default";

/**
 * What a worker may do without a prompt: file edits and writes inside its
 * worktree, and, for a ship worker, the two forge tools by their full names.
 * Bash has no allow rule: a sandboxed command runs through the sandbox's
 * autoAllowBashIfSandboxed, so an unsandboxed one is never approved.
 */
export function workerAllowRules(worktree: string, ship: boolean): string[] {
  const files = [`Edit(/${worktree}/**)`, `Write(/${worktree}/**)`];
  return ship ? [...files, ...FORGE_TOOLS] : files;
}

/** The worktree's .git file: the file tools never change it, though it lies in the worktree. */
export function worktreeGitRules(worktree: string): string[] {
  const git = `/${worktree}/.git`;
  return [`Edit(${git})`, `Edit(${git}/**)`, `Write(${git})`, `Write(${git}/**)`];
}

/** The project settings files of a main checkout that could hold sandbox settings. */
const PROJECT_SETTINGS = [".claude/settings.json", ".claude/settings.local.json"];

/**
 * Why a worker may not start in this main checkout, or undefined: one of its
 * project settings files sets anything under `sandbox` (such as
 * excludedCommands, which would run commands outside the sandbox the guard
 * approves Bash for), or cannot be read as JSON. A missing file is fine.
 */
export function projectSandboxProblem(
  mainCheckout: string,
  read: (path: string) => string | undefined,
): string | undefined {
  for (const name of PROJECT_SETTINGS) {
    const text = read(`${mainCheckout}/${name}`);
    if (text === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return `主 checkout 的 ${name} 不是 JSON，worker 不啟動。`;
    }
    if (typeof parsed === "object" && parsed !== null && "sandbox" in parsed) {
      return `主 checkout 的 ${name} 設了 sandbox，worker 不啟動。`;
    }
  }
  return undefined;
}

/** The options of one worker's `query()` (plan sections 4.3 and 5.3). */
export function workerOptions(session: WorkerSession, ctx: SessionContext): QueryOptions {
  const scout = session.forge === null;
  const guard: GuardContext = {
    ...ctx.guard,
    ...(scout ? { defaultBranch: null } : {}),
    approvesSandboxedBash: true,
  };
  const deny = [
    ...denyRules(guard.home, guard.port, guard.defaultBranch),
    ...credentialReadRules(ctx.credentialFile),
    ...worktreeGitRules(session.worktree),
    "WebFetch",
    "WebSearch",
  ];
  const options = {
    cwd: session.worktree,
    permissionMode: SESSION_MODE,
    permissionPrompts: "none",
    allowedTools: workerAllowRules(session.worktree, !scout),
    disallowedTools: scout ? [...deny, "Agent"] : deny,
    hooks: { PreToolUse: [{ hooks: [preToolUseHook(guard)], onFailure: "block" }] },
    settingSources: ["project"],
    projectConfigRoot: session.mainCheckout,
    strictMcpConfig: true,
    settings: workerSettings(session, ctx),
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false },
    verbatimPrompts: true,
    env: sessionEnv(ctx.env, ctx.credential, ctx.tmpdir),
    maxTurns: WORKER_MAX_TURNS,
    outputFormat: { type: "json_schema", schema: WORKER_OUTPUT_SCHEMA },
    persistSession: true,
    abortController: ctx.abortController,
  } satisfies QueryOptions;
  return {
    ...options,
    ...(session.forge === null
      ? {}
      : { mcpServers: { [FORGE_SERVER]: forgeServer(session.forge) } }),
    ...(ctx.model === undefined ? {} : { model: ctx.model }),
    ...(session.resume === undefined ? {} : { resume: session.resume }),
  };
}

/**
 * The options of the planner's `query()` for one topic (plan section 4.2): it
 * reads the listed repositories' main checkouts and nothing else. Its working
 * directory is an empty one of its own, since reads there need no rule; a
 * Read rule also governs Grep and Glob, so one `Read(//<repo>/**)` allow rule
 * per repository is what it may read, search and list.
 */
export function plannerOptions(
  cwd: string,
  repos: readonly string[],
  ctx: SessionContext,
): QueryOptions {
  const options: QueryOptions = {
    cwd,
    permissionMode: SESSION_MODE,
    permissionPrompts: "none",
    tools: ["Read", "Grep", "Glob"],
    allowedTools: repos.map((repo) => `Read(/${repo}/**)`),
    disallowedTools: [
      ...denyRules(ctx.guard.home, ctx.guard.port, ctx.guard.defaultBranch),
      ...credentialReadRules(ctx.credentialFile),
    ],
    hooks: {
      PreToolUse: [
        {
          hooks: [preToolUseHook({ ...ctx.guard, approvesSandboxedBash: false })],
          onFailure: "block",
        },
      ],
    },
    settingSources: [],
    strictMcpConfig: true,
    verbatimPrompts: true,
    env: sessionEnv(ctx.env, ctx.credential, ctx.tmpdir),
    maxTurns: PLANNER_MAX_TURNS,
    outputFormat: { type: "json_schema", schema: PLANNER_OUTPUT_SCHEMA },
    persistSession: false,
    abortController: ctx.abortController,
  };
  if (ctx.model !== undefined) options.model = ctx.model;
  return options;
}
