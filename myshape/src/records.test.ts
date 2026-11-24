import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Journal } from "./journal.js";
import { stampRecord } from "./records.js";

describe("a saved record", () => {
  const actor = { by: "captain" as const, label: "plain" };

  it("carries its id, time and who made it, and only the fields its draft has", () => {
    const bare = stampRecord({ kind: "topic.kept", topic: "a", text: "t" }, actor, "r-1", 5);
    expect(bare).toStrictEqual({
      src: "board",
      rid: "r-1",
      ts: 5,
      kind: "topic.kept",
      topic: "a",
      home: null,
      task: null,
      by: "captain",
      label: "plain",
      text: "t",
    });
    const full = stampRecord(
      {
        kind: "hold.answered",
        topic: null,
        home: "",
        task: "",
        item: "i",
        outcome: "A",
        reason: "r",
        text: "t",
      },
      actor,
      "r-2",
      6,
    );
    expect(full).toMatchObject({ home: "", task: "", item: "i", outcome: "A", reason: "r" });
  });

  it("keeps a decision's key, answer, source and time, and the journal knows the key again", () => {
    const record = stampRecord(
      {
        kind: "hold.closed",
        topic: "nas",
        home: "main",
        task: "x",
        outcome: "answered",
        key: "hold.closed\tmain\tx\td",
        answer: "要",
        source: "chat",
        at: 3,
        text: "t",
      },
      actor,
      "r-3",
      9,
    );
    expect(record).toMatchObject({
      ts: 3,
      key: "hold.closed\tmain\tx\td",
      answer: "要",
      source: "chat",
    });
    expect(record).not.toHaveProperty("at");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-records-"));
    try {
      const file = path.join(dir, "events.jsonl");
      new Journal(file).appendRecord(record);
      const again = new Journal(file);
      expect(again.hasKey("hold.closed\tmain\tx\td")).toBe(true);
      expect(again.hasKey("other")).toBe(false);
      expect(again.events[0]).toMatchObject({ key: record.key, answer: "要", source: "chat" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
