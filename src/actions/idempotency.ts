/**
 * Idempotency records for execute (contract rule 8): the first response to an
 * (tenant, Idempotency-Key) pair, kept for at least 24 hours and replayed unchanged.
 *
 * Only final answers are stored. A 5xx (timeout, backend failure) is not, so a later call with
 * the same key can learn the real outcome (handoff §7.7).
 *
 * Two implementations sit behind `IdempotencyStore`: this file's in-memory one (one replica)
 * and `redis/idempotency.ts` (shared by replicas).
 */
import type { Clock } from "../app.js";

export interface StoredResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: object;
  /** Which proposal the key was first used with: replays are bound to it. */
  readonly proposalId: string;
  /**
   * The request the key was first used with, beside `proposalId`. A replay must match all
   * three (TG-001). Optional only because records stored before this field existed lack it.
   */
  readonly subject?: string | null;
  readonly capability?: string;
}

export interface IdempotencyStore {
  get(tenant: string, key: string): Promise<StoredResponse | null>;
  /**
   * Store `response` unless the key already has one. Returns whichever response is stored
   * afterwards: the first one always wins, so a replay never changes.
   */
  putIfAbsent(tenant: string, key: string, response: StoredResponse): Promise<StoredResponse>;
}

const k = (tenant: string, key: string) => `${tenant}\u0000${key}`;

export class InMemoryIdempotencyStore implements IdempotencyStore {
  readonly #items = new Map<string, { response: StoredResponse; expiresAt: number }>();
  readonly #clock: Clock;
  readonly #ttlMs: number;

  constructor(clock: Clock, ttlS: number) {
    this.#clock = clock;
    this.#ttlMs = ttlS * 1000;
  }

  async get(tenant: string, key: string): Promise<StoredResponse | null> {
    const item = this.#items.get(k(tenant, key));
    if (item === undefined) return null;
    if (item.expiresAt <= this.#clock.now().getTime()) {
      this.#items.delete(k(tenant, key));
      return null;
    }
    return structuredClone(item.response);
  }

  async putIfAbsent(
    tenant: string,
    key: string,
    response: StoredResponse,
  ): Promise<StoredResponse> {
    // No await between the check and the write: that is what makes it atomic here.
    const now = this.#clock.now().getTime();
    for (const [key2, item] of this.#items) if (item.expiresAt <= now) this.#items.delete(key2);
    const existing = this.#items.get(k(tenant, key));
    if (existing !== undefined) return structuredClone(existing.response);
    this.#items.set(k(tenant, key), {
      response: structuredClone(response),
      expiresAt: now + this.#ttlMs,
    });
    return structuredClone(response);
  }

  /** Test support. */
  get size(): number {
    return this.#items.size;
  }
}
