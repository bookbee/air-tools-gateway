/**
 * The per-proposal lock in Redis, shared by every replica.
 *
 * Acquire: `SET <key> <token> NX PX holdMs`, retried with jittered backoff until `waitMs`.
 * Release: delete only if the token is still ours (a script), so a holder whose lock expired
 * never frees someone else's. `holdMs` covers the whole critical section, so expiry only
 * happens to a stalled holder; for that case the proposal's compare-and-set state change and
 * the backend's idempotency reference are the fence (see `../locks.ts`).
 */
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type { Redis } from "ioredis";

import type { Logger } from "../../observability/logger.js";
import { LockTimeoutError, type LockOptions, type ProposalLock } from "../locks.js";
import { guarded } from "../storeError.js";
import type { RedisKeys } from "./client.js";

const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

const FIRST_RETRY_MS = 10;
const MAX_RETRY_MS = 100;

export class RedisLock implements ProposalLock {
  readonly #redis: Redis;
  readonly #keys: RedisKeys;
  readonly #logger: Logger;

  constructor(redis: Redis, keys: RedisKeys, logger: Logger) {
    this.#redis = redis;
    this.#keys = keys;
    this.#logger = logger;
  }

  async run<T>(key: string, options: LockOptions, fn: () => Promise<T>): Promise<T> {
    const redisKey = this.#keys.lock(key);
    const token = randomBytes(16).toString("hex");
    await this.#acquire(redisKey, token, options);
    try {
      return await fn();
    } finally {
      const released = await this.#redis.eval(RELEASE, 1, redisKey, token).catch(() => null);
      // 0: it expired while held (and may be someone else's now). null: Redis failed; the
      // key expires by itself. Either way nothing else to do but say so.
      if (released !== 1) this.#logger.warn({ released: released ?? "error" }, "lock.not_released");
    }
  }

  async #acquire(redisKey: string, token: string, options: LockOptions): Promise<void> {
    const giveUpAt = Date.now() + options.waitMs;
    let delay = FIRST_RETRY_MS;
    for (;;) {
      const ok = await guarded(() => this.#redis.set(redisKey, token, "PX", options.holdMs, "NX"));
      if (ok === "OK") return;
      const left = giveUpAt - Date.now();
      if (left <= 0) throw new LockTimeoutError();
      await sleep(Math.min(left, delay / 2 + Math.random() * delay));
      delay = Math.min(delay * 2, MAX_RETRY_MS);
    }
  }
}
