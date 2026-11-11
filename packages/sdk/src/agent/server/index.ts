/**
 * The HTTP endpoint.
 *
 *   POST /message    {"message": "..."}  ->  {"response": "..."}
 *   GET  /identity   name, agentId, where to verify the TEE, and launch state
 *   GET  /wallet-link  a launched agent's signed consent to setAgentWallet
 *   GET  /health
 *
 *   port   startAgent's `port`, else PORT, else 3000
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { health, identity, message, notFound, walletLink } from "./handlers.js";

const DEFAULT_PORT = 3000;

export interface RunningServer {
  port: number;
  /** Stops accepting new connections. Requests in flight are left to finish. */
  close(): void;
}

/** Starts the endpoint. `run` does one agent run for POST /message. */
export function startServer(run: (prompt: string) => Promise<string>, port?: number): RunningServer {
  const listenOn = port ?? Number(process.env.PORT?.trim() || DEFAULT_PORT);

  const routes = [
    { method: "GET", path: "/health", handle: health },
    { method: "GET", path: "/identity", handle: identity },
    { method: "GET", path: "/wallet-link", handle: walletLink },
    {
      method: "POST",
      path: "/message",
      handle: (request: IncomingMessage, response: ServerResponse) => message(request, response, run),
    },
  ];

  function route(request: IncomingMessage, response: ServerResponse): void {
    const match = routes.find(
      (candidate) => candidate.method === request.method && candidate.path === request.url,
    );
    // Handlers may be async; nothing awaits them, so an unhandled rejection
    // would be invisible. Each handler owns its own error reporting.
    void (match ? match.handle(request, response) : notFound(request, response));
  }

  const server = createServer(route);
  server.listen(listenOn, () => console.log(`listening on :${listenOn}`));

  return {
    port: listenOn,
    close: () => server.close(),
  };
}
