// The credential sessions authenticate with (plan section 5.3, as changed by
// the captain's 2026-11-27 answers). The documented way to run the adapter is
// an API key, ANTHROPIC_API_KEY; the subscription token CLAUDE_CODE_OAUTH_TOKEN
// stays for the author's own use. Whoever runs the supervisor makes the
// credential and puts it in a file only they can read; the supervisor reads
// that file once, at start, hands the value only to the `query()`
// environment, and takes it out of every text it writes anywhere else.

import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

/** Which credential the settings select. */
export type AuthMode = "api-key" | "subscription-token";

/** The one environment name each mode's credential is handed to a session under. */
export const AUTH_VARIABLE: Readonly<Record<AuthMode, string>> = {
  "api-key": "ANTHROPIC_API_KEY",
  "subscription-token": "CLAUDE_CODE_OAUTH_TOKEN",
};

/**
 * The `apiKeySource` a session's start message must name for each mode: the
 * environment's API key, or none (a claude.ai OAuth token is not an API key).
 */
export const AUTH_SOURCE: Readonly<Record<AuthMode, string>> = {
  "api-key": "ANTHROPIC_API_KEY",
  "subscription-token": "none",
};

export interface Credential {
  mode: AuthMode;
  /** The key or token itself: never written anywhere but a session's environment. */
  secret: string;
}

export const REDACTED = "[redacted]";

/** Why the credential file cannot be used. The message never holds the file's content. */
export class CredentialFileError extends Error {
  constructor(path: string, problem: string) {
    super(`${path}: ${problem}`);
    this.name = "CredentialFileError";
  }
}

/**
 * The open file `fd` at `path`, checked: a regular file owned by `uid` that no
 * one else can read or write (mode 0600 or stricter).
 *
 * Raises:
 *   CredentialFileError: the file has the wrong kind, owner or mode.
 */
export function checkPrivateFile(fd: number, path: string, uid: number): void {
  const stat = fstatSync(fd);
  if (!stat.isFile()) throw new CredentialFileError(path, "is not a regular file");
  if (stat.uid !== uid)
    throw new CredentialFileError(path, `is owned by uid ${stat.uid}, not ${uid}`);
  if ((stat.mode & 0o077) !== 0) {
    const mode = (stat.mode & 0o777).toString(8).padStart(4, "0");
    throw new CredentialFileError(path, `has mode ${mode}; run chmod 600 on it`);
  }
}

/**
 * The text of `path`, opened without following a symbolic link and checked
 * with checkPrivateFile.
 *
 * Raises:
 *   CredentialFileError: the file is missing, a link, or fails the checks.
 */
export function readPrivateFile(path: string, uid: number): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw new CredentialFileError(path, `cannot be opened (${code}); it must be a regular file`);
  }
  try {
    checkPrivateFile(fd, path, uid);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * The credential of `mode` in `path`: a private file (readPrivateFile) holding
 * one line `<name>=<value>`, the name being the mode's AUTH_VARIABLE.
 *
 * Raises:
 *   CredentialFileError: when the file fails readPrivateFile or does not hold
 *     exactly that one line.
 */
export function readCredentialFile(path: string, uid: number, mode: AuthMode): Credential {
  const name = AUTH_VARIABLE[mode];
  const lines = readPrivateFile(path, uid)
    .split("\n")
    .filter((line) => line !== "");
  const match = lines.length === 1 ? new RegExp(`^${name}=(\\S+)$`).exec(lines[0] ?? "") : null;
  if (match?.[1] === undefined) {
    throw new CredentialFileError(path, `must hold exactly one line ${name}=<value>`);
  }
  return { mode, secret: match[1] };
}

/** A function that replaces every copy of `secret` in a text with `[redacted]`. */
export function redactor(secret: string): (text: string) => string {
  if (secret === "") throw new Error("redactor needs a non-empty secret");
  return (text) => text.replaceAll(secret, REDACTED);
}
