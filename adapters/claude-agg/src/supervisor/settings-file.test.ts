import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { CredentialFileError } from "./credential.js";
import { parseSettings, readSettingsFile } from "./settings-file.js";
import { SettingsError } from "./settings.js";

const dir = mkdtempSync(join(tmpdir(), "claude-agg-settings-file-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const home = join(dir, "home");
mkdirSync(join(home, "config"), { recursive: true });
writeFileSync(join(home, "config", "myshape-port"), "47829\n");
const uid = process.getuid?.() ?? 0;

const GOOD = {
  v: 1,
  home,
  worktreeRoot: "/work",
  boardCommand: "/checkout/bin/myshape.sh",
  repos: { app: { path: "/repos/app", base: "origin/main", defaultBranch: "main" } },
  auth: "api-key",
  credentialFile: "/secrets/claude-agg/key",
};

function problem(value: unknown): string {
  try {
    parseSettings(typeof value === "string" ? value : JSON.stringify(value));
  } catch (error) {
    expect(error).toBeInstanceOf(SettingsError);
    return (error as Error).message;
  }
  throw new Error("no error");
}

describe("parseSettings", () => {
  it("reads every field, the port from the board home, and no model or readPaths when unset", () => {
    expect(parseSettings(JSON.stringify(GOOD))).toEqual({
      auth: "api-key",
      settings: {
        home,
        worktreeRoot: "/work",
        boardCommand: "/checkout/bin/myshape.sh",
        port: 47_829,
        repos: { app: { path: "/repos/app", base: "origin/main", defaultBranch: "main" } },
        model: undefined,
        credentialFile: "/secrets/claude-agg/key",
        readPaths: [],
      },
    });
  });

  it("passes the user's model and read paths as written", () => {
    const parsed = parseSettings(
      JSON.stringify({ ...GOOD, model: "users-choice", readPaths: ["/opt/tools"] }),
    );
    expect(parsed.settings.model).toBe("users-choice");
    expect(parsed.settings.readPaths).toEqual(["/opt/tools"]);
  });

  it("takes the subscription token mode", () => {
    expect(parseSettings(JSON.stringify({ ...GOOD, auth: "subscription-token" })).auth).toBe(
      "subscription-token",
    );
  });

  it.each([
    ["not JSON", "{", "not JSON"],
    ["a list", [], "one JSON object"],
    ["another version", { ...GOOD, v: 2 }, "v must be 1"],
    ["an unknown key", { ...GOOD, port: 1 }, 'unknown key "port"'],
    ["no auth", { ...GOOD, auth: undefined }, "auth must be api-key or subscription-token"],
    ["another auth", { ...GOOD, auth: "login" }, "auth must be"],
    ["no credential file", { ...GOOD, credentialFile: "" }, "credentialFile must be"],
    ["no home", { ...GOOD, home: 3 }, "home must be"],
    ["repos as a list", { ...GOOD, repos: [] }, "repos must be an object"],
    [
      "a repo key",
      { ...GOOD, repos: { a: { ...GOOD.repos.app, x: 1 } } },
      'repo a: unknown key "x"',
    ],
    ["a repo without base", { ...GOOD, repos: { a: { path: "/a", defaultBranch: "m" } } }, "base"],
    ["readPaths of numbers", { ...GOOD, readPaths: [1] }, "readPaths must be a list"],
    ["an empty model", { ...GOOD, model: "" }, "model must be"],
  ])("refuses %s", (_what, value, message) => {
    expect(problem(value)).toContain(message);
  });
});

describe("readSettingsFile", () => {
  it("reads a private file", () => {
    const path = join(dir, "good.json");
    writeFileSync(path, JSON.stringify(GOOD));
    chmodSync(path, 0o600);
    expect(readSettingsFile(path, uid).auth).toBe("api-key");
  });

  it("refuses a file others can read or write", () => {
    const path = join(dir, "open.json");
    writeFileSync(path, JSON.stringify(GOOD));
    chmodSync(path, 0o644);
    expect(() => readSettingsFile(path, uid)).toThrow(CredentialFileError);
    expect(() => readSettingsFile(path, uid)).toThrow("chmod 600");
  });
});
