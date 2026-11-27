// The part of the Claude Agent SDK's `query()` that the supervisor uses, in
// the SDK's own types (@anthropic-ai/claude-agent-sdk, pinned in
// package.json). The options the supervisor builds are the SDK's `Options`
// with the fields it always sets made required, so a misspelt or missing
// option is a type error. The session's messages are read field by field in
// session.ts: they are outside data.

import type {
  HookCallbackMatcher,
  OutputFormat,
  Options,
  PermissionMode,
  SDKUserMessage,
  SettingSource,
  SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";

export type { PermissionMode };

/** A user turn sent on the streaming input. */
export type UserMessage = SDKUserMessage;

/** What the PreToolUse callback returns. */
export type PreToolUseOutput = SyncHookJSONOutput;

/** The first message of a session: its permission mode and where its credential came from. */
export interface InitMessage {
  type: "system";
  subtype: "init";
  session_id: string;
  permissionMode: PermissionMode;
  /**
   * The SDK's `apiKeySource`: `ANTHROPIC_API_KEY` for an API key from the
   * environment, `none` for no API key (a claude.ai OAuth token).
   */
  apiKeySource: string;
  model?: string;
}

/** The result fields the supervisor reads, as the SDK's `SDKResultMessage` names them. */
export interface ResultMessage {
  type: "result";
  subtype:
    | "success"
    | "error_during_execution"
    | "error_max_turns"
    | "error_max_budget_usd"
    | "error_max_structured_output_retries";
  is_error: boolean;
  /** The SDK's running estimate for this query() call; not a bill. */
  total_cost_usd: number;
  structured_output?: unknown;
  api_error_status?: number | null;
  errors?: string[];
}

/** The options the supervisor passes: the SDK's `Options`, with what it always sets required. */
export type QueryOptions = Options & {
  cwd: string;
  permissionMode: PermissionMode;
  disallowedTools: string[];
  hooks: { PreToolUse: HookCallbackMatcher[] };
  settingSources: SettingSource[];
  strictMcpConfig: true;
  env: Record<string, string>;
  maxTurns: number;
  outputFormat: OutputFormat;
  persistSession: boolean;
  abortController: AbortController;
};

/**
 * A running query: the session's messages, in order. They are outside data:
 * the supervisor reads the start message, assistant errors, rate-limit
 * events and the result from them, and skips every other kind.
 */
export type QueryRun = AsyncIterable<object>;

/** The shape of the SDK's `query()` as the supervisor calls it; the SDK's own `query` is one. */
export type QueryFn = (params: {
  prompt: AsyncIterable<UserMessage>;
  options: QueryOptions;
}) => QueryRun;
