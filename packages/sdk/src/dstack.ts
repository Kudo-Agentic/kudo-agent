/**
 * Phala dstack: the guest agent inside a TEE (confidential VM) serves key
 * derivation and app info over a Unix socket.
 *
 * A key from dstack is derived from the app's identity inside the enclave, so
 * it never exists outside it and is the same on every restart of the same app.
 * Node only: it talks HTTP over a Unix socket.
 */
import { KudoError } from "./errors.js";

export const DSTACK_SOCKET = "/var/run/dstack.sock";
/** The key path the Kudo skill uses, so every integration derives the same wallet. */
export const DSTACK_KEY_PATH = "kudo/agent";

export interface DstackOptions {
  /** Default /var/run/dstack.sock. */
  socket?: string;
  timeoutMs?: number;
}

async function call<T>(path: string, body: unknown, options: DstackOptions): Promise<T> {
  const { request } = await import("node:http");
  const socketPath = options.socket ?? DSTACK_SOCKET;
  return new Promise<T>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        socketPath,
        path,
        method: payload ? "POST" : "GET",
        headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
        timeout: options.timeoutMs ?? 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new KudoError("NOT_FOUND", `dstack ${path} returned ${res.statusCode}.`));
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
          } catch {
            reject(new KudoError("NOT_FOUND", `dstack ${path} did not return JSON.`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (e) =>
      reject(new KudoError("NOT_FOUND", `Cannot reach dstack at ${socketPath} (${e.message}). Is this running in a Phala TEE?`)),
    );
    req.end(payload);
  });
}

/** Derives this app's secp256k1 key from dstack. Never log the result. */
export async function dstackPrivateKey(path = DSTACK_KEY_PATH, options: DstackOptions = {}): Promise<`0x${string}`> {
  const { key } = await call<{ key?: string }>("/GetKey", { path, purpose: "signing" }, options);
  const hex = (key ?? "").replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new KudoError("NOT_FOUND", "dstack GetKey did not return a 32-byte key.");
  return `0x${hex}`;
}

/** The Phala app id (bare lowercase hex), the id a Trust Center report is published under. */
export async function dstackAppId(options: DstackOptions = {}): Promise<string> {
  const { app_id } = await call<{ app_id?: string }>("/Info", undefined, options);
  if (!app_id) throw new KudoError("NOT_FOUND", "dstack Info returned no app_id.");
  return app_id.replace(/^0x/i, "").toLowerCase();
}
