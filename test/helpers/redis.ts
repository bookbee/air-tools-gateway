/**
 * Redis for tests. Suites that need a real Redis run only when
 * `AIR_TOOLS_GATEWAY_TEST_REDIS_URL` is set (`make test-redis` starts a throwaway container and
 * sets it), so `make check` stays hermetic. Never point it at a shared Redis you care about:
 * each test writes under its own random prefix and deletes only those keys, but still.
 */
import { randomBytes } from "node:crypto";

import { Redis } from "ioredis";
import { afterAll, describe } from "vitest";

import { RedisKeys } from "../../src/actions/redis/client.js";

export const TEST_REDIS_URL = process.env.AIR_TOOLS_GATEWAY_TEST_REDIS_URL ?? "";

/** `describe` that runs only with a test Redis. */
export const describeRedis = describe.runIf(TEST_REDIS_URL !== "");

/** A port nothing listens on, for "Redis is down" tests (they need no Redis). */
export const DEAD_REDIS_URL = "redis://127.0.0.1:1/0";

/**
 * One client per suite, and a fresh key prefix per call. Keys under every prefix handed out
 * are deleted when the suite ends.
 */
export function useTestRedis() {
  const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  const prefixes: string[] = [];
  afterAll(async () => {
    for (const prefix of prefixes) {
      const stream = redis.scanStream({ match: `${prefix}:*`, count: 500 });
      for await (const keys of stream as AsyncIterable<string[]>) {
        if (keys.length > 0) await redis.del(...keys);
      }
    }
    await redis.quit();
  });
  return {
    redis,
    /** A prefix no other test uses. */
    keys: (): RedisKeys => {
      const prefix = `airtg-test-${randomBytes(4).toString("hex")}`;
      prefixes.push(prefix);
      return new RedisKeys(prefix);
    },
  };
}
