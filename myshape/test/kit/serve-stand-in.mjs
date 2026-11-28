// A stand-in for `tailscale serve` on the PC, so a test browser can open the
// board by its remote name (contracts 6.2) without Tailscale. The browser uses
// it as its HTTP proxy; it forwards each request for that one name to the
// board's 127.0.0.1 port with the name as Host, the captain's
// Tailscale-User-Login, and an https Origin, the way serve would. Anything
// else gets 502.
import http from "node:http";

/**
 * Starts the stand-in on 127.0.0.1:`listen`; resolves to the server, which
 * the caller closes.
 *
 * @param {{ listen: number, boardPort: number, host: string, login: string }} options
 * @returns {Promise<http.Server>}
 */
export function serveStandIn({ listen, boardPort, host, login }) {
  const server = http.createServer((request, response) => {
    const refuse = () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    };
    let target;
    try {
      target = new URL(request.url ?? "");
    } catch {
      refuse();
      return;
    }
    if (target.protocol !== "http:" || target.host !== host) {
      refuse();
      return;
    }
    const headers = { ...request.headers, host, "tailscale-user-login": login };
    delete headers["proxy-connection"];
    if (headers.origin !== undefined) headers.origin = `https://${host}`;
    const upstream = http.request(
      { host: "127.0.0.1", port: boardPort, method: request.method, path: `${target.pathname}${target.search}`, headers },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );
    upstream.on("error", refuse);
    request.pipe(upstream);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listen, "127.0.0.1", () => resolve(server));
  });
}
