/** What each endpoint does. */
import type { IncomingMessage, ServerResponse } from "node:http";

import { AgentRunError, runAgent } from "../agent/index.ts";
import { allowLongRun, readBody, sendJson } from "./http.ts";

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
  sendJson(response, 404, { error: "Not found. Try POST /message, GET /identity or GET /health." });
}

/** POST /message  {"message": "..."}  ->  {"response": "..."} */
export async function message(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(request));
  } catch (error) {
    return sendJson(response, 400, {
      error: error instanceof Error ? error.message : "Invalid JSON body.",
    });
  }

  const text = (body as { message?: unknown } | null)?.message;
  if (typeof text !== "string" || !text.trim()) {
    return sendJson(response, 400, { error: 'Body must be {"message": "<text>"}.' });
  }

  try {
    allowLongRun(request, response);
    sendJson(response, 200, { response: await runAgent(text.trim()) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`POST /message failed: ${reason}`);

    // A run that started and ended badly is the agent's failure (502); anything
    // else is ours (500).
    sendJson(response, error instanceof AgentRunError ? 502 : 500, { error: reason });
  }
}
