/**
 * Configuration from the environment.
 *
 * Variables are prefixed `AIR_TOOLS_GATEWAY__` and nest on `__`, the estate convention:
 * `AIR_TOOLS_GATEWAY__SECURITY__HASH_SALT` is `security.hash_salt`. The whole tree is
 * validated once at startup. An invalid config is one of only two things allowed to stop the
 * service (the other is an invalid capability definition), and its message names variables,
 * never their values: some of them are secrets.
 */
import { z } from "zod";

import { SCOPES, type ApiKeyRecord } from "./security/apiKeys.js";

export const ENV_PREFIX = "AIR_TOOLS_GATEWAY__";

/** The development salt from `.env.example`; refused outside development and test. */
export const DEV_HASH_SALT = "air-tools-gateway-dev-salt";

/** Contract rule 6: a proposal expires after at most 10 minutes. */
export const MAX_PROPOSAL_TTL_S = 600;
/** Contract rule 8: an Idempotency-Key is kept for at least 24 hours. */
export const MIN_IDEMPOTENCY_TTL_S = 86_400;

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type AppEnv = "development" | "test" | "production";

export interface Config {
  readonly app: { readonly env: AppEnv };
  readonly http: { readonly host: string; readonly port: number };
  readonly security: { readonly hashSalt: string; readonly apiKeys: readonly ApiKeyRecord[] };
  readonly backend: { readonly mode: "fixture"; readonly fixtureDir: string };
  readonly actions: { readonly proposalTtlS: number; readonly idempotencyTtlS: number };
  readonly log: { readonly format: "json"; readonly level: LogLevel };
  readonly store: StoreConfig;
  readonly shutdown: { readonly drainTimeoutMs: number };
}

/**
 * Where proposals, idempotency records and the per-proposal lock live. `memory` is one
 * process (a single replica); `redis` is shared by every replica.
 */
export type StoreConfig =
  | { readonly backend: "memory" }
  | {
      readonly backend: "redis";
      /** Secret: carries the password. Never logged. */
      readonly redisUrl: string;
      readonly keyPrefix: string;
      readonly commandTimeoutMs: number;
    };

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

const TENANT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const INVALID_JSON = Symbol("invalid-json");

const apiKeySchema = z
  .object({
    id: z.string().regex(KEY_ID_PATTERN, "must match [A-Za-z0-9_.-]{1,64}"),
    tenant: z.string().regex(TENANT_PATTERN, "must match [a-z0-9][a-z0-9_-]{0,63}"),
    scope: z.enum(SCOPES),
    key_hash: z
      .string()
      .transform((v) => v.trim().toLowerCase())
      .pipe(z.string().regex(SHA256_HEX, "must be a sha256 hex digest (64 characters)")),
  })
  .strict();

const apiKeysSchema = z
  .preprocess(
    (value) => {
      if (typeof value !== "string") return value;
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return INVALID_JSON;
      }
    },
    z.array(apiKeySchema, { invalid_type_error: "must be a JSON array of key records" }),
  )
  .superRefine((keys, ctx) => {
    if (keys.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must list at least one key" });
    }
    const ids = new Set<string>();
    const digests = new Set<string>();
    keys.forEach((key, index) => {
      if (ids.has(key.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "id"],
          message: "duplicate key id",
        });
      }
      if (digests.has(key.key_hash)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "key_hash"],
          message: "duplicate key_hash: one key cannot serve two records",
        });
      }
      ids.add(key.id);
      digests.add(key.key_hash);
    });
  });

const int = () => z.coerce.number({ invalid_type_error: "must be a number" }).int();

