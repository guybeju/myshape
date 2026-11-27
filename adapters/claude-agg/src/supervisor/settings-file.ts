// The supervisor's settings file: one JSON object, read once at start. It
// names the program the supervisor runs (the board's command) and the
// repositories whose committed .claude/ hooks run in worker sessions, so it
// gets the credential file's checks: a regular file, no symbolic link, owned
// by whoever runs the supervisor, mode 0600 or stricter.

import { AUTH_VARIABLE, readPrivateFile, type AuthMode } from "./credential.js";
import { boardPort, SettingsError, type RepoSetting, type Settings } from "./settings.js";

/** The settings and the credential mode the file selects. */
export interface SettingsFile {
  settings: Settings;
  auth: AuthMode;
}

const KEYS = new Set([
  "v",
  "home",
  "worktreeRoot",
  "boardCommand",
  "repos",
  "model",
  "auth",
  "credentialFile",
  "readPaths",
]);
const REPO_KEYS = new Set(["path", "base", "defaultBranch"]);

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Json, keys: ReadonlySet<string>, where: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new SettingsError(`${where}: unknown key ${JSON.stringify(key)}`);
  }
}

function text(value: Json, key: string, where = "the settings"): string {
  const found = value[key];
  if (typeof found !== "string" || found === "") {
    throw new SettingsError(`${where}: ${key} must be a non-empty string`);
  }
  return found;
}

function repos(value: unknown): Record<string, RepoSetting> {
  if (!isRecord(value)) throw new SettingsError("repos must be an object of repositories");
  const parsed: Record<string, RepoSetting> = {};
  for (const [name, repo] of Object.entries(value)) {
    const where = `repo ${name}`;
    if (!isRecord(repo)) throw new SettingsError(`${where} must be an object`);
    onlyKeys(repo, REPO_KEYS, where);
    parsed[name] = {
      path: text(repo, "path", where),
      base: text(repo, "base", where),
      defaultBranch: text(repo, "defaultBranch", where),
    };
  }
  return parsed;
}

function authMode(value: unknown): AuthMode {
  if (value === "api-key" || value === "subscription-token") return value;
  const modes = Object.keys(AUTH_VARIABLE).join(" or ");
  throw new SettingsError(`auth must be ${modes}`);
}

function readPaths(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((path) => typeof path === "string")) {
    throw new SettingsError("readPaths must be a list of paths");
  }
  return value;
}

function model(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") {
    throw new SettingsError("model must be a non-empty string when it is set");
  }
  return value;
}

/**
 * The settings in the JSON text `source`, before checkSettings: every key
 * known and of its type, `v` 1. The port is the board home's
 * config/myshape-port.
 *
 * Raises:
 *   SettingsError: text that is not such an object.
 */
export function parseSettings(source: string): SettingsFile {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new SettingsError("the settings file is not JSON");
  }
  if (!isRecord(value)) throw new SettingsError("the settings file must hold one JSON object");
  onlyKeys(value, KEYS, "the settings");
  if (value["v"] !== 1) throw new SettingsError("v must be 1");
  const home = text(value, "home");
  const settings: Settings = {
    home,
    worktreeRoot: text(value, "worktreeRoot"),
    boardCommand: text(value, "boardCommand"),
    port: boardPort(home),
    repos: repos(value["repos"]),
    model: model(value["model"]),
    credentialFile: text(value, "credentialFile"),
    readPaths: readPaths(value["readPaths"]),
  };
  return { settings, auth: authMode(value["auth"]) };
}

/**
 * The settings file at `path`, read with the credential file's checks for
 * the user `uid` and parsed.
 *
 * Raises:
 *   CredentialFileError: the file is missing, a link, or not private.
 *   SettingsError: its content is not valid settings.
 */
export function readSettingsFile(path: string, uid: number): SettingsFile {
  return parseSettings(readPrivateFile(path, uid));
}
