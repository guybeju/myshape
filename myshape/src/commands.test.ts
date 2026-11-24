import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CommandRefused,
  PROGRAM_ENV_NAMES,
  commandRunner,
  directTextProblem,
  invocationFor,
  programEnv,
} from "./commands.js";
import type { AllowedCommand, ProgramGate } from "./commands.js";

const SHA = "a".repeat(64);

function refusedFor(command: AllowedCommand): string {
  try {
    invocationFor(command);
  } catch (error) {
    if (error instanceof CommandRefused) return error.message;
    throw error;
  }
  throw new Error("the command was allowed");
}

describe("the feed", () => {
  it("is one shape for every home", () => {
    expect(invocationFor({ kind: "feed", home: "main", offset: 0, sha: "-" })).toEqual({
      args: ["feed", "main", "0", "-"],
    });
    expect(invocationFor({ kind: "feed", home: "w2", offset: 12, sha: SHA })).toEqual({
      args: ["feed", "w2", "12", SHA],
    });
  });

  it("refuses a malformed home, offset, or hash", () => {
    expect(refusedFor({ kind: "feed", home: "-x", offset: 0, sha: "-" })).toContain("home id");
    expect(refusedFor({ kind: "feed", home: "a b", offset: 0, sha: "-" })).toContain("home id");
    expect(refusedFor({ kind: "feed", home: "main", offset: -1, sha: "-" })).toContain("offset");
    expect(refusedFor({ kind: "feed", home: "main", offset: 1.5, sha: "-" })).toContain("offset");
    expect(refusedFor({ kind: "feed", home: "main", offset: 0, sha: "abc" })).toContain("hash");
    const closed = (offset: number, sha: string): AllowedCommand => ({
      kind: "feed",
      home: "main",
      offset: 0,
      sha: "-",
      closed: { offset, sha },
    });
    expect(invocationFor(closed(4, SHA))).toEqual({ args: ["feed", "main", "0", "-", "4", SHA] });
    expect(refusedFor(closed(-1, "-"))).toContain("closed offset");
    expect(refusedFor(closed(0, "x"))).toContain("closed prefix hash");
  });
});

describe("the deliverer", () => {
  it("gets the record as one line on stdin and no argument but its name", () => {
    expect(invocationFor({ kind: "deliver", record: '{"v":1}' })).toEqual({
      args: ["deliver"],
      stdin: '{"v":1}\n',
    });
  });

  it("refuses a record that is more than one line", () => {
    expect(refusedFor({ kind: "deliver", record: '{"v":1}\n{"v":1}' })).toContain("one line");
  });
});

describe("directTextProblem", () => {
  it("refuses text a terminal would run as a command", () => {
    for (const text of ["/compact", "$skill", "-x", "--key", "!ls", "  /x", "", "   "]) {
      expect(directTextProblem(text)).not.toBeNull();
    }
  });

  it("accepts ordinary text", () => {
    expect(directTextProblem("please stop at the review")).toBeNull();
    expect(directTextProblem("a/b and $5")).toBeNull();
  });
});

describe("programEnv", () => {
  it("copies only the listed names the board has, and sets MYSHAPE_HOME", () => {
    const env = programEnv(
      { PATH: "/usr/bin", HOME: "/h", SSH_AUTH_SOCK: "/decoy", FM_DATA_OVERRIDE: "/decoy" },
      "/the/home",
    );
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/h", MYSHAPE_HOME: "/the/home" });
    expect(PROGRAM_ENV_NAMES).toEqual(["PATH", "HOME", "LANG", "TMPDIR"]);
  });

  it("drops empty and relative PATH entries and keeps the rest in order", () => {
    expect(programEnv({ PATH: ":/usr/bin::.:bin:/bin:" }, "/h")["PATH"]).toBe("/usr/bin:/bin");
    expect(programEnv({ PATH: "" }, "/h")["PATH"]).toBe("");
  });

  it("does not let the starter's MYSHAPE_HOME through", () => {
    expect(programEnv({ MYSHAPE_HOME: "/other" }, "/the/home")).toEqual({
      MYSHAPE_HOME: "/the/home",
    });
  });
});

