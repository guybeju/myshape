// One scratch world for supervisor tests: a board home, a worktree root, the
// fake commands, the scripted query, a clock, and the supervisor's settings.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { LedgerEvent, TaskEntry } from "#agg/state-files.js";

import { existingRealPath } from "./guard.js";
import {
  boardHome,
  CANARY,
  ENV,
  FakeCommands,
  ScriptedQuery,
  type Topics,
} from "./harness.test-helper.js";
import type { Settings } from "./settings.js";
import type { PlannedTask } from "./state-store.js";
import { Supervisor, type Deps } from "./supervisor.js";

export const BOARD_COMMAND = "/opt/board/bin/myshape.sh";
export const REPO = "/repos/app";
export const START_MS = Date.parse("2026-11-27T02:00:00Z");

export class World {
  readonly home: string;
  readonly root: string;
  readonly agg: string;
  readonly commands = new FakeCommands(BOARD_COMMAND);
  readonly query: ScriptedQuery;
  readonly logs: string[] = [];
  nowMs = START_MS;
  model: string | undefined = undefined;
  alive = new Set<number>();
  pid = 4242;

  constructor(queues: Topics, hashtags: Record<string, string[]> = {}) {
    const { home, root } = boardHome(queues, hashtags);
    this.home = home;
    this.root = root;
    this.agg = join(home, "agg");
    this.query = new ScriptedQuery(root);
  }

  settings(): Settings {
    return {
      home: this.home,
      worktreeRoot: this.root,
      boardCommand: BOARD_COMMAND,
      port: 47_829,
      repos: { app: { path: REPO, base: "origin/main", defaultBranch: "main" } },
      model: this.model,
    };
  }

  deps(): Deps {
    return {
      query: this.query.query,
      run: this.commands.run,
      token: CANARY,
      env: ENV,
      nowMs: () => this.nowMs,
      log: (line) => this.logs.push(line),
      realPath: existingRealPath,
      pid: this.pid,
      isAlive: (pid) => this.alive.has(pid),
    };
  }

  start(): Promise<Supervisor> {
    return Supervisor.start(this.settings(), this.deps());
  }

  /** Writes queued.json as a supervisor that planned these tasks would have. */
  seedQueued(entries: { id: string; topic: string }[]): void {
    const queued: PlannedTask[] = entries.map(({ id, topic }) => ({
      id,
      kind: "ship",
      title: `做 ${id}`,
      hold: null,
      captain: false,
      blockers: [],
      topic_hint: topic,
      repo: "app",
      prompt: `prompt ${id}`,
    }));
    writeFileSync(join(this.agg, "queued.json"), JSON.stringify({ v: 1, queued }));
  }

  /** Rewrites data/topics.json with these queues. */
  moveTopics(queues: Topics): void {
    const path = join(this.home, "data", "topics.json");
    const doc = JSON.parse(readFileSync(path, "utf8")) as { queues: Topics };
    doc.queues = { high: [], normal: [], later: [], ...queues };
    writeFileSync(path, JSON.stringify(doc));
  }

  tasks(): Record<string, TaskEntry> {
    return (
      JSON.parse(readFileSync(join(this.agg, "tasks.json"), "utf8")) as {
        tasks: Record<string, TaskEntry>;
      }
    ).tasks;
  }

  queued(): PlannedTask[] {
    return (
      JSON.parse(readFileSync(join(this.agg, "queued.json"), "utf8")) as { queued: PlannedTask[] }
    ).queued;
  }

  holds(): Record<string, { state: string; title: string; hold_until?: string | null }> {
    return (
      JSON.parse(readFileSync(join(this.agg, "holds.json"), "utf8")) as {
        holds: Record<string, { state: string; title: string; hold_until?: string | null }>;
      }
    ).holds;
  }

  ledger(): LedgerEvent[] {
    return readFileSync(join(this.agg, "ledger.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LedgerEvent);
  }

  /** `task`'s ledger lines as short strings: event, then state and text or pr. */
  events(task: string): string[] {
    return this.ledger()
      .filter((event) => event.task === task)
      .map((event) => {
        if (event.event === "task.status") return `status ${event.state} ${event.text}`;
        if (event.event === "task.pr_ready" || event.event === "task.merged")
          return `${event.event} ${event.pr}`;
        return event.event;
      });
  }

  /** Every file under the home and the worktree root, with its text. */
  everyFile(): string[] {
    const texts: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else texts.push(readFileSync(path, "utf8"));
      }
    };
    walk(this.home);
    walk(this.root);
    return texts;
  }
}
