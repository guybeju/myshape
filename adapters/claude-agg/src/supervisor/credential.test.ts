import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { CANARY } from "./harness.test-helper.js";
import { type AuthMode, CredentialFileError, readCredentialFile, redactor } from "./credential.js";

const dir = mkdtempSync(join(tmpdir(), "claude-agg-token-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const uid = process.getuid?.() ?? 0;
let n = 0;

function tokenFile(text: string, mode = 0o600): string {
  n += 1;
  const path = join(dir, `env-${n}`);
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
}

function problem(path: string, owner = uid, mode: AuthMode = "subscription-token"): string {
  try {
    readCredentialFile(path, owner, mode);
  } catch (error) {
    expect(error).toBeInstanceOf(CredentialFileError);
    return (error as Error).message;
  }
  throw new Error("no error");
}

describe("readCredentialFile", () => {
  it("reads the subscription token's one line", () => {
    const sub = "subscription-token";
    expect(readCredentialFile(tokenFile(`CLAUDE_CODE_OAUTH_TOKEN=${CANARY}\n`), uid, sub)).toEqual({
      mode: sub,
      secret: CANARY,
    });
    const readOnly = tokenFile(`CLAUDE_CODE_OAUTH_TOKEN=${CANARY}`, 0o400);
    expect(readCredentialFile(readOnly, uid, sub).secret).toBe(CANARY);
  });

  it("reads an API key's one line", () => {
    const file = tokenFile(`ANTHROPIC_API_KEY=${CANARY}\n`);
    expect(readCredentialFile(file, uid, "api-key")).toEqual({ mode: "api-key", secret: CANARY });
  });

  it("refuses the other mode's line", () => {
    const key = tokenFile(`ANTHROPIC_API_KEY=${CANARY}\n`);
    expect(problem(key)).toContain("must hold exactly one line CLAUDE_CODE_OAUTH_TOKEN=<value>");
    const token = tokenFile(`CLAUDE_CODE_OAUTH_TOKEN=${CANARY}\n`);
    expect(problem(token, uid, "api-key")).toContain(
      "must hold exactly one line ANTHROPIC_API_KEY=<value>",
    );
  });

  it.each([0o640, 0o604, 0o660])("refuses mode %o and says how to fix it", (mode) => {
    const message = problem(tokenFile(`CLAUDE_CODE_OAUTH_TOKEN=${CANARY}\n`, mode));
    expect(message).toContain("chmod 600");
    expect(message).not.toContain(CANARY);
  });

  it("refuses another owner", () => {
    expect(problem(tokenFile(`CLAUDE_CODE_OAUTH_TOKEN=${CANARY}\n`), uid + 1)).toContain(
      "is owned by",
    );
  });

  it("refuses a symbolic link, a missing file and a directory", () => {
    const target = tokenFile(`CLAUDE_CODE_OAUTH_TOKEN=${CANARY}\n`);
    const link = join(dir, "link");
    symlinkSync(target, link);
    expect(problem(link)).toContain("cannot be opened (ELOOP)");
    expect(problem(join(dir, "missing"))).toContain("ENOENT");
    expect(problem(dir)).toContain("not a regular file");
  });

  it.each([
    "",
    `ANTHROPIC_API_KEY=${CANARY}\n`,
    `CLAUDE_CODE_OAUTH_TOKEN=${CANARY}\nOTHER=1\n`,
    `CLAUDE_CODE_OAUTH_TOKEN= ${CANARY}\n`,
    "CLAUDE_CODE_OAUTH_TOKEN=\n",
  ])("refuses content %j without repeating it", (text) => {
    const message = problem(tokenFile(text));
    expect(message).toContain("must hold exactly one line CLAUDE_CODE_OAUTH_TOKEN=<value>");
    expect(message).not.toContain(CANARY);
  });
});

describe("redactor", () => {
  it("takes out every copy", () => {
    expect(redactor(CANARY)(`a ${CANARY} b ${CANARY}`)).toBe("a [redacted] b [redacted]");
  });

  it("needs a secret", () => {
    expect(() => redactor("")).toThrow("non-empty");
  });
});
