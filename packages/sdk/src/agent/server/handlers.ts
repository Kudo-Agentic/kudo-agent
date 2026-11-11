/** What each endpoint does. */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { AgentRunError } from "../agent.js";
import { LinkRefused, NotLinkedYet, signWalletLink } from "../link.js";
import { redact } from "../log.js";
import { allowLongRun, readBody, sendJson } from "./http.js";

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
  sendJson(response, 404, { error: "Not found. Try POST /message, GET /identity, GET /wallet-link or GET /health." });
}

/**
 * Lets a page on another origin (e.g. app.kudo.archi/register) call
 * GET /wallet-link from the browser. It carries a bearer token, not cookies,
 * so any origin is fine: without the token it gets nothing.
 */
const LINK_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization",
  "Access-Control-Max-Age": "600",
};

export function walletLinkPreflight(_request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(204, LINK_CORS);
  response.end();
}

/**
 * GET /wallet-link?agentId=&owner= — this agent's signed consent to be
 * linked as that identity's agentWallet, for its owner to send with
 * setAgentWallet. See link.ts. Needs the CHAT_TOKEN, and is refused outright
 * while none is set: an open endpoint would let anyone who owns an identity
 * claim this agent's wallet for it.
 */
export async function walletLink(request: IncomingMessage, response: ServerResponse): Promise<void> {
  for (const [name, value] of Object.entries(LINK_CORS)) response.setHeader(name, value);
  if (!process.env.CHAT_TOKEN?.trim()) {
    return sendJson(response, 403, { error: "Linking from a page is off: set CHAT_TOKEN on this agent to allow it." });
  }
  if (!authorised(request)) return sendJson(response, 401, { error: "Missing or wrong bearer token." });

  const query = new URL(request.url ?? "/", "http://agent").searchParams;
  try {
    sendJson(response, 200, await signWalletLink({ agentId: query.get("agentId"), owner: query.get("owner") }));
  } catch (error) {
    if (error instanceof LinkRefused) return sendJson(response, error.status, { error: error.message });
    const reason = redact(error instanceof Error ? error.message : String(error));
    console.error(`GET /wallet-link failed: ${reason}`);
    sendJson(response, 500, { error: reason });
  }
}

/**
 * With CHAT_TOKEN set, POST /message needs `Authorization: Bearer <CHAT_TOKEN>`.
 * Every message is a paid model run, so an endpoint on the public internet
 * should not answer just anyone. Unset, it stays open (as before).
 */
function authorised(request: IncomingMessage): boolean {
  const expected = process.env.CHAT_TOKEN?.trim();
  if (!expected) return true;
  const given = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "")?.[1]?.trim() ?? "";
  // Compare digests, so neither the length nor the content leaks through timing.
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/** POST /message  {"message": "..."}  ->  {"response": "..."}. `run` does one agent run. */
export async function message(
  request: IncomingMessage,
  response: ServerResponse,
  run: (prompt: string) => Promise<string>,
): Promise<void> {
  if (!authorised(request)) return sendJson(response, 401, { error: "Missing or wrong bearer token." });

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
    sendJson(response, 200, { response: redact(await run(text.trim())) });
  } catch (error) {
    const reason = redact(error instanceof Error ? error.message : String(error));
    console.error(`POST /message failed: ${reason}`);

    // Not linked yet is a wait (503); a run that started and ended badly is the
    // agent's failure (502); anything else is ours (500).
    const status = error instanceof NotLinkedYet ? 503 : error instanceof AgentRunError ? 502 : 500;
    sendJson(response, status, { error: reason });
  }
}
