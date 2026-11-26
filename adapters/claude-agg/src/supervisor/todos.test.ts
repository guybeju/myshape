import { describe, expect, it } from "vitest";

import type { TodoItem } from "./board-files.js";
import { boardTodos, CMDS_MAX, oneLine, TODO_REASON, todoOps, TITLE_MAX } from "./todos.js";

const VPN = { id: "vpn", title: "登入 VPN", do: "用公司帳號登入", cmds: ["sudo openconnect x"] };

describe("boardTodos", () => {
  it("names each item under the task, under the task's topic, with the task as ref", () => {
    expect(boardTodos("billing-1", "billing", [VPN])).toEqual([
      {
        id: "billing-1-vpn",
        title: "登入 VPN",
        topic: "billing",
        do: "用公司帳號登入",
        cmds: ["sudo openconnect x"],
        ref: "billing-1",
      },
    ]);
  });

  it("keeps an id the worker already namespaced, and makes a bad one a plain name", () => {
    const items = boardTodos("b-1", "b", [
      { ...VPN, id: "b-1-vpn" },
      { ...VPN, id: "../../etc passwd" },
      { ...VPN, id: "..." },
    ]);
    expect(items.map((item) => item.id)).toEqual(["b-1-vpn", "b-1-etc-passwd", "b-1-3"]);
  });

  it("leaves out a second todo with the same id", () => {
    const items = boardTodos("b-1", "b", [VPN, { ...VPN, title: "again" }]);
    expect(items.map((item) => item.title)).toEqual(["登入 VPN"]);
  });

  it("makes title and do one line within the board's limits, never starting with -", () => {
    const [item] = boardTodos("b-1", "b", [
      { ...VPN, title: `--force\n${"長".repeat(300)}‮`, do: "a\r\n\tb" },
    ]);
    expect(item?.title.startsWith("-")).toBe(false);
    expect(item?.title.includes("\n")).toBe(false);
    expect(item?.title.includes("‮")).toBe(false);
    expect([...(item?.title ?? "")]).toHaveLength(TITLE_MAX);
    expect(item?.do).toBe("a b");
  });

  it("keeps commands exactly as written, drops blank ones and keeps at most the board's 50", () => {
    const cmds = ["cat <<'EOF'\nx\nEOF", "  ", ...Array.from({ length: 60 }, (_, n) => `c${n}`)];
    const [item] = boardTodos("b-1", "b", [{ ...VPN, cmds }]);
    expect(item?.cmds[0]).toBe("cat <<'EOF'\nx\nEOF");
    expect(item?.cmds).toHaveLength(CMDS_MAX);
    expect(item?.cmds).not.toContain("  ");
  });
});

describe("oneLine", () => {
  it("cuts with … at the limit", () => {
    expect(oneLine("abcdef", 4)).toBe("abc…");
  });
});

function boardItems(entries: Record<string, TodoItem["state"]>): Map<string, TodoItem> {
  return new Map(
    Object.entries(entries).map(([id, state]) => [id, { state, ref: "b-1", title: id }]),
  );
}

describe("todoOps", () => {
  const [vpn] = boardTodos("b-1", "b", [VPN]);
  if (vpn === undefined) throw new Error("no item");

  it("changes nothing while the session goes on", () => {
    expect(todoOps(boardItems({ "b-1-vpn": "claimed" }), { kind: "keep" })).toEqual([]);
  });

  it("adds what the worker asks for", () => {
    expect(todoOps(boardItems({}), { kind: "sync", wanted: [vpn], summary: "s" })).toEqual([
      { op: "add", item: vpn },
    ]);
  });

  it("marks a claimed item done when the worker no longer lists it", () => {
    expect(
      todoOps(boardItems({ "b-1-vpn": "claimed" }), { kind: "sync", wanted: [], summary: "s" }),
    ).toEqual([{ op: "done", id: "b-1-vpn" }]);
  });

  it("puts a claimed item back with the worker's summary when it still lists it", () => {
    const ops = todoOps(boardItems({ "b-1-vpn": "claimed" }), {
      kind: "sync",
      wanted: [vpn],
      summary: "VPN 還連不上",
    });
    expect(ops).toEqual([
      { op: "failed", id: "b-1-vpn", reason: TODO_REASON.stillNeeded("VPN 還連不上") },
      { op: "add", item: vpn },
    ]);
  });

  it("makes an unclaimed item the worker no longer lists obsolete", () => {
    const ops = todoOps(boardItems({ "b-1-x": "open", "b-1-y": "rejected" }), {
      kind: "sync",
      wanted: [],
      summary: "s",
    });
    expect(ops).toEqual([
      { op: "obsolete", id: "b-1-x", reason: TODO_REASON.notNeeded },
      { op: "obsolete", id: "b-1-y", reason: TODO_REASON.notNeeded },
    ]);
  });

  it("makes every item obsolete, claimed or not, when nothing can be checked", () => {
    expect(todoOps(boardItems({ "b-1-x": "open", "b-1-y": "claimed" }), { kind: "drop" })).toEqual([
      { op: "obsolete", id: "b-1-x", reason: TODO_REASON.ended },
      { op: "obsolete", id: "b-1-y", reason: TODO_REASON.ended },
    ]);
  });
});
