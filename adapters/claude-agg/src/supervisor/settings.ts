// The supervisor's settings, checked once at start, and the lock that keeps a
// second supervisor off the same worktree root, so two workers never take one
// task.

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** A repository workers may work in. */
export interface RepoSetting {
  /** The repository's main checkout: worktrees are added from it, and its project settings apply. */
  path: string;
  /** The ref a new worktree starts from, such as `origin/main`. */
  base: string;
  /** The branch no worker may push, such as `main`. */
  defaultBranch: string;
}

export interface Settings {
  /** The board home. */
  home: string;
  /** The directory worktrees are made in: outside the board home. */
  worktreeRoot: string;
  /** The board's command, bin/myshape.sh of the checkout the board runs from. */
  boardCommand: string;
  /** The board's TCP port (config/myshape-port, 47819 when it is not there). */
  port: number;
  /** The only repositories workers may work in, by the name the planner uses. */
  repos: Readonly<Record<string, RepoSetting>>;
  /** The user's model setting, passed to every session unchanged; undefined passes none. */
  model: string | undefined;
  /** The credential file, absolute: sessions are denied reading it. */
  credentialFile: string;
  /**
   * Absolute paths a worker's sandboxed commands may read besides its
   * worktree, such as where its toolchain lives under the home directory.
   */
  readPaths: readonly string[];
}

export class SettingsError extends Error {
  constructor(problem: string) {
    super(`claude-agg settings: ${problem}`);
    this.name = "SettingsError";
  }
}

const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

function inside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

function checkRepo(name: string, repo: RepoSetting, home: string): void {
  if (!NAME.test(name))
    throw new SettingsError(`repo name ${JSON.stringify(name)} is not a plain name`);
  if (!isAbsolute(repo.path)) throw new SettingsError(`repo ${name}: path must be absolute`);
  if (inside(repo.path, home)) throw new SettingsError(`repo ${name} is inside the board home`);
  if (!BRANCH.test(repo.defaultBranch) || repo.base.trim() === "") {
    throw new SettingsError(`repo ${name}: base and defaultBranch must be set`);
  }
}

/**
 * Checks `settings`, with `realPath` resolving symbolic links, and returns them
 * with home and worktree root resolved.
 *
 * Raises:
 *   SettingsError: a path that is not absolute, a worktree root inside the
 *     board home or the home inside it, no repository, or a bad port.
 */
export function checkSettings(settings: Settings, realPath: (path: string) => string): Settings {
  for (const [what, path] of [
    ["home", settings.home],
    ["worktreeRoot", settings.worktreeRoot],
    ["boardCommand", settings.boardCommand],
    ["credentialFile", settings.credentialFile],
    ...settings.readPaths.map((entry) => ["readPaths", entry] as const),
  ] as const) {
    if (!isAbsolute(path)) throw new SettingsError(`${what} must be an absolute path: ${path}`);
  }
  const home = realPath(settings.home);
  const worktreeRoot = realPath(settings.worktreeRoot);
  if (inside(worktreeRoot, home) || inside(home, worktreeRoot)) {
    throw new SettingsError("the worktree root and the board home must not contain each other");
  }
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65_535) {
    throw new SettingsError(`port ${settings.port} is not a TCP port`);
  }
  const names = Object.keys(settings.repos);
  if (names.length === 0) throw new SettingsError("no repository is listed in repos");
  for (const name of names) checkRepo(name, settings.repos[name] as RepoSetting, home);
  return { ...settings, home, worktreeRoot };
}

/** The board's port as config/myshape-port gives it, else the board's default 47819. */
export function boardPort(home: string): number {
  let text: string;
  try {
    text = readFileSync(join(home, "config", "myshape-port"), "utf8");
  } catch {
    return 47_819;
  }
  const port = Number(text.trim());
  if (!Number.isInteger(port)) throw new SettingsError(`config/myshape-port holds ${text.trim()}`);
  return port;
}

export const LOCK_NAME = ".claude-agg-supervisor.lock";

/**
 * Takes the lock in the worktree root for process `pid`; a lock left by a
 * process `isAlive` says is gone is taken over.
 *
 * Returns:
 *   A function that gives the lock back.
 *
 * Raises:
 *   SettingsError: another supervisor holds it.
 */
export function takeLock(root: string, pid: number, isAlive: (pid: number) => boolean): () => void {
  const path = join(root, LOCK_NAME);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, `${pid}\n`);
      closeSync(fd);
      return () => unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = Number(readFileSync(path, "utf8").trim());
    if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) {
      throw new SettingsError(`another supervisor (pid ${holder}) holds ${path}`);
    }
    unlinkSync(path);
  }
  throw new SettingsError(`could not take ${path}`);
}
