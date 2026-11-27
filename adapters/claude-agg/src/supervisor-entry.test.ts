// The supervisor's entry point as the captain starts it: bin/ runs the build
// in dist/, so this builds it (the package's own `build` script, the same
// tsc) and runs the program only where it stops before starting anything:
// with no argument and with a settings file that is not there.

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { PACKAGE_DIR } from "./test-home.js";

const ENTRY = join(PACKAGE_DIR, "bin", "claude-agg-supervisor.mjs");

function runEntry(args: string[]) {
  return spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: PACKAGE_DIR,
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8" },
    timeout: 30_000,
  });
}

beforeAll(() => {
  const tsc = join(PACKAGE_DIR, "node_modules", ".bin", "tsc");
  const build = spawnSync(tsc, ["-p", "tsconfig.build.json"], {
    cwd: PACKAGE_DIR,
    encoding: "utf8",
  });
  expect(build.status, build.stdout + build.stderr).toBe(0);
}, 120_000);

describe("bin/claude-agg-supervisor.mjs", () => {
  it("prints its usage and exits 2 with no argument", () => {
    const run = runEntry([]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("usage: claude-agg-supervisor.mjs <settings.json>");
  });

  it("does not start without a readable settings file, and exits 1", () => {
    const run = runEntry(["/nonexistent/settings.json"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("claude-agg: not started: /nonexistent/settings.json");
  });

  it("is an executable with a node shebang that the board never runs", () => {
    const source = readFileSync(ENTRY, "utf8");
    expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(statSync(ENTRY).mode & 0o111).toBe(0o111);
    expect(source).not.toContain("agg-board");
  });
});
