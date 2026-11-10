import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import type { Address } from "viem";

import type { SponsoredCall } from "./rules.js";

/**
 * Everything /send needs, carried in the id instead of a database. The relay
 * signs it, so nothing in it can be changed by the client; the only thing the
 * client contributes at /send is its signatures.
 */
export interface Ticket {
  v: 1;
  from: Address;
  call: SponsoredCall;
  /** Alchemy's wallet_prepareCalls result, as returned. */
  prepared: unknown;
  /** Unix milliseconds. */
  expiresAt: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// base64url with btoa/atob, so this runs on Node, Vercel and Workers alike.
const toB64url = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64url = (text: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

const mac = (secret: string, payload: string) => hmac(sha256, encoder.encode(secret), encoder.encode(payload));

const sameBytes = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
};

/** `<payload>.<HMAC-SHA256 over payload>`, both base64url. */
export function signTicket(ticket: Ticket, secret: string): string {
  const payload = toB64url(encoder.encode(JSON.stringify(ticket)));
  return `${payload}.${toB64url(mac(secret, payload))}`;
}

/** The ticket, if the id is one this relay signed. Expiry is the caller's check. */
export function verifyTicket(id: unknown, secret: string): Ticket | undefined {
  if (typeof id !== "string" || id.length > 200_000) return undefined;
  const [payload, tag, extra] = id.split(".");
  if (!payload || !tag || extra !== undefined) return undefined;
  try {
    if (!sameBytes(fromB64url(tag), mac(secret, payload))) return undefined;
    const ticket = JSON.parse(decoder.decode(fromB64url(payload))) as Ticket;
    return ticket?.v === 1 ? ticket : undefined;
  } catch {
    return undefined;
  }
}
