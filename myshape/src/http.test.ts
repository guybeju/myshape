import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serveBoard } from "./http.js";
import type { ApiReply } from "./http.js";

const TOKEN = "a".repeat(64);
let dir: string;
let server: http.Server;
let port: number;
let rejected: { reason: string; url: string | undefined }[];
let apiCalls: { method: string; route: string; query: string; body: Record<string, unknown> }[];
let apiReply: ApiReply | Error;

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(options: {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  host?: string | null;
}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.host !== null) headers["Host"] = options.host ?? `127.0.0.1:${port}`;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path ?? "/",
        headers,
        setHost: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

const auth = { Authorization: `Bearer ${TOKEN}` };
const change = (extra: Record<string, string> = {}): Record<string, string> => ({
  ...auth,
  Origin: `http://127.0.0.1:${port}`,
  "Content-Type": "application/json",
  ...extra,
});
const post = (path_: string, body: string | Buffer, headers = change()): Promise<Reply> =>
  request({ method: "POST", path: path_, headers, body });

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-http-"));
  fs.mkdirSync(path.join(dir, "public"));
  fs.mkdirSync(path.join(dir, "page"));
  fs.writeFileSync(path.join(dir, "public", "index.html"), "<!doctype html><title>board</title>");
  fs.writeFileSync(path.join(dir, "public", "board.css"), "body{}");
  fs.writeFileSync(path.join(dir, "public", "icon.svg"), "<svg/>");
  fs.writeFileSync(path.join(dir, "page", "board.js"), "export {};");
  fs.writeFileSync(path.join(dir, "page", "data.bin"), "bin");
  fs.writeFileSync(path.join(dir, "secret.js"), "SECRET");
  fs.writeFileSync(path.join(dir, "token"), `${TOKEN}\n`);
  server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
  serveBoard(server, {
    port,
    tokenFile: path.join(dir, "token"),
    assetDirs: [path.join(dir, "public"), path.join(dir, "page"), path.join(dir, "missing")],
    indexFile: path.join(dir, "public", "index.html"),
    api: async (method, route, query, body) => {
      apiCalls.push({ method, route, query: query.toString(), body });
      if (apiReply instanceof Error) throw apiReply;
      return apiReply;
    },
    onRejected: (reason, req) => rejected.push({ reason, url: req.url }),
  });
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  rejected = [];
  apiCalls = [];
  apiReply = { status: 200, body: { ok: true } };
  fs.writeFileSync(path.join(dir, "token"), `${TOKEN}\n`);
});

