import { describe, expect, it } from "vitest";

import { endingOf, TEXT } from "./ending.js";
import {
  errorResult,
  init,
  maxTurns,
  promptText,
  rejected,
  result,
  workerOutput,
} from "./harness.test-helper.js";
import type { InitMessage, QueryRun } from "./sdk.js";
import { endOf, followSession, PromptStream, quotaSignal, refuseStart } from "./session.js";

async function* messages(list: object[], error?: Error): QueryRun {
  for (const message of list) yield message;
  if (error !== undefined) throw error;
}

async function follow(list: object[], mode: InitMessage["permissionMode"] = "auto", error?: Error) {
  const abort = new AbortController();
  const starts: InitMessage[] = [];
  const prompt = new PromptStream("go");
  const report = await followSession(messages(list, error), prompt, abort, {
    mode,
    apiKeySource: "none",
    onStart: (start) => starts.push(start),
  });
  return { report, aborted: abort.signal.aborted, starts };
}

describe("followSession", () => {
  it("returns the structured output, session, model and cost", async () => {
    const { report, starts, aborted } = await follow([
      init("s1"),
      { type: "assistant", session_id: "s1", parent_tool_use_id: null },
      result({ ok: 1 }, 0.3),
      result({ later: 1 }, 9),
    ]);
    expect(report).toEqual({
      end: { kind: "output", output: { ok: 1 } },
      sessionId: "s1",
      model: "test-model",
      costUsd: 0.3,
    });
    expect(starts.map((start) => start.session_id)).toEqual(["s1"]);
    expect(aborted).toBe(false);
  });

  it("refuses and aborts a session in another mode, before onStart", async () => {
    const { report, starts, aborted } = await follow([init("s1", "default"), result({})]);
    expect(report.end).toEqual({
      kind: "refused",
      reason: "session 開始時的權限模式是 default，不是 auto，已停下。",
    });
    expect(starts).toEqual([]);
    expect(aborted).toBe(true);
  });

  it("refuses an API key as the credential", async () => {
    const { report } = await follow([init("s1", "auto", "apiKeyHelper")]);
    expect(report.end).toEqual({
      kind: "refused",
      reason: "session 的認證來源是 apiKeyHelper，不是設定的 none，已停下。",
    });
  });

  it("checks the planner's mode as dontAsk", async () => {
    expect((await follow([init("p", "dontAsk"), result({})], "dontAsk")).report.end.kind).toBe(
      "output",
    );
    expect((await follow([init("p", "auto")], "dontAsk")).report.end.kind).toBe("refused");
  });

  it("ends on maxTurns", async () => {
    const { report } = await follow([init("s1"), maxTurns(2)]);
    expect(report.end).toEqual({ kind: "max_turns" });
    expect(report.costUsd).toBe(2);
  });

  it("ends on the quota with the time it clears", async () => {
    const { report } = await follow([
      init("s1"),
      rejected(1_800_000_000),
      errorResult(["limit"], 429),
    ]);
    expect(report.end).toEqual({ kind: "quota", resetsAtMs: 1_800_000_000_000 });
  });

  it("turns a session that breaks off or never starts into an error", async () => {
    expect((await follow([init("s1")], "auto", new Error("exit 1"))).report.end).toEqual({
      kind: "error",
      message: "exit 1",
    });
    expect((await follow([result({})])).report.end).toEqual({
      kind: "error",
      message: "session 沒有送出開頭的系統訊息。",
    });
    expect((await follow([init("s1")])).report.end).toEqual({
      kind: "error",
      message: "session 沒有交回結果就結束了。",
    });
  });

  it("skips messages it does not use", async () => {
    const { report } = await follow([
      init("s1"),
      { type: "system", subtype: "status" },
      "x" as unknown as object,
      result(1),
    ]);
    expect(report.end).toEqual({ kind: "output", output: 1 });
  });
});

