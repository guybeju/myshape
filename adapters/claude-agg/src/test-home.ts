/**
 * Test helpers: a scratch board home with claude-agg's state directory, typed
 * writers for the supervisor's files, and a runner for `bin/agg-board.mjs`
 * with exactly the five environment names the board hands its programs.
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  AGG_DIR,
  type HoldsFile,
  type LandedRecord,
  type LedgerEvent,
  type QueuedFile,
  type TasksFile,
} from "./state-files.js";

/** The package directory and the repository root above it. */
export const PACKAGE_DIR = resolve(import.meta.dirname, "..");
export const REPO_ROOT = resolve(PACKAGE_DIR, "..", "..");
export const PROGRAM = join(PACKAGE_DIR, "bin", "agg-board.mjs");

/** A scratch board home; `agg` is its claude-agg state directory. */
export interface ScratchHome {
  home: string;
  agg: string;
}

/** A new scratch home under the temporary directory, with or without `agg/` and its directories. */
export function scratchHome(withAgg = true): ScratchHome {
  const home = mkdtempSync(join(tmpdir(), "agg-board-"));
  const agg = join(home, AGG_DIR);
  if (withAgg) {
    for (const dir of ["inbox/handled", "answers/handled", "tags"]) {
      mkdirSync(join(agg, dir), { recursive: true, mode: 0o700 });
    }
  }
  return { home, agg };
}

export function writeTasks(agg: string, file: TasksFile): void {
  writeFileSync(join(agg, "tasks.json"), JSON.stringify(file));
}

export function writeHolds(agg: string, file: HoldsFile): void {
  writeFileSync(join(agg, "holds.json"), JSON.stringify(file));
}

export function writeQueued(agg: string, file: QueuedFile): void {
  writeFileSync(join(agg, "queued.json"), JSON.stringify(file));
}

export function appendLedger(agg: string, events: LedgerEvent[]): void {
  appendFileSync(join(agg, "ledger.jsonl"), events.map((e) => `${JSON.stringify(e)}\n`).join(""));
}

export function appendTag(agg: string, task: string, topic: string, at: string): void {
  appendFileSync(join(agg, "tags", task), `${topic} ${at}\n`);
}

/** What one run of the program did. */
export interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** The five names the board gives every program (contract section 7), and nothing else. */
export function boardEnv(home: string): Record<string, string> {
  return {
    MYSHAPE_HOME: home,
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: process.env["HOME"] ?? home,
    LANG: "C.UTF-8",
    TMPDIR: tmpdir(),
  };
}

/** Runs `node bin/agg-board.mjs <args>` the way the board does, with `stdin` as its input. */
export function runProgram(home: string, args: string[], stdin = "", program = PROGRAM): Run {
  const result = spawnSync(process.execPath, [program, ...args], {
    env: boardEnv(home),
    input: stdin,
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Every file under `dir` with its bytes, as relative path to content: a snapshot to compare. */
export function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (path: string, rel: string): void => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      const relName = rel === "" ? name : `${rel}/${name}`;
      if (statSync(full).isDirectory()) walk(full, relName);
      else files[relName] = readFileSync(full, "utf8");
    }
  };
  walk(dir, "");
  return files;
}

export function readLanded(path: string): LandedRecord {
  return JSON.parse(readFileSync(path, "utf8")) as LandedRecord;
}
