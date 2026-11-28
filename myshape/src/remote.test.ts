import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { remoteAccess, readRemoteSetting } from "./remote.js";

const HOST = "board-pc.example-tailnet.ts.net";
const LOGIN = "captain@example.com";
let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-remote-"));
  file = path.join(dir, "myshape-remote.json");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(text: string): void {
  fs.writeFileSync(file, text);
}

function reasonFor(text: string): string {
  write(text);
  const setting = readRemoteSetting(file);
  if (setting.kind !== "broken") throw new Error(`expected broken, got ${setting.kind}`);
  return setting.reason;
}

describe("the remote access settings file", () => {
  it("is off when the file is absent, empty or only whitespace", () => {
    expect(readRemoteSetting(file)).toEqual({ kind: "off" });
    write("");
    expect(readRemoteSetting(file)).toEqual({ kind: "off" });
    write(" \n\t\n");
    expect(readRemoteSetting(file)).toEqual({ kind: "off" });
  });

  it("names exactly one host and one login", () => {
    write(`${JSON.stringify({ host: HOST, login: LOGIN })}\n`);
    expect(readRemoteSetting(file)).toEqual({ kind: "on", access: { host: HOST, login: LOGIN } });
  });

  it("is broken, with the reason, when it is not one JSON object", () => {
    expect(reasonFor("{")).toContain("不是 JSON");
    expect(reasonFor(JSON.stringify([HOST]))).toContain("JSON 物件");
    expect(reasonFor("null")).toContain("JSON 物件");
  });

  it("is broken when a key is missing, extra, or not text", () => {
    expect(reasonFor(JSON.stringify({ host: HOST }))).toContain("host 與 login");
    expect(reasonFor(JSON.stringify({ host: HOST, login: LOGIN, port: 443 }))).toContain(
      "host 與 login",
    );
    expect(reasonFor(JSON.stringify({ host: HOST, login: 7 }))).toContain("host 與 login");
    expect(reasonFor(JSON.stringify({ host: [HOST], login: LOGIN }))).toContain("host 與 login");
  });

  it("takes only a full lowercase ts.net name: no scheme, port, wildcard, list or IP", () => {
    const bad = [
      `https://${HOST}`,
      `${HOST}:443`,
      `*.example-tailnet.ts.net`,
      `${HOST},other.example-tailnet.ts.net`,
      "Board-PC.example-tailnet.ts.net",
      "board-pc.ts.net",
      "board-pc",
      "example.com",
      "100.70.114.12",
      "localhost",
      `${HOST}.`,
      "-board.example-tailnet.ts.net",
      "",
    ];
    for (const host of bad) {
      expect(reasonFor(JSON.stringify({ host, login: LOGIN })), host).toContain("ts.net");
    }
  });

  it("takes only a login of printable ASCII without spaces", () => {
    for (const login of ["", "captain @example.com", "cañate@example.com", "a\tb"]) {
      expect(reasonFor(JSON.stringify({ host: HOST, login })), login).toContain("login");
    }
  });

  it("is broken when the path cannot be read as a file", () => {
    fs.mkdirSync(file);
    expect(readRemoteSetting(file)).toMatchObject({ kind: "broken" });
  });
});

describe("remoteAccess", () => {
  it("logs and returns the access when on, logs nothing when off", () => {
    const lines: string[] = [];
    expect(remoteAccess(file, (line) => lines.push(line))).toBeNull();
    expect(lines).toEqual([]);
    write(JSON.stringify({ host: HOST, login: LOGIN }));
    expect(remoteAccess(file, (line) => lines.push(line))).toEqual({ host: HOST, login: LOGIN });
    expect(lines).toEqual([`remote access on for ${HOST}`]);
  });

  it("refuses every remote request when broken, and says why in the log", () => {
    const lines: string[] = [];
    write("{");
    expect(remoteAccess(file, (line) => lines.push(line))).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^remote access off: .*myshape-remote\.json.*不是 JSON/);
  });
});
