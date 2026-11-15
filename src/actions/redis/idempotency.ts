/**
 * Idempotency records in Redis, shared by every replica. `SET … NX GET` stores the first
 * response and hands back the existing one otherwise, in one atomic step (Redis 7+). The key
 * expires after `ttlS` (at least 24 hours, contract rule 8).
 */
import type { Redis } from "ioredis";

import type { IdempotencyStore, StoredResponse } from "../idempotency.js";
import { guarded } from "../storeError.js";
import type { RedisKeys } from "./client.js";

export class RedisIdempotencyStore implements IdempotencyStore {
  readonly #redis: Redis;
  readonly #keys: RedisKeys;
  readonly #ttlMs: number;

  constructor(redis: Redis, keys: RedisKeys, ttlS: number) {
    this.#redis = redis;
    this.#keys = keys;
    this.#ttlMs = ttlS * 1000;
  }

  async get(tenant: string, key: string): Promise<StoredResponse | null> {
    const value = await guarded(() => this.#redis.get(this.#keys.idempotency(tenant, key)));
    return value === null ? null : (JSON.parse(value) as StoredResponse);
  }

  async putIfAbsent(
    tenant: string,
    key: string,
    response: StoredResponse,
  ): Promise<StoredResponse> {
    const previous = (await guarded(() =>
      this.#redis.call(
        "SET",
        this.#keys.idempotency(tenant, key),
        JSON.stringify(response),
        "PX",
        String(this.#ttlMs),
        "NX",
        "GET",
      ),
    )) as string | null;
    return previous === null
      ? (JSON.parse(JSON.stringify(response)) as StoredResponse)
      : (JSON.parse(previous) as StoredResponse);
  }
}
