import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serveBoard } from "./http.js";
import type { ApiReply, HttpOptions } from "./http.js";
import { remoteAccess } from "./remote.js";
import type { RemoteAccess } from "./remote.js";

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

function boardOptions(remote: RemoteAccess | null): HttpOptions {
  return {
    port,
    tokenFile: path.join(dir, "token"),
    assetDirs: [path.join(dir, "public"), path.join(dir, "page"), path.join(dir, "missing")],
    indexFile: path.join(dir, "public", "index.html"),
    remote,
    api: async (method, route, query, body) => {
      apiCalls.push({ method, route, query: query.toString(), body });
      if (apiReply instanceof Error) throw apiReply;
      return apiReply;
    },
    onRejected: (reason, req) => rejected.push({ reason, url: req.url }),
  };
}

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
  serveBoard(server, boardOptions(null));
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

const REMOTE = "board-pc.example-tailnet.ts.net";
const LOGIN = "captain@example.com";

/** The headers tailscale serve sends for the captain's own phone on the tailnet. */
const phone = (extra: Record<string, string> = {}): Record<string, string> => ({
  "X-Forwarded-Host": REMOTE,
  "X-Forwarded-Proto": "https",
  "Tailscale-User-Login": LOGIN,
  ...extra,
});
const phoneChange = (extra: Record<string, string> = {}): Record<string, string> =>
  phone({ ...auth, Origin: `https://${REMOTE}`, "Content-Type": "application/json", ...extra });
const phoneRequest = (
  options: { method?: string; path?: string; headers?: Record<string, string>; host?: string },
  body?: string,
): Promise<Reply> =>
  request({ host: REMOTE, headers: phone(), ...options, ...(body === undefined ? {} : { body }) });
const phonePost = (path_: string, headers = phoneChange(), body = "{}"): Promise<Reply> =>
  phoneRequest({ method: "POST", path: path_, headers }, body);

describe("the remote name, without a settings file", () => {
  it("refuses the ts.net name and anything forwarded, exactly as before", async () => {
    expect((await phoneRequest({})).status).toBe(403);
    expect((await phonePost("/api/messages")).status).toBe(403);
    const local = `127.0.0.1:${port}`;
    const forwarded = phone({ ...auth, "X-Forwarded-Host": local });
    expect((await request({ host: local, path: "/api/state", headers: forwarded })).status).toBe(
      403,
    );
    expect(rejected.map((entry) => entry.reason)).toEqual([
      "host is not this board",
      "host is not this board",
      "forwarded request names a local host",
    ]);
    expect(apiCalls).toEqual([]);
  });
});

describe("the remote name, with a malformed settings file", () => {
  afterAll(() => serveBoard(server, boardOptions(null)));

  it("refuses the remote name and keeps the PC's own names", async () => {
    const file = path.join(dir, "myshape-remote.json");
    fs.writeFileSync(file, JSON.stringify({ host: `https://${REMOTE}`, login: LOGIN }));
    const lines: string[] = [];
    serveBoard(server, boardOptions(remoteAccess(file, (line) => lines.push(line))));
    expect(lines).toHaveLength(1);
    expect((await phoneRequest({})).status).toBe(403);
    expect((await request({})).status).toBe(200);
    expect(rejected.map((entry) => entry.reason)).toEqual(["host is not this board"]);
  });
});