describe("commandRunner", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-commands-"));
  fs.mkdirSync(path.join(root, "bin"));
  const program = (body: string): void => {
    fs.writeFileSync(path.join(root, "bin", "fm-board.sh"), `#!/usr/bin/env bash\n${body}\n`, {
      mode: 0o755,
    });
  };
  const config = {
    home: "/the/main/home",
    root,
    commit: "c",
    port: 1,
    state: "/s",
    data: "/d",
    config: "/c",
    binding: "-",
    exempt: [],
  };
  const roles: string[] = [];
  let blocked: string | null = null;
  const gate: ProgramGate = (role) => {
    roles.push(role);
    return blocked === null ? { program: path.join(root, "bin", "fm-board.sh") } : { blocked };
  };
  const run = commandRunner(config, gate);
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("runs the program the gate names with MYSHAPE_HOME, the arguments, and stdin", async () => {
    program('printf "%s|" "$MYSHAPE_HOME" "$@"; cat');
    const result = await run({ kind: "deliver", record: '{"v":1,"id":"w"}' }, 5000);
    expect(result).toEqual({
      code: 0,
      stdout: '/the/main/home|deliver|{"v":1,"id":"w"}\n',
      stderr: "",
    });
  });

  it("returns the exit code and stderr of a failing program", async () => {
    program('echo "cannot report" >&2; exit 4');
    const result = await run({ kind: "feed", home: "w2", offset: 0, sha: "-" }, 5000);
    expect(result).toEqual({ code: 4, stdout: "", stderr: "cannot report\n" });
  });

  it("survives a deliverer that exits without reading its stdin", async () => {
    program("exit 0");
    const result = await run({ kind: "deliver", record: "x".repeat(200_000) }, 5000);
    expect(result.code).toBe(0);
  });

  it("reports a refused command without running anything", async () => {
    program(`touch ${path.join(root, "ran")}`);
    const result = await run({ kind: "feed", home: "a b", offset: 0, sha: "-" }, 5000);
    expect(result.code).toBeNull();
    expect(result.stderr).toContain("home id");
    expect(fs.existsSync(path.join(root, "ran"))).toBe(false);
  });

  it("asks the gate for the role right before running, and runs nothing it refuses", async () => {
    program(`touch ${path.join(root, "ran-blocked")}`);
    roles.length = 0;
    blocked = "要先在頁面上確認";
    const result = await run({ kind: "deliver", record: "{}" }, 5000);
    blocked = null;
    expect(result).toEqual({ code: null, stdout: "", stderr: "", blocked: "要先在頁面上確認" });
    expect(roles).toEqual(["deliver"]);
    expect(fs.existsSync(path.join(root, "ran-blocked"))).toBe(false);
    await run({ kind: "feed", home: "main", offset: 0, sha: "-" }, 5000);
    expect(roles).toEqual(["deliver", "feed"]);
  });

  it("hands the program only the fixed environment", async () => {
    process.env["TB_CANARY"] = "leak";
    program("env | sed 's/=.*//' | LC_ALL=C sort");
    const result = await run({ kind: "feed", home: "main", offset: 0, sha: "-" }, 5000);
    delete process.env["TB_CANARY"];
    const names = result.stdout.trim().split("\n");
    expect(names).not.toContain("TB_CANARY");
    expect(names).toContain("MYSHAPE_HOME");
    for (const name of names)
      expect([...PROGRAM_ENV_NAMES, "MYSHAPE_HOME", "PWD", "SHLVL", "_"]).toContain(name);
  });

  it("gives a null code when the program is missing or times out", async () => {
    fs.rmSync(path.join(root, "bin", "fm-board.sh"));
    const missing = await run({ kind: "feed", home: "main", offset: 0, sha: "-" }, 5000);
    expect(missing.code).toBeNull();
    expect(missing.stderr).not.toBe("");
    program("sleep 5");
    const slow = await run({ kind: "feed", home: "main", offset: 0, sha: "-" }, 200);
    expect(slow.code).toBeNull();
  });
});
