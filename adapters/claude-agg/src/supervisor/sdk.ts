// The part of the Claude Agent SDK's `query()` that the supervisor uses, as
// its own types. Every name and shape here was read from the `sdk.d.ts` of
// @anthropic-ai/claude-agent-sdk 0.3.332 (`query`, `Options`, `SDKMessage`,
// `SDKSystemMessage`, `SDKResultMessage`, `HookCallbackMatcher`; the fields
// of `SDKAssistantMessage`, `SDKRateLimitEvent` and `PreToolUseHookInput`
// that are read are named where they are read). The
// package itself is not a dependency yet: nothing here calls a model, and the
// tests pass a double with this shape.

/** A user turn sent on the streaming input. */
export interface UserMessage {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
}

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

/** The first message of a session: its permission mode and where its credential came from. */
export interface InitMessage {
  type: "system";
  subtype: "init";
  session_id: string;
  permissionMode: PermissionMode;
  /** `none` means no API key: a claude.ai OAuth token, a stored login or a bearer token. */
  apiKeySource: string;
  model?: string;
  cwd?: string;
}

export interface ResultMessage {
  type: "result";
  subtype:
    | "success"
    | "error_during_execution"
    | "error_max_turns"
    | "error_max_budget_usd"
    | "error_max_structured_output_retries";
  session_id: string;
  is_error: boolean;
  num_turns: number;
  /** The SDK's running estimate for this query() call; not a bill. */
  total_cost_usd: number;
  structured_output?: unknown;
  api_error_status?: number | null;
  errors?: string[];
}

export interface PreToolUseOutput {
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

/** What a hook is called with: outside data, read field by field. */
export type HookInput = { hook_event_name: string } & Record<string, unknown>;

export type PreToolUseHook = (
  input: HookInput,
  toolUseId: string | undefined,
  options: { signal: AbortSignal },
) => Promise<PreToolUseOutput>;

export interface HookMatcher {
  hooks: PreToolUseHook[];
  /** `block`: a hook that throws stops the tool call instead of letting it go ahead. */
  onFailure: "block";
}

export interface JsonSchemaFormat {
  type: "json_schema";
  schema: Record<string, unknown>;
}

/** The options the supervisor passes; a subset of the SDK's `Options`, with the same names. */
export interface QueryOptions {
  cwd: string;
  model?: string;
  permissionMode: PermissionMode;
  permissionPrompts?: "none";
  tools?: string[];
  allowedTools?: string[];
  disallowedTools: string[];
  hooks: { PreToolUse: HookMatcher[] };
  settingSources: ("user" | "project" | "local")[];
  projectConfigRoot?: string;
  strictMcpConfig: true;
  env: Record<string, string>;
  maxTurns: number;
  outputFormat: JsonSchemaFormat;
  persistSession: boolean;
  resume?: string;
  abortController: AbortController;
}

/**
 * A running query: the session's messages, in order. They are outside data:
 * the supervisor reads the start message, assistant errors, rate-limit
 * events and the result from them, and skips every other kind.
 */
export type QueryRun = AsyncIterable<object>;

/** The shape of the SDK's `query()`. */
export type QueryFn = (params: {
  prompt: AsyncIterable<UserMessage>;
  options: QueryOptions;
}) => QueryRun;