describe("the remote name, with a settings file", () => {
  beforeAll(() => serveBoard(server, boardOptions({ host: REMOTE, login: LOGIN })));
  afterAll(() => serveBoard(server, boardOptions(null)));

  it("serves the page, reads and changes for the captain's own Tailscale login", async () => {
    expect((await phoneRequest({})).status).toBe(200);
    expect((await phoneRequest({ headers: phone({ Origin: `https://${REMOTE}` }) })).status).toBe(
      200,
    );
    const read = await phoneRequest({ path: "/api/state?v=x", headers: phone(auth) });
    expect(read.status).toBe(200);
    for (const route of ["messages", "direct", "holds/answer"]) {
      expect((await phonePost(`/api/${route}`, phoneChange(), '{"a":1}')).status).toBe(200);
    }
    expect(apiCalls.map((call) => `${call.method} ${call.route}`)).toEqual([
      "GET state",
      "POST messages",
      "POST direct",
      "POST holds/answer",
    ]);
    expect(rejected).toEqual([]);
  });

  it("keeps the token check: no token or a wrong one is 401", async () => {
    expect((await phoneRequest({ path: "/api/state" })).status).toBe(401);
    const wrong = phone({ Authorization: `Bearer ${"b".repeat(64)}` });
    expect((await phoneRequest({ path: "/api/state", headers: wrong })).status).toBe(401);
    expect(rejected.every((entry) => entry.reason === "missing or wrong token")).toBe(true);
    expect(apiCalls).toEqual([]);
  });

  it("refuses any other name, a port on the name, or a forwarded request under a local name", async () => {
    for (const host of [
      `${REMOTE}:8443`,
      `${REMOTE}:443`,
      "other.example-tailnet.ts.net",
      "Board-PC.example-tailnet.ts.net",
      `${REMOTE}.`,
      `x.${REMOTE}`,
    ]) {
      expect(`${host} ${(await phoneRequest({ host })).status}`).toBe(`${host} 403`);
    }
    expect(rejected.every((entry) => entry.reason === "host is not this board")).toBe(true);
    rejected = [];
    // tailscale serve picks its target by the TLS name and passes the client's Host
    // through, so a client on the tailnet can claim a local name; X-Forwarded-Host gives it away.
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      const headers = phone({ ...auth, "X-Forwarded-Host": host });
      expect((await request({ host, path: "/api/state", headers })).status).toBe(403);
      const confirm = phoneChange({ "X-Forwarded-Host": host, Origin: `http://${host}` });
      expect(
        (
          await request({
            host,
            method: "POST",
            path: "/api/programs/confirm",
            headers: confirm,
            body: "{}",
          })
        ).status,
      ).toBe(403);
    }
    expect(rejected.map((entry) => entry.reason)).toEqual(
      Array(4).fill("forwarded request names a local host"),
    );
    expect(apiCalls).toEqual([]);
  });

  it("pairs each name with its own origin only", async () => {
    const origins = [
      `http://${REMOTE}`,
      `https://${REMOTE}:8443`,
      `https://${REMOTE}/`,
      "https://other.example-tailnet.ts.net",
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      "null",
    ];
    for (const origin of origins) {
      expect((await phonePost("/api/messages", phoneChange({ Origin: origin }))).status).toBe(403);
      expect((await phoneRequest({ headers: phone({ Origin: origin }) })).status).toBe(403);
    }
    const noOrigin = phoneChange();
    delete noOrigin["Origin"];
    expect((await phonePost("/api/messages", noOrigin)).status).toBe(403);
    expect(
      (await post("/api/messages", "{}", change({ Origin: `https://${REMOTE}` }))).status,
    ).toBe(403);
    expect(rejected.every((entry) => entry.reason === "origin is not this board")).toBe(true);
    expect(rejected).toHaveLength(origins.length * 2 + 2);
    expect(apiCalls).toEqual([]);
  });

  it("refuses a request without the captain's Tailscale login", async () => {
    const noLogin = phone();
    delete noLogin["Tailscale-User-Login"];
    expect((await phoneRequest({ headers: noLogin })).status).toBe(403);
    for (const login of ["someone@example.com", "Captain@example.com", "", `${LOGIN}, ${LOGIN}`]) {
      const headers = phone({ "Tailscale-User-Login": login });
      expect(`${login} ${(await phoneRequest({ headers })).status}`).toBe(`${login} 403`);
    }
    const copies = await new Promise<string>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () =>
        socket.write(
          `GET / HTTP/1.1\r\nHost: ${REMOTE}\r\nTailscale-User-Login: ${LOGIN}\r\n` +
            `Tailscale-User-Login: ${LOGIN}\r\nConnection: close\r\n\r\n`,
        ),
      );
      let received = "";
      socket.on("data", (chunk) => (received += chunk.toString("utf8")));
      socket.on("close", () => resolve(received));
    });
    expect(copies.startsWith("HTTP/1.1 403")).toBe(true);
    expect(rejected.map((entry) => entry.reason)).toEqual([
      "no Tailscale login",
      ...Array(5).fill("Tailscale login is not the captain's"),
    ]);
    expect(apiCalls).toEqual([]);
  });

  it("refuses a request that came through Funnel, whatever else it carries", async () => {
    for (const value of ["?1", "", "?0"]) {
      const headers = phone({ ...auth, "Tailscale-Funnel-Request": value });
      expect((await phoneRequest({ path: "/api/state", headers })).status).toBe(403);
    }
    expect(
      (await phoneRequest({ headers: phone({ "Tailscale-Funnel-Request": "?1" }) })).status,
    ).toBe(403);
    expect(rejected.map((entry) => entry.reason)).toEqual(Array(4).fill("Funnel request"));
    expect(apiCalls).toEqual([]);
  });

  it("keeps the program confirmation on the PC: both steps under the remote name are 403", async () => {
    expect(
      (await phonePost("/api/programs/confirm", phoneChange(), '{"role":"feed"}')).status,
    ).toBe(403);
    const second = '{"role":"feed","confirm":"c-1"}';
    expect((await phonePost("/api/programs/confirm", phoneChange(), second)).status).toBe(403);
    expect((await phonePost("/api/./programs/confirm", phoneChange(), second)).status).toBe(403);
    expect(rejected.map((entry) => entry.reason)).toEqual(
      Array(3).fill("program confirmation is only on the PC"),
    );
    expect(apiCalls).toEqual([]);
    expect((await post("/api/programs/confirm", '{"role":"feed"}')).status).toBe(200);
    expect(apiCalls.map((call) => call.route)).toEqual(["programs/confirm"]);
  });

  it("leaves the PC's own names as they were", async () => {
    expect((await request({})).status).toBe(200);
    expect((await post("/api/messages", "{}")).status).toBe(200);
    expect(
      (await post("/api/messages", "{}", change({ Origin: `http://localhost:${port}` }))).status,
    ).toBe(200);
    expect(rejected).toEqual([]);
  });
});
