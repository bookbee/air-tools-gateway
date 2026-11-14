/**
 * Idempotency records for execute (contract rule 8): the first response to an
 * (tenant, Idempotency-Key) pair, kept for at least 24 hours and replayed unchanged.
 *
 * Only final answers are stored. A 5xx (timeout, backend failure) is not, so a later call with
 * the same key can learn the real outcome (handoff §7.7).
 *
 * v1 keeps them in process memory behind `IdempotencyStore`; Redis replaces it later.
 */
import type { Clock } from "../app.js";

export interface StoredResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: object;
  /** For logs: which proposal the key was first used with. */
  readonly proposalId: string;
}

export interface IdempotencyStore {
  get(tenant: string, key: string): Promise<StoredResponse | null>;
  put(tenant: string, key: string, response: StoredResponse): Promise<void>;
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

  async put(tenant: string, key: string, response: StoredResponse): Promise<void> {
    const now = this.#clock.now().getTime();
    for (const [key2, item] of this.#items) if (item.expiresAt <= now) this.#items.delete(key2);
    this.#items.set(k(tenant, key), {
      response: structuredClone(response),
      expiresAt: now + this.#ttlMs,
    });
  }

  /** Test support. */
  get size(): number {
    return this.#items.size;
  }
}
