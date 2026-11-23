/**
 * The HTTP endpoint.
 *
 *   POST /chat       {"message": "..."}  ->  {"response": "..."}   a visitor; no tools
 *   POST /message    {"message": "..."}  ->  {"response": "..."}   a full agent run
 *   GET  /identity   name, agentId and where to verify the TEE
 *   GET  /health
 *
 *   port                 startAgent's `port`, else PORT, else 3000
 *   MESSAGE_TOKEN        when set, /message needs it as a bearer token
 *   CHAT                 "off" turns /chat off (404)
 *   CHAT_MAX_CONCURRENT  visitor chats answered at once, default 2; the rest get 429
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { chat, chatGate, health, identity, message, notFound } from "./handlers.js";

const DEFAULT_PORT = 3000;
const DEFAULT_CHAT_CONCURRENCY = 2;

export interface RunningServer {
  port: number;
  /** Stops accepting new connections. Requests in flight are left to finish. */
  close(): void;
}

export interface ServerRuns {
  /** One full agent run, for POST /message. */
  message: (prompt: string) => Promise<string>;
  /** One visitor answer with no tools, for POST /chat. */
  chat: (prompt: string) => Promise<string>;
}

/** Starts the endpoint. */
export function startServer(runs: ServerRuns, port?: number, env: NodeJS.ProcessEnv = process.env): RunningServer {
  const listenOn = port ?? Number(env.PORT?.trim() || DEFAULT_PORT);
  const token = env.MESSAGE_TOKEN?.trim() || undefined;
  const chatOn = env.CHAT?.trim().toLowerCase() !== "off";
  const limit = Number(env.CHAT_MAX_CONCURRENT?.trim() || DEFAULT_CHAT_CONCURRENCY);
  const gate = chatGate(Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_CHAT_CONCURRENCY);

  const routes = [
    { method: "GET", path: "/health", handle: health },
    { method: "GET", path: "/identity", handle: identity },
    {
      method: "POST",
      path: "/message",
      handle: (request: IncomingMessage, response: ServerResponse) => message(request, response, runs.message, token),
    },
    ...(chatOn
      ? [
          {
            method: "POST",
            path: "/chat",
            handle: (request: IncomingMessage, response: ServerResponse) => chat(request, response, runs.chat, gate),
          },
        ]
      : []),
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
