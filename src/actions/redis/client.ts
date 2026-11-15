/**
 * The Redis connection behind the shared stores (`store.backend = redis`).
 *
 * It fails fast rather than queueing: while Redis is unreachable every command rejects at
 * once (no offline queue, one attempt, `commandTimeoutMs` each), `/v1/ready` answers 503, and
 * the client keeps reconnecting in the background. Redis being down never stops the process.
 *
 * The URL carries the password, so it is never logged; neither are ioredis's error messages,
 * which name hosts. Logs get the error code only, and once per change of state.
 */
import { Redis } from "ioredis";

import type { Logger } from "../../observability/logger.js";

export interface RedisSettings {
  readonly redisUrl: string;
  readonly keyPrefix: string;
  readonly commandTimeoutMs: number;
}

/** Key layout, one place: `<prefix>:<kind>:<tenant>:<id>`. Tenants never contain `:`. */
export class RedisKeys {
  constructor(readonly prefix: string) {}
  proposal(tenant: string, id: string): string {
    return `${this.prefix}:p:${tenant}:${id}`;
  }
  idempotency(tenant: string, key: string): string {
    return `${this.prefix}:i:${tenant}:${key}`;
  }
  lock(key: string): string {
    return `${this.prefix}:l:${key}`;
  }
}

const MAX_RECONNECT_DELAY_MS = 2000;

export function createRedis(settings: RedisSettings, logger: Logger): Redis {
  const redis = new Redis(settings.redisUrl, {
    connectionName: "air-tools-gateway",
    connectTimeout: 2000,
    commandTimeout: settings.commandTimeoutMs,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 200, MAX_RECONNECT_DELAY_MS),
    // A replica that fails over to read-only refuses writes; reconnect to find the primary.
    reconnectOnError: (error) => error.message.startsWith("READONLY"),
  });

  let up: boolean | null = null;
  redis.on("ready", () => {
    if (up !== true) logger.info("store.redis_connected");
    up = true;
  });
  redis.on("error", (error: Error & { code?: unknown }) => {
    if (up !== false) {
      logger.warn(
        { code: typeof error.code === "string" ? error.code : error.name },
        "store.redis_unavailable",
      );
    }
    up = false;
  });
  return redis;
}

/** Readiness: true only when a PING comes back in time. */
export async function pingRedis(redis: Redis): Promise<boolean> {
  return (await redis.ping()) === "PONG";
}
