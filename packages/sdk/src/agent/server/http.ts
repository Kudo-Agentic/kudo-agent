/** Small helpers over node:http, so the handlers stay about behaviour. */
import type { IncomingMessage, ServerResponse } from "node:http";

/** Caps a request body so a stray upload cannot exhaust memory. */
const MAX_BODY_BYTES = 64 * 1024;

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

export async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Removes the socket timeouts for this exchange.
 *
 * One agent run can take minutes — it may be sending transactions and waiting
 * on receipts — and the default timeouts would close the connection first.
 */
export function allowLongRun(request: IncomingMessage, response: ServerResponse): void {
  request.setTimeout(0);
  response.setTimeout(0);
}
