/**
 * Counts sponsored sends per sender per UTC day. The relay calls `take` once
 * per /send, before it reaches Alchemy, and `release` when Alchemy definitely
 * did not send, so a refused send does not use up the allowance.
 *
 * The in-memory default is per process: on serverless, or behind more than
 * one replica, plug in a shared store (see the README for Upstash Redis or
 * Vercel KV).
 */
export interface CapStore {
  /** Counts one send for `key` if fewer than `limit` were counted; false if the cap is reached. */
  take(key: string, limit: number): Promise<boolean>;
  /** Gives back one send counted by `take`. */
  release(key: string): Promise<void>;
}

export class MemoryCapStore implements CapStore {
  private readonly counts = new Map<string, number>();

  async take(key: string, limit: number): Promise<boolean> {
    const used = this.counts.get(key) ?? 0;
    if (used >= limit) return false;
    this.counts.set(key, used + 1);
    if (this.counts.size > 50_000) this.prune(key);
    return true;
  }

  async release(key: string): Promise<void> {
    const used = this.counts.get(key) ?? 0;
    if (used <= 1) this.counts.delete(key);
    else this.counts.set(key, used - 1);
  }

  /** Keys end in the day; drop every other day's. */
  private prune(current: string) {
    const day = current.slice(current.lastIndexOf(":") + 1);
    for (const k of this.counts.keys()) if (!k.endsWith(`:${day}`)) this.counts.delete(k);
  }
}

/** `<sender, lowercase>:<YYYY-MM-DD, UTC>` */
export const capKey = (from: string, now: number) => `${from.toLowerCase()}:${new Date(now).toISOString().slice(0, 10)}`;
