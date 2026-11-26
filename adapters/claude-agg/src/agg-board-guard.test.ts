// What the board runs must stay one self-contained file (plan decision D5):
// Node's built-in fs, path and crypto only, no process, no network, one
// environment name. And neither it nor the package presents itself with
// Firstmate's names.
import { spawnSync } from "node:child_process";
import { rmSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AGENT_NAME } from "./agent-name.js";
import { PACKAGE_DIR, PROGRAM, REPO_ROOT, runProgram, scratchHome } from "./test-home.js";

const source = readFileSync(PROGRAM, "utf8");
const ALLOWED_MODULES = ["node:crypto", "node:fs", "node:path"];
const STATIC_IMPORT = /\bimport\s*(?:[\w*{}\s,]+?\s*from\s*)?["']([^"']+)["']/g;

describe("agg-board.mjs is one self-contained file", () => {
  it("imports only Node's built-in fs, path and crypto, and nothing at run time", () => {
    const specifiers = [...source.matchAll(STATIC_IMPORT)].map((match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(ALLOWED_MODULES).toContain(specifier);
    const importWords = source.match(/\bimport\b(?!\.meta\b)/g) ?? [];
    expect(importWords).toHaveLength(specifiers.length);
  });

  it.each([
    ["require", /\brequire\b/],
    ["dynamic import", /\bimport\s*\(/],
    ["createRequire", /createRequire/],
    ["getBuiltinModule", /getBuiltinModule/],
    ["process.binding", /process\s*\.\s*(binding|dlopen|_linkedBinding)/],
    ["child_process", /child_process/],
    ["spawn or exec", /\b(spawn|exec|execFile|fork)\w*\s*\(/],
    ["fetch", /\bfetch\s*\(/],
    ["WebSocket", /WebSocket/],
    ["eval", /\beval\s*\(|\bFunction\s*\(/],
    [
      "a network module",
      /node:(net|http|https|http2|dgram|tls|dns|worker_threads|cluster|vm|inspector)\b/,
    ],
  ])("has no %s", (_what, pattern) => {
    expect(source).not.toMatch(pattern);
  });

  it("reads no environment name but MYSHAPE_HOME", () => {
    const names = [...source.matchAll(/process\.env(?:\[["']([^"']+)["']\]|\.(\w+))?/g)].map(
      (match) => match[1] ?? match[2] ?? "(the whole environment)",
    );
    expect(names).toEqual(["MYSHAPE_HOME"]);
  });

  it("is an executable with a node shebang, and git keeps it executable", () => {
    expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(statSync(PROGRAM).mode & 0o111).toBe(0o111);
    expect(statSync(PROGRAM).mode & 0o022).toBe(0);
    const git = spawnSync("git", ["-C", PACKAGE_DIR, "ls-files", "-s", "--", "bin/agg-board.mjs"], {
      encoding: "utf8",
    });
    expect(git.stdout).toMatch(/^100755 /);
  });
});

describe("the agent does not present itself with Firstmate's names", () => {
  const names = readFileSync(join(REPO_ROOT, "myshape", "test", "firstmate-names"), "utf8")
    .split("\n")
    .filter((line) => line !== "");
  const words = [...new Set(names.flatMap((name) => [name, name.replace(/\.sh$/, "")]))];
  const firstmateWord = /first\s*mate/i;

  it("reads a real list", () => {
    expect(names.length).toBeGreaterThan(100);
    expect(names).toContain("fm-board.sh");
  });

  it("uses none of them in the program's text, strings or commands", () => {
    for (const word of words) expect(source).not.toContain(word);
    expect(source).not.toMatch(firstmateWord);
  });

  it("names none of them in what the board shows of it", () => {
    const { home } = scratchHome();
    try {
      const run = runProgram(home, ["feed", "main", "0", "-"]);
      expect(run.status).toBe(0);
      expect(run.stdout).not.toMatch(firstmateWord);
      for (const word of words) expect(run.stdout).not.toContain(word);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("gives its package and its commands none of them", () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as {
      name: string;
      scripts: Record<string, string>;
    };
    const commands = [pkg.name, AGENT_NAME, ...Object.keys(pkg.scripts), "agg-board.mjs"];
    for (const command of commands) {
      expect(words).not.toContain(command);
      expect(command).not.toMatch(firstmateWord);
    }
  });
});
