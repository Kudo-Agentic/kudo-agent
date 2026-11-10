/**
 * The three Alchemy Wallet API calls the relay makes. The key is only ever in
 * the URL built here; every reason string that leaves this file has it
 * scrubbed.
 */

export type UpstreamFailure =
  /** Alchemy answered and refused: nothing was sent. */
  | { ok: false; kind: "rejected"; reason: string }
  /** Alchemy could not be reached or answered nonsense, before anything could be sent. */
  | { ok: false; kind: "unavailable"; reason: string }
  /** The request may have gone out and been acted on: the call may have been sent. */
  | { ok: false; kind: "unknown"; reason: string };

export type UpstreamResult<T> = { ok: true; result: T } | UpstreamFailure;

export interface AlchemyOptions {
  apiKey: string;
  /** Default https://api.g.alchemy.com/v2/ */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Per request. Default 30 s. */
  timeoutMs?: number;
}

export type AlchemyRpc = <T>(
  method: string,
  params: unknown[],
  /** True for wallet_sendPreparedCalls: a failure after the request left may mean it was sent. */
  options?: { mayHaveSent?: boolean },
) => Promise<UpstreamResult<T>>;

export function createAlchemyRpc(options: AlchemyOptions): AlchemyRpc {
  const doFetch = options.fetch ?? fetch;
  const url = `${options.baseUrl ?? "https://api.g.alchemy.com/v2/"}${options.apiKey}`;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const scrub = (text: string) => (options.apiKey ? text.split(options.apiKey).join("<key>") : text).slice(0, 500);

  return async (method, params, { mayHaveSent = false } = {}) => {
    const failed = (reason: string): UpstreamFailure => ({ ok: false, kind: mayHaveSent ? "unknown" : "unavailable", reason: scrub(reason) });

    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // A timeout or a reset can come after Alchemy received the request.
      const what = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "failed to connect or was cut off";
      return failed(`${method} ${what}`);
    }

    const body = (await response.json().catch(() => undefined)) as
      | { result?: unknown; error?: { code?: number; message?: string } }
      | undefined;

    if (body?.error) {
      // A JSON-RPC error is Alchemy refusing the request: nothing was sent.
      return { ok: false, kind: "rejected", reason: scrub(`${method}: ${body.error.message ?? "error"} (${body.error.code ?? "no code"})`) };
    }
    if (response.status >= 500 || !response.ok) {
      // 4xx without a JSON-RPC error (bad key, rate limited at Alchemy) is a refusal; a 5xx may be
      // a failure after the call was accepted.
      if (response.status < 500) return { ok: false, kind: "rejected", reason: scrub(`${method}: HTTP ${response.status}`) };
      return failed(`${method}: HTTP ${response.status}`);
    }
    if (!body || body.result === undefined) return failed(`${method}: no result in the response`);
    return { ok: true, result: body.result as never };
  };
}
