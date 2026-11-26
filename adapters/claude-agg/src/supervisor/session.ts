// Following one `query()` session to its end: the streaming prompt, the
// start-message checks (permission mode, credential source), the quota and
// rate-limit signals, and what the session's result means.

import type { InitMessage, QueryRun, ResultMessage, UserMessage } from "./sdk.js";

/** The streaming input: one prompt now, closed when the session has answered. */
export class PromptStream implements AsyncIterable<UserMessage> {
  private readonly pending: UserMessage[] = [];
  private wake: (() => void) | undefined;
  private closed = false;

  constructor(first: string) {
    this.pending.push(userMessage(first));
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<UserMessage> {
    for (;;) {
      const next = this.pending.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = undefined;
    }
  }
}

export function userMessage(content: string): UserMessage {
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
}

/** How a session ended. */
export type SessionEnd =
  | { kind: "output"; output: unknown }
  | { kind: "refused"; reason: string }
  | { kind: "max_turns" }
  | { kind: "quota"; resetsAtMs: number | null }
  | { kind: "error"; message: string };

export interface SessionReport {
  end: SessionEnd;
  sessionId: string | undefined;
  model: string | undefined;
  /** The latest result's estimate in US dollars, or 0 when no result came. */
  costUsd: number;
}

export interface Expectation {
  /** The permission mode the session must start in. */
  mode: InitMessage["permissionMode"];
  /** Called once with the start message, after it passed the checks. */
  onStart: (init: InitMessage) => void;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInit(message: Json): InitMessage | undefined {
  if (message["type"] !== "system" || message["subtype"] !== "init") return undefined;
  const { session_id: id, permissionMode, apiKeySource, model } = message;
  if (typeof id !== "string" || typeof permissionMode !== "string") return undefined;
  const init: InitMessage = {
    type: "system",
    subtype: "init",
    session_id: id,
    permissionMode: permissionMode as InitMessage["permissionMode"],
    apiKeySource: typeof apiKeySource === "string" ? apiKeySource : "",
  };
  if (typeof model === "string") init.model = model;
  return init;
}

/** Why a start message is refused, or undefined when it may go on. */
export function refuseStart(init: InitMessage, mode: InitMessage["permissionMode"]) {
  if (init.permissionMode !== mode) {
    return `session 開始時的權限模式是 ${init.permissionMode}，不是 ${mode}，已停下。`;
  }
  if (init.apiKeySource !== "none") {
    return `session 的認證來源是 ${init.apiKeySource || "（沒寫）"}，不是訂閱 token，已停下。`;
  }
  return undefined;
}

/** Errors in an assistant message that mean the subscription's quota or rate limit stopped it. */
const QUOTA_ERRORS = new Set(["rate_limit", "billing_error"]);

/**
 * When this message says the quota or rate limit stopped the session, the time
 * it clears in epoch milliseconds (null when the message does not say);
 * undefined for any other message. A warning (`allowed_warning`), `overloaded`
 * and a retry do not stop it.
 */
export function quotaSignal(message: Json): number | null | undefined {
  if (message["type"] === "rate_limit_event") {
    const info = message["rate_limit_info"];
    if (!isRecord(info) || info["status"] !== "rejected") return undefined;
    const resets = info["resetsAt"];
    if (typeof resets !== "number" || !Number.isFinite(resets)) return null;
    return resets < 1e12 ? resets * 1000 : resets;
  }
  if (message["type"] === "assistant" && QUOTA_ERRORS.has(String(message["error"]))) return null;
  if (message["type"] === "result" && message["api_error_status"] === 429) return null;
  return undefined;
}

function parseResult(message: Json): ResultMessage | undefined {
  if (message["type"] !== "result" || typeof message["subtype"] !== "string") return undefined;
  return message as unknown as ResultMessage;
}

/** What a result means, given whether a quota signal came before or with it. */
export function endOf(result: ResultMessage, quota: number | null | undefined): SessionEnd {
  const succeeded = result.subtype === "success" && !result.is_error;
  if (succeeded && result.structured_output !== undefined) {
    return { kind: "output", output: result.structured_output };
  }
  if (result.subtype === "error_max_turns") return { kind: "max_turns" };
  if (quota !== undefined) return { kind: "quota", resetsAtMs: quota };
  const errors = Array.isArray(result.errors) ? result.errors.join("; ") : "";
  return { kind: "error", message: errors === "" ? `結果是 ${result.subtype}` : errors };
}

class Follower {
  readonly report: SessionReport = {
    end: { kind: "error", message: "session 沒有交回結果就結束了。" },
    sessionId: undefined,
    model: undefined,
    costUsd: 0,
  };
  done = false;
  private started = false;
  private quota: number | null | undefined;

  constructor(private readonly expect: Expectation) {}

  /** Takes one message; true when the session is over. */
  take(raw: object): boolean {
    if (!isRecord(raw)) return false;
    this.noteQuota(quotaSignal(raw));
    const init = parseInit(raw);
    if (init !== undefined && !this.started) return this.start(init);
    const result = parseResult(raw);
    if (result === undefined) return false;
    if (!this.started)
      return this.finish({ kind: "error", message: "session 沒有送出開頭的系統訊息。" });
    if (Number.isFinite(result.total_cost_usd)) this.report.costUsd = result.total_cost_usd;
    return this.finish(endOf(result, this.quota));
  }

  /** Keeps the first quota signal, or a later one that says when the limit clears. */
  private noteQuota(signal: number | null | undefined): void {
    if (signal !== undefined && typeof this.quota !== "number") this.quota = signal;
  }

  private start(init: InitMessage): boolean {
    this.started = true;
    this.report.sessionId = init.session_id;
    this.report.model = init.model;
    const reason = refuseStart(init, this.expect.mode);
    if (reason !== undefined) return this.finish({ kind: "refused", reason });
    this.expect.onStart(init);
    return false;
  }

  finish(end: SessionEnd): boolean {
    this.report.end = end;
    this.done = true;
    return true;
  }
}

/**
 * Follows `run` until its first result, or until its start message is
 * refused; then closes `prompt` and, on a refusal, aborts the session.
 */
export async function followSession(
  run: QueryRun,
  prompt: PromptStream,
  abort: AbortController,
  expect: Expectation,
): Promise<SessionReport> {
  const follower = new Follower(expect);
  try {
    for await (const message of run) {
      if (follower.take(message)) break;
    }
  } catch (error) {
    if (!follower.done) follower.finish({ kind: "error", message: (error as Error).message });
  } finally {
    prompt.close();
    if (follower.report.end.kind === "refused") abort.abort();
  }
  return follower.report;
}