describe("quotaSignal", () => {
  it.each([
    [rejected(1_800_000_000), 1_800_000_000_000],
    [rejected(1_800_000_000_000), 1_800_000_000_000],
    [rejected(), null],
    [{ type: "assistant", error: "rate_limit" }, null],
    [{ type: "assistant", error: "billing_error" }, null],
    [errorResult(["x"], 429), null],
  ])("reads %j as a stop", (message, expected) => {
    expect(quotaSignal(message as Record<string, unknown>)).toBe(expected);
  });

  it.each([
    [{ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } }],
    [{ type: "assistant", error: "overloaded" }],
    [{ type: "system", subtype: "api_retry", error: "rate_limit" }],
    [errorResult(["x"], 500)],
    [{ type: "rate_limit_event", rate_limit_info: "bad" }],
  ])("does not stop for %j", (message) => {
    expect(quotaSignal(message as Record<string, unknown>)).toBeUndefined();
  });
});

describe("endOf", () => {
  it("prefers output that came, then maxTurns, then the quota", () => {
    const success = result({ ok: 1 }) as unknown as Parameters<typeof endOf>[0];
    expect(endOf(success, null).kind).toBe("output");
    expect(endOf(maxTurns() as unknown as Parameters<typeof endOf>[0], null).kind).toBe(
      "max_turns",
    );
    expect(endOf(errorResult([]) as unknown as Parameters<typeof endOf>[0], undefined)).toEqual({
      kind: "error",
      message: "結果是 error_during_execution",
    });
  });
});

describe("a session that hands back no output in the schema", () => {
  it.each([
    [{ ...errorResult([]), subtype: "error_max_structured_output_retries" }],
    [{ ...result(undefined), structured_output: undefined }],
  ])("ends as an output no parser takes: %j", async (last) => {
    const { report } = await follow([init("s1"), last]);
    expect(report.end).toEqual({ kind: "output", output: undefined });
    expect(endingOf(report.end).summary).toEqual({ kind: "failed", text: TEXT.invalid });
  });
});

describe("refuseStart", () => {
  const subscription = { mode: "auto", apiKeySource: "none" } as const;
  const apiKey = { mode: "auto", apiKeySource: "ANTHROPIC_API_KEY" } as const;

  it("lets the subscription token's start (no API key) go on", () => {
    expect(refuseStart(init("s") as InitMessage, subscription)).toBeUndefined();
  });

  it("lets an API key's start go on when the settings select the API key", () => {
    const start = init("s", "auto", "ANTHROPIC_API_KEY") as InitMessage;
    expect(refuseStart(start, apiKey)).toBeUndefined();
  });

  it("refuses each mode's start under the other mode", () => {
    expect(refuseStart(init("s") as InitMessage, apiKey)).toBe(
      "session 的認證來源是 none，不是設定的 ANTHROPIC_API_KEY，已停下。",
    );
    const start = init("s", "auto", "ANTHROPIC_API_KEY") as InitMessage;
    expect(refuseStart(start, subscription)).toBe(
      "session 的認證來源是 ANTHROPIC_API_KEY，不是設定的 none，已停下。",
    );
  });

  it("refuses the wrong permission mode first", () => {
    expect(refuseStart(init("s", "default") as InitMessage, subscription)).toBe(
      "session 開始時的權限模式是 default，不是 auto，已停下。",
    );
  });
});

describe("PromptStream", () => {
  it("gives the first prompt, then ends when closed", async () => {
    const stream = new PromptStream("hello");
    const seen: string[] = [];
    const reading = (async () => {
      for await (const message of stream) seen.push(promptText(message));
    })();
    await new Promise((resolve) => setImmediate(resolve));
    stream.close();
    await reading;
    expect(seen).toEqual(["hello"]);
  });
});

