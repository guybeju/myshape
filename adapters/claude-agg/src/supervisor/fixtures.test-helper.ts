// Test helpers: scratch board homes and the seeded generator (mulberry32) the
// property tests use, so a failing case can be replayed from its seed.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface HomeFiles {
  topics?: unknown;
  archive?: unknown;
  hashtags?: unknown;
  schedules?: unknown;
}

const PATHS: Readonly<Record<keyof HomeFiles, readonly string[]>> = {
  topics: ["data", "topics.json"],
  archive: ["data", "topics-archive.json"],
  hashtags: ["data", "myshape", "hashtags.json"],
  schedules: ["data", "myshape", "schedules.json"],
};

/** The path of `file` in `home`. */
export function boardPath(home: string, file: keyof HomeFiles): string {
  return join(home, ...PATHS[file]);
}

const homes: string[] = [];

/** Removes every scratch home `writeHome` made; for `afterAll`. */
export function removeHomes(): void {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
}

/** A new scratch board home holding the given files; a string is written as is. */
export function writeHome(files: HomeFiles): string {
  const home = mkdtempSync(join(tmpdir(), "claude-agg-order-"));
  homes.push(home);
  mkdirSync(join(home, "data", "myshape"), { recursive: true });
  for (const name of Object.keys(PATHS) as (keyof HomeFiles)[]) {
    const content = files[name];
    if (content === undefined) continue;
    const text = typeof content === "string" ? content : JSON.stringify(content);
    writeFileSync(boardPath(home, name), text);
  }
  return home;
}

/** A seeded generator (mulberry32). */
export function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
