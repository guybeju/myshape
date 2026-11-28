// The browser's way in. Every request passes the same checks before anything
// else looks at it; a request that fails one gets a 4xx, is recorded, and never
// takes the service down. The checks defend against other web sites in the
// captain's browser (CSRF, DNS rebinding, WebSocket hijacking) and other users
// on the machine. Processes of the same user are out of scope.
//
// Besides the PC's own names the board answers one remote name, the PC's
// ts.net name that `tailscale serve` proxies to this port (remote.ts). A
// request under it must also carry the captain's Tailscale login, which
// tailscaled sets after deleting any copy the client sent, and must not be
// a Funnel request.
import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { CodedError, isRecord } from "./files.js";
import type { RemoteAccess } from "./remote.js";

const MAX_BODY_BYTES = 64 * 1024;
const ASSET_NAME = /^[a-z0-9][a-z0-9.-]*$/;
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

export interface ApiReply {
  status: number;
  body: Record<string, unknown>;
}

export type ApiHandler = (
  method: string,
  route: string,
  query: URLSearchParams,
  body: Record<string, unknown>,
) => Promise<ApiReply>;

export interface HttpOptions {
  port: number;
  tokenFile: string;
  /** Directories whose files are served under /assets/, by bare file name. */
  assetDirs: string[];
  indexFile: string;
  /** The one remote name and login, or null for the PC's own names only. */
  remote: RemoteAccess | null;
  api: ApiHandler;
  /** Records a rejected request; never given the token. */
  onRejected: (reason: string, request: http.IncomingMessage) => void;
}

/** A refused request: `code` is the HTTP status, `message` the reason recorded in the audit log. */
class Rejection extends CodedError {}

function send(
  response: http.ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
): void {
  response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type });
  response.end(body);
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  send(response, status, "application/json; charset=utf-8", JSON.stringify(body));
}

/** The origins and Host values that are this board, and nothing else. */
function ownHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

/**
 * The API routes that perform P-008's confirmation that the board may run a
 * program: they stay on the PC, whatever the remote request carries.
 */
export const PC_ONLY_ROUTES = ["programs/confirm"];

/** How the request reached the board, with the one origin each way allows for a change. */
type Caller = { kind: "pc"; origins: string[] } | { kind: "remote"; origins: string[] };

function headerOf(request: http.IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return value === undefined ? undefined : String(value);
}

/** The checks a request under the remote name passes on top of the token. */
function checkRemote(request: http.IncomingMessage, remote: RemoteAccess): Caller {
  if (headerOf(request, "tailscale-funnel-request") !== undefined)
    throw new Rejection(403, "Funnel request");
  const login = headerOf(request, "tailscale-user-login");
  if (login === undefined) throw new Rejection(403, "no Tailscale login");
  if (login !== remote.login) throw new Rejection(403, "Tailscale login is not the captain's");
  const origin = `https://${remote.host}`;
  const sent = request.headers.origin;
  if (sent !== undefined && sent !== origin) throw new Rejection(403, "origin is not this board");
  return { kind: "remote", origins: [origin] };
}

/**
 * Which way the request came in. tailscale serve picks its target by the TLS
 * name and passes the client's Host through, so a forwarded request (it always
 * carries X-Forwarded-Host) naming a local host is refused rather than trusted.
 */
function callerOf(request: http.IncomingMessage, options: HttpOptions): Caller {
  const host = request.headers.host;
  const local = ownHosts(options.port);
  if (host !== undefined && local.includes(host)) {
    if (headerOf(request, "x-forwarded-host") !== undefined)
      throw new Rejection(403, "forwarded request names a local host");
    return { kind: "pc", origins: local.map((name) => `http://${name}`) };
  }
  if (options.remote === null || host !== options.remote.host)
    throw new Rejection(403, "host is not this board");
  return checkRemote(request, options.remote);
}

