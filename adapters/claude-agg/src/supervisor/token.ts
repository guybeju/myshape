// The subscription token sessions authenticate with (plan section 5.3, D3).
// The captain makes it with `claude setup-token` and puts it in a file only
// they can read; the supervisor reads that file once, at start, hands the
// value only to the `query()` environment, and takes it out of every text it
// writes anywhere else.

import { constants, fstatSync, openSync, readFileSync, closeSync } from "node:fs";

export const TOKEN_NAME = "CLAUDE_CODE_OAUTH_TOKEN";
export const REDACTED = "[redacted]";

/** Why the token file cannot be used. The message never holds the file's content. */
export class TokenFileError extends Error {
  constructor(path: string, problem: string) {
    super(`${path}: ${problem}`);
    this.name = "TokenFileError";
  }
}

const LINE = new RegExp(`^${TOKEN_NAME}=(\\S+)$`);

/**
 * The token in `path`: a regular file, not a symbolic link, owned by this
 * user and readable by no one else (mode 0600 or stricter), holding one line
 * `CLAUDE_CODE_OAUTH_TOKEN=<token>`.
 *
 * Raises:
 *   TokenFileError: when the file is missing, has the wrong kind, owner or
 *     mode, or does not hold exactly that one line.
 */
export function readTokenFile(path: string, uid: number): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw new TokenFileError(path, `cannot be opened (${code}); it must be a regular file`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new TokenFileError(path, "is not a regular file");
    if (stat.uid !== uid) throw new TokenFileError(path, `is owned by uid ${stat.uid}, not ${uid}`);
    if ((stat.mode & 0o077) !== 0) {
      const mode = (stat.mode & 0o777).toString(8).padStart(4, "0");
      throw new TokenFileError(path, `has mode ${mode}; run chmod 600 on it`);
    }
    const lines = readFileSync(fd, "utf8")
      .split("\n")
      .filter((line) => line !== "");
    const match = lines.length === 1 ? LINE.exec(lines[0] ?? "") : null;
    if (match?.[1] === undefined) {
      throw new TokenFileError(path, `must hold exactly one line ${TOKEN_NAME}=<token>`);
    }
    return match[1];
  } finally {
    closeSync(fd);
  }
}

/** A function that replaces every copy of `secret` in a text with `[redacted]`. */
export function redactor(secret: string): (text: string) => string {
  if (secret === "") throw new Error("redactor needs a non-empty secret");
  return (text) => text.replaceAll(secret, REDACTED);
}