describe("static files", () => {
  it("serves the page and its assets by bare name with the right type, without a token", async () => {
    const index = await request({});
    expect(index).toMatchObject({ status: 200, body: "<!doctype html><title>board</title>" });
    expect(index.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect((await request({ path: "/assets/board.css" })).headers["content-type"]).toBe(
      "text/css; charset=utf-8",
    );
    expect((await request({ path: "/assets/icon.svg" })).headers["content-type"]).toBe(
      "image/svg+xml",
    );
    const script = await request({ path: "/assets/board.js", host: `localhost:${port}` });
    expect(script).toMatchObject({ status: 200, body: "export {};" });
    expect(script.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect((await request({ path: "/assets/data.bin" })).headers["content-type"]).toBe(
      "application/octet-stream",
    );
    expect((await request({ path: "/?x=1" })).status).toBe(200);
    expect(rejected).toEqual([]);
  });

  it("sends the security headers on every response and no CORS header", async () => {
    for (const reply of [
      await request({}),
      await request({ path: "/nope" }),
      await request({ path: "/api/x" }),
      await request({ path: "/api/x", headers: auth }),
    ]) {
      expect(reply.headers["content-security-policy"]).toBe(
        "default-src 'self'; frame-ancestors 'none'",
      );
      expect(reply.headers["x-frame-options"]).toBe("DENY");
      expect(reply.headers["x-content-type-options"]).toBe("nosniff");
      expect(reply.headers["referrer-policy"]).toBe("no-referrer");
      expect(reply.headers["cache-control"]).toBe("no-store");
      expect(
        Object.keys(reply.headers).filter((name) => name.startsWith("access-control")),
      ).toEqual([]);
    }
  });

  it("serves nothing outside the asset directories", async () => {
    for (const target of [
      "/assets/secret.js",
      "/assets/../secret.js",
      "/assets/..%2fsecret.js",
      "/assets/%2e%2e/secret.js",
      "/assets/sub/board.js",
      "/assets/",
      "/assets/.hidden",
      "/assets/Board.js",
      "/assets/index.html/x",
      "/index.html",
      "/secret.js",
      "/assets",
    ]) {
      const reply = await request({ path: target });
      expect(`${target} ${reply.status}`).toBe(`${target} 404`);
      expect(reply.body).not.toContain("SECRET");
    }
    expect(JSON.parse((await request({ path: "/nope" })).body)).toEqual({
      error: "rejected",
      message: "not found",
    });
    expect(rejected).toEqual([]);
    const index = path.join(dir, "public", "index.html");
    fs.renameSync(index, `${index}.away`);
    expect((await request({})).status).toBe(404);
    fs.renameSync(`${index}.away`, index);
    expect((await request({ method: "POST", path: "/" })).status).toBe(405);
    expect((await request({ method: "HEAD", path: "/" })).status).toBe(405);
  });
});

describe("host and method checks", () => {
  it("accepts only its own two host names with its own port", async () => {
    for (const host of [
      "evil.example",
      "127.0.0.1",
      `127.0.0.1:${port + 1}`,
      `localhost:${port}.evil.example`,
      `[::1]:${port}`,
      "",
    ]) {
      const reply = await request({ host });
      expect(`${host} ${reply.status}`).toBe(`${host} 403`);
    }
    expect(
      (await request({ path: "/api/state", headers: auth, host: "evil.example" })).status,
    ).toBe(403);
    expect(rejected.every((entry) => entry.reason === "host is not this board")).toBe(true);
    expect(rejected).toHaveLength(7);
    expect(apiCalls).toEqual([]);
  });

  it("refuses a request that names no host at all", async () => {
    const answer = await new Promise<string>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => socket.write("GET / HTTP/1.0\r\n\r\n"));
      let received = "";
      socket.on("data", (chunk) => (received += chunk.toString("utf8")));
      socket.on("close", () => resolve(received));
    });
    expect(answer.startsWith("HTTP/1.1 403")).toBe(true);
  });

  it("refuses preflight, upgrades, and other methods", async () => {
    expect(
      (
        await request({
          method: "OPTIONS",
          path: "/api/refresh",
          headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "POST" },
        })
      ).status,
    ).toBe(405);
    expect((await request({ method: "OPTIONS" })).status).toBe(405);
    expect(rejected.map((entry) => entry.reason)).toEqual([
      "preflight is not answered",
      "preflight is not answered",
    ]);
    for (const method of ["DELETE", "PUT", "PATCH"]) {
      expect((await request({ method, path: "/api/state", headers: change() })).status).toBe(405);
    }
    expect(apiCalls).toEqual([]);
    const upgrade = await new Promise<string>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () =>
        socket.write(
          `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
        ),
      );
      socket.on("data", (chunk) => resolve(chunk.toString("utf8")));
    });
    expect(upgrade.startsWith("HTTP/1.1 400")).toBe(true);
  });

  it("survives bytes that are not HTTP", async () => {
    for (const garbage of [
      "NOT HTTP AT ALL\r\n\r\n",
      "GET / HTTP/1.1\r\nHost: \u0000bad\r\n\r\n",
    ]) {
      const answer = await new Promise<string>((resolve) => {
        const socket = net.connect(port, "127.0.0.1", () => socket.write(garbage));
        let received = "";
        socket.on("data", (chunk) => (received += chunk.toString("utf8")));
        socket.on("close", () => resolve(received));
      });
      expect(answer.startsWith("HTTP/1.1 400")).toBe(true);
    }
    expect((await request({})).status).toBe(200);
  });
});

describe("the API", () => {
  it("needs the token in the Authorization header for reads and writes alike", async () => {
    for (const headers of [
      {},
      { Authorization: "Bearer wrong" },
      { Authorization: `Bearer ${TOKEN}x` },
      { Authorization: `bearer ${TOKEN}` },
      { Authorization: TOKEN },
      { Authorization: `Bearer ${TOKEN.slice(1)}b` },
      { Cookie: `token=${TOKEN}` },
    ]) {
      expect((await request({ path: "/api/state", headers })).status).toBe(401);
    }
    expect((await request({ path: `/api/state?token=${TOKEN}` })).status).toBe(401);
    expect(
      (
        await post("/api/refresh", "{}", {
          Origin: `http://127.0.0.1:${port}`,
          "Content-Type": "application/json",
        })
      ).status,
    ).toBe(401);
    expect(rejected.every((entry) => entry.reason === "missing or wrong token")).toBe(true);
    expect(apiCalls).toEqual([]);
    fs.writeFileSync(path.join(dir, "token"), "");
    expect(
      (await request({ path: "/api/state", headers: { Authorization: "Bearer " } })).status,
    ).toBe(401);
    fs.rmSync(path.join(dir, "token"));
    expect((await request({ path: "/api/state", headers: auth })).status).toBe(401);
  });

  it("passes a read to the handler with its route and query, and relays the reply", async () => {
    apiReply = { status: 409, body: { error: "refused", message: "不行" } };
    const reply = await request({ path: "/api/topics/x?v=boot:1&w=2", headers: auth });
    expect(reply.status).toBe(409);
    expect(reply.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(JSON.parse(reply.body)).toEqual({ error: "refused", message: "不行" });
    expect(apiCalls).toEqual([
      { method: "GET", route: "topics/x", query: "v=boot%3A1&w=2", body: {} },
    ]);
    expect(rejected).toEqual([]);
  });

  it("accepts a change only from its own origin, as JSON, within the size limit", async () => {
    expect((await post("/api/refresh", '{"a":1}')).status).toBe(200);
    expect(
      (
        await post(
          "/api/refresh",
          '{"b":"中文"}',
          change({
            Origin: `http://localhost:${port}`,
            "Content-Type": "Application/JSON; charset=utf-8",
          }),
        )
      ).status,
    ).toBe(200);
    expect(apiCalls).toEqual([
      { method: "POST", route: "refresh", query: "", body: { a: 1 } },
      { method: "POST", route: "refresh", query: "", body: { b: "中文" } },
    ]);
    apiCalls = [];
    const origins = [
      "null",
      "http://evil.example",
      `http://127.0.0.1:${port + 1}`,
      `https://127.0.0.1:${port}`,
      `http://127.0.0.1:${port}/`,
      `http://127.0.0.1:${port}.evil.example`,
    ];
    for (const origin of origins) {
      expect((await post("/api/refresh", "{}", change({ Origin: origin }))).status).toBe(403);
    }
    expect(
      (await post("/api/refresh", "{}", { ...auth, "Content-Type": "application/json" })).status,
    ).toBe(403);
    expect(rejected.every((entry) => entry.reason === "origin is not this board")).toBe(true);
    rejected = [];
    for (const type of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data",
      "application/jsonx",
      "",
    ]) {
      expect((await post("/api/refresh", "{}", change({ "Content-Type": type }))).status).toBe(415);
    }
    const noType = change();
    delete noType["Content-Type"];
    expect((await post("/api/refresh", "{}", noType)).status).toBe(415);
    for (const body of ["{", "[1]", '"text"', "null", "5", ""]) {
      expect((await post("/api/refresh", body)).status).toBe(400);
    }
    expect(rejected.map((entry) => entry.reason).slice(-6)).toEqual([
      "body is not JSON",
      "body is not a JSON object",
      "body is not a JSON object",
      "body is not a JSON object",
      "body is not a JSON object",
      "body is not JSON",
    ]);
    expect(apiCalls).toEqual([]);
  });

  it("limits the body to 64 KiB", async () => {
    const fits = JSON.stringify({ text: "x".repeat(64 * 1024 - 11) });
    expect(Buffer.byteLength(fits)).toBe(64 * 1024);
    expect((await post("/api/messages", fits)).status).toBe(200);
    expect(
      (await post("/api/messages", JSON.stringify({ text: "x".repeat(64 * 1024 - 10) }))).status,
    ).toBe(413);
    expect(rejected.at(-1)?.reason).toBe("body too large");
    expect(apiCalls).toHaveLength(1);
  });

  it("answers 500 without details when the handler throws, and keeps serving", async () => {
    apiReply = new Error("internal detail");
    const reply = await request({ path: "/api/state", headers: auth });
    expect(reply.status).toBe(500);
    expect(JSON.parse(reply.body)).toEqual({ error: "rejected", message: "internal error" });
    expect(rejected).toEqual([{ reason: "internal error", url: "/api/state" }]);
    apiReply = { status: 200, body: {} };
    expect((await request({ path: "/api/state", headers: auth })).status).toBe(200);
  });
});