describe("endingOf", () => {
  it.each([
    [
      {
        kind: "output",
        output: workerOutput("ready", { pr_url: "https://github.com/o/r/pull/1" }),
      },
      "done",
      false,
      "ready",
    ],
    [{ kind: "output", output: workerOutput("report") }, "done", true, "report"],
    [{ kind: "output", output: workerOutput("landed") }, "done", true, "landed"],
    [{ kind: "output", output: workerOutput("failed") }, "failed", true, "failed"],
    [{ kind: "output", output: workerOutput("ready") }, "failed", true, "failed"],
    [{ kind: "max_turns" }, "failed", true, "failed"],
    [{ kind: "refused", reason: "r" }, "failed", true, "failed"],
    [{ kind: "error", message: "m" }, "failed", true, "failed"],
  ] as const)("%j → %s", (end, state, cleanUp, summary) => {
    const ending = endingOf(end);
    expect([ending.state, ending.cleanUp, ending.summary?.kind]).toEqual([state, cleanUp, summary]);
  });

  it("pauses on the quota with no summary, keeps the worktree and leaves the todos alone", () => {
    expect(endingOf({ kind: "quota", resetsAtMs: 5 })).toEqual({
      state: "paused",
      text: TEXT.quota,
      summary: null,
      prReady: null,
      cleanUp: false,
      quota: { resetsAtMs: 5 },
      hold: null,
      todos: { kind: "keep" },
    });
  });

  it("blocks a task whose worker handed back todos, waiting on the captain's hands", () => {
    const todo = { id: "t-vpn", title: "VPN", do: "登入", cmds: ["sudo x"] };
    const ending = endingOf({ kind: "output", output: workerOutput("report", { todos: [todo] }) });
    expect([ending.state, ending.cleanUp, ending.text, ending.hold]).toEqual([
      "blocked",
      false,
      TEXT.todos(1),
      null,
    ]);
    expect(ending.todos).toEqual({ kind: "sync", todos: [todo], summary: "worker report" });
  });

  const question = { title: "哪個快取？", text: "要留舊的快取嗎？", options: ["留", "不留"] };

  it.each(["report", "failed"])(
    "opens a release hold for a %s question: the work waits for the answer",
    (outcome) => {
      const ending = endingOf({ kind: "output", output: workerOutput(outcome, { question }) });
      expect(ending.hold).toEqual({
        title: "哪個快取？",
        question: "要留舊的快取嗎？\n選項：留 | 不留",
        onAnswer: "release",
      });
      expect([ending.state, ending.cleanUp, ending.text]).toEqual([
        "blocked",
        false,
        TEXT.question("哪個快取？"),
      ]);
    },
  );

  it("opens a close hold for a question that comes with delivered work", () => {
    const ready = workerOutput("ready", { question, pr_url: "https://github.com/o/r/pull/1" });
    const ending = endingOf({ kind: "output", output: ready });
    expect(ending.hold?.onAnswer).toBe("close");
    expect([ending.state, ending.text, ending.prReady]).toEqual([
      "done",
      TEXT.ready,
      "https://github.com/o/r/pull/1",
    ]);
    const landed = endingOf({ kind: "output", output: workerOutput("landed", { question }) });
    expect([landed.hold?.onAnswer, landed.state, landed.cleanUp]).toEqual(["close", "done", true]);
  });

  it.each([["a\nb"], ["a | b"], [" "]])(
    "takes no output whose option %j cannot be a button",
    (bad) => {
      const output = workerOutput("report", { question: { ...question, options: ["好", bad] } });
      expect(endingOf({ kind: "output", output }).text).toBe(TEXT.invalid);
    },
  );

  it.each([
    [{ kind: "max_turns" }],
    [{ kind: "refused", reason: "r" }],
    [{ kind: "error", message: "m" }],
    [{ kind: "output", output: undefined }],
  ] as const)("drops the todos of a task that ended with no usable output: %j", (end) => {
    expect(endingOf(end).todos).toEqual({ kind: "drop" });
  });
});
