// The supervisor's production entry point (plan section 7 step 8, D10):
// started by hand in a terminal with one argument, the settings file. It
// reads the settings and the credential file, takes the lock, starts the
// supervisor, runs a pass whenever the board's files or the agent's inbox
// change and at least once a minute, and on SIGINT or SIGTERM stops: no new
// session starts, running sessions are aborted (their tasks are found paused
// at the next start), and the lock is given back.

import { watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";

import { spawnCommand, type PlainEnv } from "./commands.js";
import { readCredentialFile } from "./credential.js";
import { existingRealPath } from "./guard.js";
import type { QueryFn } from "./sdk.js";
import { SESSION_TMP_ROOT } from "./session-options.js";
import { readSettingsFile } from "./settings-file.js";
import { Supervisor } from "./supervisor.js";

export const USAGE = "usage: claude-agg-supervisor.mjs <settings.json>";

/** How often a pass runs when nothing changed. */
export const POLL_MS = 60_000;
/** How long a burst of file changes is gathered into one pass. */
const SETTLE_MS = 500;

export interface MainDeps {
  query: QueryFn;
  /** The process's environment: only PATH, HOME, LANG and TMPDIR are taken from it. */
  env: Readonly<Record<string, string | undefined>>;
  uid: number;
  pid: number;
  log: (line: string) => void;
  /** Resolves with the signal's name once the supervisor should stop. */
  stopSignal: Promise<string>;
  pollMs: number;
}

/**
 * The supervisor's own environment: four names of the process's, nothing
 * else. Its commands and its sessions build theirs from it (commands.ts,
 * session-options.ts), so no other name of the terminal's environment
 * reaches either.
 */
export function plainEnv(env: MainDeps["env"]): PlainEnv {
  const { PATH, HOME } = env;
  if (PATH === undefined || PATH === "") throw new Error("PATH is not set");
  if (HOME === undefined || !HOME.startsWith("/")) throw new Error("HOME is not an absolute path");
  return { PATH, HOME, LANG: env["LANG"] ?? "C.UTF-8", TMPDIR: env["TMPDIR"] ?? "/tmp" };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function startFrom(path: string, deps: MainDeps): Promise<Supervisor> {
  const { settings, auth } = readSettingsFile(path, deps.uid);
  const credential = readCredentialFile(settings.credentialFile, deps.uid, auth);
  return Supervisor.start(settings, {
    query: deps.query,
    run: spawnCommand,
    credential,
    env: plainEnv(deps.env),
    nowMs: () => Date.now(),
    log: deps.log,
    realPath: existingRealPath,
    pid: deps.pid,
    isAlive,
    tmpRoot: SESSION_TMP_ROOT,
  });
}

/** Runs passes, one at a time: on a timer, and soon after a watched directory changes. */
class Passes {
  private running: Promise<void> | undefined;
  private again = false;
  private settle: NodeJS.Timeout | undefined;
  private readonly timer: NodeJS.Timeout;
  private readonly watchers: FSWatcher[] = [];

  constructor(
    private readonly supervisor: Supervisor,
    private readonly log: (line: string) => void,
    pollMs: number,
  ) {
    this.timer = setInterval(() => this.run(), pollMs);
  }

  watch(dirs: readonly string[]): void {
    for (const dir of dirs) {
      try {
        this.watchers.push(watch(dir, () => this.soon()));
      } catch (error) {
        this.log(`cannot watch ${dir} (${(error as Error).message}); the timer still runs passes`);
      }
    }
  }

  private soon(): void {
    clearTimeout(this.settle);
    this.settle = setTimeout(() => this.run(), SETTLE_MS);
  }

  /** One pass now, or right after the one that runs. */
  run(): void {
    if (this.running !== undefined) {
      this.again = true;
      return;
    }
    this.running = this.pass().finally(() => {
      this.running = undefined;
      if (this.again) {
        this.again = false;
        this.run();
      }
    });
  }

  private async pass(): Promise<void> {
    try {
      this.supervisor.tick();
      await this.supervisor.pollPullRequests();
    } catch (error) {
      this.log(`a pass failed: ${(error as Error).message}`);
    }
  }

  /** Stops the timer and the watchers, then waits for the pass that runs. */
  async close(): Promise<void> {
    clearInterval(this.timer);
    clearTimeout(this.settle);
    for (const watcher of this.watchers) watcher.close();
    this.again = false;
    await this.running;
  }
}

/**
 * Runs the supervisor for the settings file named in `argv` until
 * `deps.stopSignal` resolves.
 *
 * Returns:
 *   The exit status: 0 after a clean stop, 1 when it could not start, 2 for
 *   a wrong command line.
 */
export async function main(argv: readonly string[], deps: MainDeps): Promise<number> {
  const [path] = argv;
  if (argv.length !== 1 || path === undefined) {
    deps.log(USAGE);
    return 2;
  }
  let supervisor: Supervisor;
  try {
    supervisor = await startFrom(resolve(path), deps);
  } catch (error) {
    deps.log(`claude-agg: not started: ${(error as Error).message}`);
    return 1;
  }
  const home = supervisor.home;
  const passes = new Passes(supervisor, deps.log, deps.pollMs);
  passes.watch([join(home, "agg", "inbox"), join(home, "data"), join(home, "data", "myshape")]);
  passes.run();
  deps.log(`claude-agg: running (pid ${deps.pid}); stop it with Ctrl-C or kill ${deps.pid}`);
  const signal = await deps.stopSignal;
  const stopped = supervisor.stop();
  deps.log(`claude-agg: ${signal}: stopping; running sessions are aborted`);
  await passes.close();
  await stopped;
  deps.log("claude-agg: stopped");
  return 0;
}

/** The first of SIGINT and SIGTERM, by name. */
function firstSignal(): Promise<string> {
  return new Promise((done) => {
    const stop = (signal: string) => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      done(signal);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

/** main() with this process: its arguments, environment and signals, and the SDK's own query(). */
export function runFromProcess(): Promise<number> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("claude-agg runs on Linux or macOS only");
  return main(process.argv.slice(2), {
    query,
    env: process.env,
    uid,
    pid: process.pid,
    log: (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`),
    stopSignal: firstSignal(),
    pollMs: POLL_MS,
  });
}
