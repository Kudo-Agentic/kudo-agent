import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { createKudoMcpServer, SERVER_NAME, SERVER_VERSION, type KudoMcpOptions } from "./server.js";

export interface HttpOptions extends KudoMcpOptions {
  /** Requests per minute per client IP. Default 60. 0 disables. */
  rateLimitPerMinute?: number;
  /** Origins allowed to call from a browser. Default "*". */
  allowedOrigins?: string[];
}

/**
 * A stateless MCP endpoint over Streamable HTTP, as a web-standard
 * `(Request) => Response` handler. Mount it in any runtime: Node (see
 * `serveHttp`), Next.js route handlers, Cloudflare Workers, Bun, Deno.
 *
 * A hosted endpoint must never sign: anyone can call it. Pass a Kudo client
 * without a wallet, and write tools return unsigned transactions.
 */
export function createKudoMcpHandler(options: HttpOptions): (request: Request, clientIp?: string) => Promise<Response> {
  if (options.mode === "sign" || options.kudo.walletClient) {
    throw new Error("Refusing to serve a signing Kudo client over HTTP: anyone who can reach the URL could spend from its wallet. Use stdio for local signing.");
  }
  const limit = options.rateLimitPerMinute ?? 60;
  const origins = options.allowedOrigins ?? ["*"];
  const hits = new Map<string, { count: number; reset: number }>();

  const cors = (request: Request): Record<string, string> => {
    const origin = request.headers.get("origin") ?? "";
    const allow = origins.includes("*") ? "*" : origins.includes(origin) ? origin : "";
    return allow
      ? {
          "access-control-allow-origin": allow,
          "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
          "access-control-allow-headers": "content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id",
          "access-control-expose-headers": "mcp-session-id",
        }
      : {};
  };

  const withHeaders = (response: Response, headers: Record<string, string>) => {
    for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
    return response;
  };

  return async (request, clientIp = "unknown") => {
    const headers = cors(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return Response.json(
        { name: SERVER_NAME, version: SERVER_VERSION, mcp: `${url.origin}/mcp`, network: options.kudo.network.chain.name, signing: false },
        { headers },
      );
    }

    if (limit > 0) {
      const now = Date.now();
      const entry = hits.get(clientIp);
      if (!entry || entry.reset < now) hits.set(clientIp, { count: 1, reset: now + 60_000 });
      else if (++entry.count > limit) {
        return Response.json(
          { jsonrpc: "2.0", error: { code: -32000, message: "Rate limit exceeded. Try again in a minute, or run the server locally with npx @kudo-archi/mcp." }, id: null },
          { status: 429, headers: { ...headers, "retry-after": "60" } },
        );
      }
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    }

    // Stateless: a fresh server and transport per request, so any instance
    // behind a load balancer can answer any call.
    const server = createKudoMcpServer(options);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return withHeaders(await transport.handleRequest(request), headers);
    } finally {
      void transport.close();
      void server.close();
    }
  };
}

/** Serves the handler with node:http on `/mcp`. */
export function serveHttp(options: HttpOptions & { port: number; host?: string; trustProxy?: boolean }) {
  const handle = createKudoMcpHandler(options);

  const toRequest = async (req: IncomingMessage): Promise<Request> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else if (v !== undefined) headers.set(k, v);
    }
    const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
    return new Request(url, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body });
  };

  const send = async (res: ServerResponse, response: Response) => {
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    if (!response.body) return res.end();
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  };

  const server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? "/").split("?")[0];
      if (!["/", "/health", "/mcp"].includes(path!)) {
        res.statusCode = 404;
        return res.end("Not found. The MCP endpoint is /mcp.");
      }
      const forwarded = options.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "";
      await send(res, await handle(await toRequest(req), forwarded || req.socket.remoteAddress || "unknown"));
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    }
  });
  server.listen(options.port, options.host ?? "0.0.0.0");
  return server;
}
