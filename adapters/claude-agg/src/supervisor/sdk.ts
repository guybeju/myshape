// The part of the Claude Agent SDK's `query()` that the supervisor uses, as
// its own types. Every name and shape here was read from the `sdk.d.ts` of
// @anthropic-ai/claude-agent-sdk 0.3.332 (`query`, `Options`, `SDKMessage`,
// `SDKSystemMessage`, `SDKAssistantMessage`, `SDKRateLimitEvent`,
// `SDKResultMessage`, `PreToolUseHookInput`, `HookCallbackMatcher`). The
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

export interface AssistantMessage {
  type: "assistant";
  session_id: string;
  parent_tool_use_id: string | null;
  error?: string;
}

export interface RateLimitEvent {
  type: "rate_limit_event";
  session_id: string;
  rate_limit_info: { status: "allowed" | "allowed_warning" | "rejected"; resetsAt?: number };
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

export type SdkMessage = InitMessage | AssistantMessage | RateLimitEvent | ResultMessage;

export interface PreToolUseInput {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: unknown;
  cwd: string;
  session_id: string;
}

export interface PreToolUseOutput {
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

export type PreToolUseHook = (
  input: { hook_event_name: string } & Partial<PreToolUseInput>,
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
 * the supervisor parses each one into a `SdkMessage` and skips the kinds it
 * does not use.
 */
export type QueryRun = AsyncIterable<object>;

/** The shape of the SDK's `query()`. */
export type QueryFn = (params: {
  prompt: AsyncIterable<UserMessage>;
  options: QueryOptions;
}) => QueryRun;
