// The browser's way in. Every request passes the same checks before anything
// else looks at it; a request that fails one gets a 4xx, is recorded, and never
// takes the service down. The checks defend against other web sites in the
// captain's browser (CSRF, DNS rebinding, WebSocket hijacking) and other users
// on the machine. Processes of the same user are out of scope.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CodedError, isRecord } from "./files.js";
const MAX_BODY_BYTES = 64 * 1024;
const ASSET_NAME = /^[a-z0-9][a-z0-9.-]*$/;
const CONTENT_TYPES = {
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
/** A refused request: `code` is the HTTP status, `message` the reason recorded in the audit log. */
class Rejection extends CodedError {
}
function send(response, status, type, body) {
    response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type });
    response.end(body);
}
function sendJson(response, status, body) {
    send(response, status, "application/json; charset=utf-8", JSON.stringify(body));
}
/** The origins and Host values that are this board, and nothing else. */
function ownHosts(port) {
    return [`127.0.0.1:${port}`, `localhost:${port}`];
}
function tokenMatches(tokenFile, header) {
    const expected = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";
    const presented = header?.startsWith("Bearer ") === true ? header.slice(7) : "";
    if (expected === "" || presented.length !== expected.length)
        return false;
    return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}
function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        request.on("data", (chunk) => {
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
async function changeBody(request, options) {
    const origin = request.headers.origin;
    if (origin === undefined || !ownHosts(options.port).some((host) => origin === `http://${host}`)) {
        throw new Rejection(403, "origin is not this board");
    }
    const header = request.headers["content-type"];
    const type = header === undefined ? "" : header.split(";")[0].trim().toLowerCase();
    if (type !== "application/json")
        throw new Rejection(415, "content type is not application/json");
    const raw = await readBody(request);
    let body;
    try {
        body = JSON.parse(raw.toString("utf8"));
    }
    catch {
        throw new Rejection(400, "body is not JSON");
    }
    if (!isRecord(body))
        throw new Rejection(400, "body is not a JSON object");
    return body;
}
async function serveApi(request, response, url, options) {
    if (!tokenMatches(options.tokenFile, request.headers.authorization))
        throw new Rejection(401, "missing or wrong token");
    const method = String(request.method);
    if (method !== "GET" && method !== "POST")
        throw new Rejection(405, "method not allowed");
    const body = method === "POST" ? await changeBody(request, options) : {};
    const reply = await options.api(method, url.pathname.slice("/api/".length), url.searchParams, body);
    sendJson(response, reply.status, reply.body);
}
function contentType(file) {
    const known = CONTENT_TYPES[path.extname(file)];
    return known === undefined ? "application/octet-stream" : known;
}
/** Maps an /assets/ file name to a file in one of the asset directories; no path is ever joined from the URL. */
function findAsset(name, assetDirs) {
    if (!ASSET_NAME.test(name))
        return null;
    for (const dir of assetDirs) {
        if (fs.existsSync(dir) && fs.readdirSync(dir).includes(name))
            return path.join(dir, name);
    }
    return null;
}
function serveStatic(request, response, url, options) {
    if (request.method !== "GET")
        throw new Rejection(405, "method not allowed");
    const file = url.pathname === "/"
        ? options.indexFile
        : url.pathname.startsWith("/assets/")
            ? findAsset(url.pathname.slice(8), options.assetDirs)
            : null;
    if (file === null || !fs.existsSync(file))
        throw new Rejection(404, "not found");
    send(response, 200, contentType(file), fs.readFileSync(file));
}
async function route(request, response, options) {
    if (request.headers.upgrade !== undefined)
        throw new Rejection(400, "upgrade is not supported");
    const host = request.headers.host;
    if (host === undefined || !ownHosts(options.port).includes(host)) {
        throw new Rejection(403, "host is not this board");
    }
    if (request.method === "OPTIONS")
        throw new Rejection(405, "preflight is not answered");
    let url;
    try {
        url = new URL(String(request.url), `http://${host}`);
    }
    catch {
        throw new Rejection(400, "malformed URL");
    }
    if (url.pathname.startsWith("/api/"))
        await serveApi(request, response, url, options);
    else
        serveStatic(request, response, url, options);
}
/** Attaches the board's request handling to `server`. */
export function serveBoard(server, options) {
    server.removeAllListeners("request");
    server.on("request", (request, response) => {
        route(request, response, options).catch((error) => {
            const rejection = error instanceof Rejection ? error : new Rejection(500, "internal error");
            if (rejection.code !== 404)
                options.onRejected(rejection.message, request);
            if (!response.headersSent)
                sendJson(response, rejection.code, { error: "rejected", message: rejection.message });
            else
                response.end();
        });
    });
    // A request the HTTP parser itself cannot read (for example a garbled Host line).
    server.on("clientError", (_error, socket) => {
        if (socket.writable)
            socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });
    // An Upgrade request never reaches "request" once this listener exists; refuse it outright.
    server.on("upgrade", (_request, socket) => {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });
}
