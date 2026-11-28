import { describe, expect, it } from "vitest";
import { ROUTES, createApi } from "./api.js";
import type { ApiHost } from "./api.js";
import { PC_ONLY_ROUTES } from "./http.js";

/** A host whose every route can run to its end, recording the board operations it reaches. */
function recordingHost(ops: string[]): ApiHost {
  return {
    bootId: "boot",
    version: () => "1",
    view: () => ({}),
    touch: () => undefined,
    refresh: async () => undefined,
    topicOp: (op) => {
      ops.push(op);
      return { ok: true, line: "ok" };
    },
    actionContext: () => {
      throw new Error("no action context in this test");
    },
    writes: { records: new Map(), resend: () => null, ignore: () => null } as never,
    confirm: { issue: () => ({ confirm: "c-1", expires_at: 0 }), redeem: () => true } as never,
    programToConfirm: () => ({
      path: "/bin/prog",
      sha256: "a".repeat(64),
      binding_sha256: "b".repeat(64),
      roles: ["feed"],
    }),
    programConfirmed: () => undefined,
    hashtagTopics: () => [],
    scheduleOf: () => "s-1",
  };
}

describe("the routes that confirm a program", () => {
  it("are only the ones the remote name may never reach", async () => {
    const confirming: string[] = [];
    for (const key of Object.keys(ROUTES)) {
      const ops: string[] = [];
      const [method, route] = key.split(" ") as [string, string];
      const body = { role: "feed", confirm: "c-1" };
      await createApi(recordingHost(ops))(method, route, new URLSearchParams(), body).catch(
        () => undefined,
      );
      if (ops.includes("program-confirm")) confirming.push(route);
    }
    expect(confirming).toEqual(["programs/confirm"]);
    expect(confirming.every((route) => PC_ONLY_ROUTES.includes(route))).toBe(true);
  });
});
