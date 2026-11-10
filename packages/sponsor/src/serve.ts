import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { createSponsorHandler, type SponsorOptions } from "./handler.js";

/** Serves the relay with node:http. */
export function serveSponsor(options: SponsorOptions & { port: number; host?: string; trustProxy?: boolean }) {
  const handle = createSponsorHandler(options);

  const toRequest = async (req: IncomingMessage): Promise<Request> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else if (v !== undefined) headers.set(k, v);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
    return new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
      method: req.method,
      headers,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    });
  };

  const send = async (res: ServerResponse, response: Response) => {
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await response.arrayBuffer()));
  };

  const server = createServer(async (req, res) => {
    try {
      // The client controls every X-Forwarded-For entry except the last, which
      // the trusted proxy appended: key the rate limit on that one.
      const forwarded = options.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",").at(-1)?.trim() : "";
      await send(res, await handle(await toRequest(req), forwarded || req.socket.remoteAddress || "unknown"));
    } catch {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    }
  });
  server.listen(options.port, options.host ?? "0.0.0.0");
  return server;
}
