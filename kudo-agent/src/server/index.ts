/**
 * The HTTP endpoint.
 *
 *   POST /message    {"message": "..."}  ->  {"response": "..."}
 *   GET  /identity   name, agentId and where to verify the TEE
 *   GET  /health
 *
 *   PORT   port to listen on (default 3000)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { health, identity, message, notFound } from "./handlers.ts";

const DEFAULT_PORT = 3000;

export interface RunningServer {
  port: number;
  /** Stops accepting new connections. Requests in flight are left to finish. */
  close(): void;
}

const ROUTES = [
  { method: "GET", path: "/health", handle: health },
  { method: "GET", path: "/identity", handle: identity },
  { method: "POST", path: "/message", handle: message },
] as const;

function route(request: IncomingMessage, response: ServerResponse): void {
  const match = ROUTES.find(
    (candidate) => candidate.method === request.method && candidate.path === request.url,
  );

  // Handlers may be async; nothing awaits them, so an unhandled rejection
  // would be invisible. Each handler owns its own error reporting.
  void (match ? match.handle(request, response) : notFound(request, response));
}

export function startServer(): RunningServer {
  const port = Number(process.env.PORT?.trim() || DEFAULT_PORT);
  const server = createServer(route);

  server.listen(port, () => console.log(`listening on :${port}`));

  return {
    port,
    close: () => server.close(),
  };
}