const schema = z
  .object({
    app: z
      .object({ env: z.enum(["development", "test", "production"]).default("development") })
      .strict()
      .default({}),
    http: z
      .object({
        host: z.string().min(1).default("0.0.0.0"),
        port: int().min(1).max(65_535).default(8080),
      })
      .strict()
      .default({}),
    security: z
      .object({
        hash_salt: z.string().min(1, "must not be empty"),
        api_keys: apiKeysSchema,
      })
      .strict(),
    backend: z
      .object({
        mode: z.enum(["fixture"]).default("fixture"),
        fixture_dir: z.string().min(1).default("fixtures"),
      })
      .strict()
      .default({}),
    actions: z
      .object({
        proposal_ttl_s: int().min(1).max(MAX_PROPOSAL_TTL_S).default(MAX_PROPOSAL_TTL_S),
        idempotency_ttl_s: int().min(MIN_IDEMPOTENCY_TTL_S).default(MIN_IDEMPOTENCY_TTL_S),
      })
      .strict()
      .default({}),
    log: z
      .object({
        format: z.enum(["json"]).default("json"),
        level: z.enum(LOG_LEVELS).default("info"),
      })
      .strict()
      .default({}),
    store: z
      .object({
        backend: z.enum(["memory", "redis"]).default("memory"),
        redis_url: z
          .string()
          .regex(/^rediss?:\/\/\S+$/, "must be a redis:// or rediss:// URL")
          .optional(),
        key_prefix: z
          .string()
          .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, "must match [a-z0-9][a-z0-9_-]{0,31}")
          .default("airtg"),
        command_timeout_ms: int().min(10).max(10_000).default(500),
      })
      .strict()
      .default({}),
    shutdown: z
      .object({
        // Below Docker's stop grace period (compose sets 30 s), above the longest execute.
        drain_timeout_ms: int().min(0).max(120_000).default(20_000),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.store.backend === "redis" && cfg.store.redis_url === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["store", "redis_url"],
        message: "is required when the store backend is redis",
      });
    }
    if (cfg.app.env === "production" && cfg.security.hash_salt === DEV_HASH_SALT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["security", "hash_salt"],
        message: "the development salt is not allowed in production",
      });
    }
  });

/** Turn `AIR_TOOLS_GATEWAY__A__B_C=v` entries into `{ a: { b_c: "v" } }`. */
export function envToTree(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const tree: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const problems: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(ENV_PREFIX) || value === undefined) continue;
    const segments = name.slice(ENV_PREFIX.length).toLowerCase().split("__");
    if (
      segments.some(
        (s) => s.length === 0 || s === "__proto__" || s === "constructor" || s === "prototype",
      )
    ) {
      problems.push(`${name}: malformed variable name`);
      continue;
    }
    let node = tree;
    for (const segment of segments.slice(0, -1)) {
      const next = node[segment];
      if (next === undefined) {
        const child = Object.create(null) as Record<string, unknown>;
        node[segment] = child;
        node = child;
      } else if (typeof next === "object" && next !== null) {
        node = next as Record<string, unknown>;
      } else {
        problems.push(`${name}: conflicts with another variable`);
        node = Object.create(null) as Record<string, unknown>;
      }
    }
    node[segments[segments.length - 1]!] = value;
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return tree;
}

/** `["security","api_keys",0,"key_hash"]` → `AIR_TOOLS_GATEWAY__SECURITY__API_KEYS[0].key_hash`. */
function variableName(path: readonly (string | number)[]): string {
  const sections = path.slice(0, 2).map((p) => String(p).toUpperCase());
  const rest = path.slice(2).map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`));
  return ENV_PREFIX.slice(0, -2) + sections.map((s) => `__${s}`).join("") + rest.join("");
}

/** Describe an issue without ever echoing the value it was about. */
function describe(issue: z.ZodIssue): string {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      // Zod's invalid_type text names types ("Expected number, received nan"), never values.
      return issue.received === "undefined" ? "is required" : issue.message;
    case z.ZodIssueCode.invalid_enum_value:
      return `must be one of: ${issue.options.join(", ")}`;
    case z.ZodIssueCode.unrecognized_keys:
      return `unknown setting(s): ${issue.keys.join(", ")}`;
    case z.ZodIssueCode.too_small:
    case z.ZodIssueCode.too_big:
    case z.ZodIssueCode.invalid_string:
    case z.ZodIssueCode.custom:
    case z.ZodIssueCode.not_multiple_of:
      return issue.message;
    default:
      return "is invalid";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(envToTree(env));
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => {
        const where = issue.path.length > 0 ? variableName(issue.path) : "configuration";
        return `${where}: ${describe(issue)}`;
      }),
    );
  }
  const c = parsed.data;
  return {
    app: { env: c.app.env },
    http: { host: c.http.host, port: c.http.port },
    security: {
      hashSalt: c.security.hash_salt,
      apiKeys: c.security.api_keys.map((k) => ({
        id: k.id,
        tenant: k.tenant,
        scope: k.scope,
        keyHash: k.key_hash,
      })),
    },
    backend: { mode: c.backend.mode, fixtureDir: c.backend.fixture_dir },
    actions: {
      proposalTtlS: c.actions.proposal_ttl_s,
      idempotencyTtlS: c.actions.idempotency_ttl_s,
    },
    log: { format: c.log.format, level: c.log.level },
    store:
      c.store.backend === "redis"
        ? {
            backend: "redis",
            redisUrl: c.store.redis_url!,
            keyPrefix: c.store.key_prefix,
            commandTimeoutMs: c.store.command_timeout_ms,
          }
        : { backend: "memory" },
    shutdown: { drainTimeoutMs: c.shutdown.drain_timeout_ms },
  };
}
