/** What each endpoint does. */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { AgentRunError } from "../agent.js";
import { redact } from "../log.js";
import { allowLongRun, readBody, sendJson } from "./http.js";

/** The longest visitor message taken, transcript included. */
const MAX_CHAT_CHARS = 16_000;

export function health(_request: IncomingMessage, response: ServerResponse): void {
  sendJson(response, 200, { ok: true });
}

/**
 * GET /identity — who this agent is and where its attestation can be checked.
 *
 * `attestation` is null outside a TEE. Note that this answer comes from the
 * agent itself, so it is a pointer, not proof: the Trust Center page is where
 * the claim is actually checked, independently of us.
 */
export function identity(_request: IncomingMessage, response: ServerResponse): void {
  sendJson(response, 200, {
    name: process.env.AGENT_NAME?.trim() || null,
    agentId: process.env.AGENT_ID?.trim() || null,
    teeId: process.env.TEE_ID?.trim() || null,
    attestation: process.env.TEE_TRUST_URL?.trim() || null,
    // False for a hand-set TEE_ID: the report exists, but describes another app.
    attested: process.env.TEE_ID_SOURCE?.trim() === "dstack",
  });
}

export function notFound(_request: IncomingMessage, response: ServerResponse): void {
  sendJson(response, 404, { error: "Not found. Try POST /chat, POST /message, GET /identity or GET /health." });
}

/** True when the request carries `Authorization: Bearer <token>`. */
export function hasBearer(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization ?? "";
  const given = Buffer.from(header.replace(/^Bearer\s+/i, "").trim());
  const expected = Buffer.from(token);
  return header.toLowerCase().startsWith("bearer ") && given.length === expected.length && timingSafeEqual(given, expected);
}

/** The `message` of a `{"message": "..."}` body, or an error already sent. */
async function readMessage(request: IncomingMessage, response: ServerResponse): Promise<string | undefined> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(request));
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid JSON body." });
    return undefined;
  }
  const text = (body as { message?: unknown } | null)?.message;
  if (typeof text !== "string" || !text.trim()) {
    sendJson(response, 400, { error: 'Body must be {"message": "<text>"}.' });
    return undefined;
  }
  return text.trim();
}

async function answer(
  label: string,
  response: ServerResponse,
  request: IncomingMessage,
  run: () => Promise<string>,
): Promise<void> {
  try {
    allowLongRun(request, response);
    sendJson(response, 200, { response: redact(await run()) });
  } catch (error) {
    const reason = redact(error instanceof Error ? error.message : String(error));
    console.error(`POST ${label} failed: ${reason}`);

    // A run that started and ended badly is the agent's failure (502); anything
    // else is ours (500).
    sendJson(response, error instanceof AgentRunError ? 502 : 500, { error: reason });
  }
}

/**
 * POST /message  {"message": "..."}  ->  {"response": "..."}. `run` does one
 * agent run, with the agent's full tools and key. With `token` set, only a
 * caller sending it as a bearer token gets one.
 */
export async function message(
  request: IncomingMessage,
  response: ServerResponse,
  run: (prompt: string) => Promise<string>,
  token?: string,
): Promise<void> {
  if (token && !hasBearer(request, token)) {
    return sendJson(response, 401, { error: "POST /message needs this agent's MESSAGE_TOKEN. Visitors use POST /chat." });
  }
  const text = await readMessage(request, response);
  if (text === undefined) return;
  await answer("/message", response, request, () => run(text));
}

/** Counts visitor chats in flight, and turns away the ones over the limit. */
export function chatGate(limit: number) {
  let running = 0;
  return {
    tryEnter: () => (running < limit ? (running++, true) : false),
    leave: () => {
      running = Math.max(0, running - 1);
    },
  };
}

/**
 * POST /chat  {"message": "..."}  ->  {"response": "..."}: a visitor talking
 * to the agent. `run` answers with no tools and no key (runVisitorChat), so
 * it needs no token. At most `gate`'s limit run at once; the rest get 429.
 */
export async function chat(
  request: IncomingMessage,
  response: ServerResponse,
  run: (prompt: string) => Promise<string>,
  gate: ReturnType<typeof chatGate>,
): Promise<void> {
  const text = await readMessage(request, response);
  if (text === undefined) return;
  if (text.length > MAX_CHAT_CHARS) {
    return sendJson(response, 413, { error: `Keep it under ${MAX_CHAT_CHARS} characters.` });
  }
  if (!gate.tryEnter()) {
    return sendJson(response, 429, { error: "The agent is answering other visitors. Try again in a moment." });
  }
  try {
    await answer("/chat", response, request, () => run(text));
  } finally {
    gate.leave();
  }
}
