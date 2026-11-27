// The plugin every worker session loads (plan sections 2.2 and 2.3):
// adapters/claude-agg/plugin/ of the checkout the supervisor runs from, with
// the workers' rules (the worker skill) and the status skill for whoever runs
// the supervisor. It carries skills only. The guard stays the SDK's in-process
// callback and every allow rule stays in session-options.ts, so the plugin
// may declare no hooks, MCP servers, agents, commands or anything else, and
// its skills may grant no tool and run no shell command when loaded.
// checkPlugin holds it to exactly that, once at start, before any session.

import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import type { InitMessage } from "./sdk.js";

/** The plugin's name in its manifest: also the board name of this aggregator. */
export const PLUGIN_NAME = "claude-agg";
export const WORKER_SKILL_NAME = "claude-agg-worker";
export const STATUS_SKILL_NAME = "claude-agg-status";
/** The skills as a session names them: `<plugin>:<skill directory>`. */
export const WORKER_SKILL = `${PLUGIN_NAME}:${WORKER_SKILL_NAME}`;
export const STATUS_SKILL = `${PLUGIN_NAME}:${STATUS_SKILL_NAME}`;

/** The plugin of this checkout: src/supervisor/ and dist/supervisor/ both lie two levels below the package. */
export const PLUGIN_DIR = resolve(import.meta.dirname, "..", "..", "plugin");

const MANIFEST = ".claude-plugin/plugin.json";
const MANIFEST_KEYS = new Set(["name", "description"]);
const SKILL_KEYS = new Set(["name", "description"]);
const SKILL_NAMES = [WORKER_SKILL_NAME, STATUS_SKILL_NAME];

/** Every file the plugin holds, and nothing else. */
export const PLUGIN_FILES = [MANIFEST, ...SKILL_NAMES.map((name) => `skills/${name}/SKILL.md`)];

/**
 * Skill text that runs a shell command when the skill loads: `!` and a
 * backquote, either way round, covers the inline form and the fenced block.
 */
const SHELL_IN_SKILL = /!`|`!/;

export class PluginError extends Error {
  constructor(problem: string) {
    super(`claude-agg plugin: ${problem}`);
    this.name = "PluginError";
  }
}

/** The files under `dir`, relative to it; any entry that is not a directory or a regular file is refused. */
function listFiles(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listFiles(dir, path));
    } else if (entry.isFile()) {
      files.push(path);
    } else {
      throw new PluginError(`${path} is not a regular file or directory (a link is refused)`);
    }
  }
  return files;
}

function checkFiles(dir: string): void {
  const files = listFiles(dir);
  const extra = files.filter((file) => !PLUGIN_FILES.includes(file));
  if (extra.length > 0) {
    throw new PluginError(`${extra.join(", ")} not allowed: the plugin carries two skills only`);
  }
  const missing = PLUGIN_FILES.filter((file) => !files.includes(file));
  if (missing.length > 0) throw new PluginError(`${missing.join(", ")} missing in ${dir}`);
}

function checkKeys(what: string, keys: readonly string[], allowed: ReadonlySet<string>): void {
  const other = keys.filter((key) => !allowed.has(key));
  if (other.length > 0) throw new PluginError(`${what} declares ${other.join(", ")}`);
}

function checkManifest(text: string): void {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new PluginError(`${MANIFEST} is not JSON`);
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new PluginError(`${MANIFEST} is not a JSON object`);
  }
  checkKeys(MANIFEST, Object.keys(manifest), MANIFEST_KEYS);
  if ((manifest as Record<string, unknown>)["name"] !== PLUGIN_NAME) {
    throw new PluginError(`${MANIFEST} must name the plugin ${PLUGIN_NAME}`);
  }
}

/** A SKILL.md's frontmatter as key and value, one `key: value` line each. */
function frontmatter(path: string, text: string): Map<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (match === null) throw new PluginError(`${path} has no frontmatter`);
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? "").split("\n")) {
    const field = /^([A-Za-z][\w-]*): (\S.*)$/.exec(line);
    if (field === null) throw new PluginError(`${path}: cannot read frontmatter line ${line}`);
    fields.set(field[1] ?? "", field[2] ?? "");
  }
  return fields;
}

function checkSkill(name: string, text: string): void {
  const path = `skills/${name}/SKILL.md`;
  const fields = frontmatter(path, text);
  checkKeys(path, [...fields.keys()], SKILL_KEYS);
  if (fields.get("name") !== name) throw new PluginError(`${path} must be named ${name}`);
  if (!fields.has("description")) throw new PluginError(`${path} has no description`);
  if (SHELL_IN_SKILL.test(text)) {
    throw new PluginError(`${path} holds a shell command that would run when it loads`);
  }
}

/**
 * Checks the plugin directory `dir` and resolves it, once at start.
 *
 * Returns:
 *   The directory with its links resolved: the one path every worker loads.
 *
 * Raises:
 *   PluginError: `dir` is missing, a link or not a directory; it holds a link,
 *     any file but PLUGIN_FILES, or none of one; its manifest declares
 *     anything but its name and description, or another name; a skill's
 *     frontmatter declares anything but its name and description, or the
 *     skill holds a shell command that runs when it loads.
 */
export function checkPlugin(dir: string): string {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    throw new PluginError(`cannot read ${dir}: ${(error as Error).message}`);
  }
  if (stat.isSymbolicLink()) throw new PluginError(`${dir} is a symbolic link`);
  if (!stat.isDirectory()) throw new PluginError(`${dir} is not a directory`);
  const real = realpathSync(dir);
  checkFiles(real);
  checkManifest(readFileSync(join(real, MANIFEST), "utf8"));
  for (const name of SKILL_NAMES) {
    checkSkill(name, readFileSync(join(real, "skills", name, "SKILL.md"), "utf8"));
  }
  return real;
}

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir === "/" ? "/" : `${dir}/`);
}

/**
 * Refuses a plugin path that lies in, or holds, any of `places` (the board
 * home, the worktree root, each listed repository's main checkout), all
 * absolute with links resolved: a worker, or the repository it works on,
 * must never supply what every worker loads.
 *
 * Raises:
 *   PluginError: naming the place.
 */
export function checkPluginPlace(
  plugin: string,
  places: readonly (readonly [what: string, path: string])[],
): void {
  for (const [what, path] of places) {
    if (within(plugin, path) || within(path, plugin)) {
      throw new PluginError(
        `${plugin} must lie outside ${what} (${path}): run the supervisor from another checkout`,
      );
    }
  }
}

/**
 * What a worker's start message does not show loaded: the plugin by its name
 * at `path`, and each of its skills by its full name; and the plugin's load
 * errors, by type. Empty when everything is there.
 */
export function missingFromInit(init: InitMessage, path: string): string[] {
  const missing: string[] = [];
  const row = init.plugins.some((plugin) => plugin.name === PLUGIN_NAME && plugin.path === path);
  if (!row) missing.push(`plugin ${PLUGIN_NAME}（${path}）`);
  for (const skill of [WORKER_SKILL, STATUS_SKILL]) {
    if (!init.skills.includes(skill)) missing.push(`skill ${skill}`);
  }
  const errors = init.pluginErrors.filter(
    (error) =>
      error.path === path ||
      error.plugin === PLUGIN_NAME ||
      error.plugin.startsWith(`${PLUGIN_NAME}@`),
  );
  for (const error of errors) {
    missing.push(`載入錯誤 ${error.type.replaceAll(/[^\w-]/g, "").slice(0, 64)}`);
  }
  return missing;
}