function tokenMatches(tokenFile: string, header: string | undefined): boolean {
  const expected = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";
  const presented = header?.startsWith("Bearer ") === true ? header.slice(7) : "";
  if (expected === "" || presented.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

function readBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Rejection(413, "body too large"));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", () => reject(new Rejection(400, "broken request body")));
  });
}

/** The JSON object in a state-changing request, after the Origin and Content-Type checks. */
async function changeBody(
  request: http.IncomingMessage,
  caller: Caller,
): Promise<Record<string, unknown>> {
  const origin = request.headers.origin;
  if (origin === undefined || !caller.origins.includes(origin)) {
    throw new Rejection(403, "origin is not this board");
  }
  const header = request.headers["content-type"];
  const type = header === undefined ? "" : (header.split(";")[0] as string).trim().toLowerCase();
  if (type !== "application/json") throw new Rejection(415, "content type is not application/json");
  const raw = await readBody(request);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Rejection(400, "body is not JSON");
  }
  if (!isRecord(body)) throw new Rejection(400, "body is not a JSON object");
  return body;
}

async function serveApi(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  options: HttpOptions,
  caller: Caller,
): Promise<void> {
  const apiRoute = url.pathname.slice("/api/".length);
  if (caller.kind === "remote" && PC_ONLY_ROUTES.includes(apiRoute))
    throw new Rejection(403, "program confirmation is only on the PC");
  if (!tokenMatches(options.tokenFile, request.headers.authorization))
    throw new Rejection(401, "missing or wrong token");
  const method = String(request.method);
  if (method !== "GET" && method !== "POST") throw new Rejection(405, "method not allowed");
  const body = method === "POST" ? await changeBody(request, caller) : {};
  const reply = await options.api(method, apiRoute, url.searchParams, body);
  sendJson(response, reply.status, reply.body);
}

function contentType(file: string): string {
  const known = CONTENT_TYPES[path.extname(file)];
  return known === undefined ? "application/octet-stream" : known;
}

/** Maps an /assets/ file name to a file in one of the asset directories; no path is ever joined from the URL. */
function findAsset(name: string, assetDirs: string[]): string | null {
  if (!ASSET_NAME.test(name)) return null;
  for (const dir of assetDirs) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).includes(name)) return path.join(dir, name);
  }
  return null;
}

function serveStatic(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  options: HttpOptions,
): void {
  if (request.method !== "GET") throw new Rejection(405, "method not allowed");
  const file =
    url.pathname === "/"
      ? options.indexFile
      : url.pathname.startsWith("/assets/")
        ? findAsset(url.pathname.slice(8), options.assetDirs)
        : null;
  if (file === null || !fs.existsSync(file)) throw new Rejection(404, "not found");
  send(response, 200, contentType(file), fs.readFileSync(file));
}

async function route(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: HttpOptions,
): Promise<void> {
  if (request.headers.upgrade !== undefined) throw new Rejection(400, "upgrade is not supported");
  const caller = callerOf(request, options);
  if (request.method === "OPTIONS") throw new Rejection(405, "preflight is not answered");
  let url: URL;
  try {
    url = new URL(String(request.url), "http://board.invalid");
  } catch {
    throw new Rejection(400, "malformed URL");
  }
  if (url.pathname.startsWith("/api/")) await serveApi(request, response, url, options, caller);
  else serveStatic(request, response, url, options);
}

/** Attaches the board's request handling to `server`. */
export function serveBoard(server: http.Server, options: HttpOptions): void {
  server.removeAllListeners("request");
  server.on("request", (request: http.IncomingMessage, response: http.ServerResponse) => {
    route(request, response, options).catch((error: unknown) => {
      const rejection = error instanceof Rejection ? error : new Rejection(500, "internal error");
      if (rejection.code !== 404) options.onRejected(rejection.message, request);
      if (!response.headersSent)
        sendJson(response, rejection.code, { error: "rejected", message: rejection.message });
      else response.end();
    });
  });
  // A request the HTTP parser itself cannot read (for example a garbled Host line).
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  // An Upgrade request never reaches "request" once this listener exists; refuse it outright.
  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
}
