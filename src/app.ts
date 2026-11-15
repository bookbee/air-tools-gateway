/**
 * buildApp(config, deps) → a Fastify instance, not yet listening.
 *
 * No globals: the logger, metrics registry, clock and backends all come in through `deps` or
 * are made here, so each test builds its own app.
 */
import Fastify, { LogController } from "fastify";
import type { DestinationStream } from "pino";

import { InMemoryIdempotencyStore, type IdempotencyStore } from "./actions/idempotency.js";
import { KeyedMutex, type ProposalLock } from "./actions/locks.js";
import { InMemoryProposalStore, type ProposalStore } from "./actions/proposals.js";
import { createRedis, pingRedis, RedisKeys } from "./actions/redis/client.js";
import { RedisIdempotencyStore } from "./actions/redis/idempotency.js";
import { RedisLock } from "./actions/redis/lock.js";
import { RedisProposalStore } from "./actions/redis/proposals.js";
import { StoreError } from "./actions/storeError.js";
import { Lifecycle } from "./lifecycle.js";
import { FixtureOrdersBackend } from "./backends/fixture/ordersFixture.js";
import type { OrdersBackend } from "./backends/orders.js";
import { orderCapabilities } from "./capabilities/index.js";
import { CapabilityRegistry } from "./capabilities/registry.js";
import type { Capability } from "./capabilities/types.js";
import type { Config } from "./config.js";
import type { Redis } from "ioredis";
import { authenticate, type RouteAuth } from "./http/auth.js";
import {
  INTERNAL_PROBLEM,
  Problem,
  sendProblem,
  toProblem,
  type ProblemCode,
} from "./http/problems.js";
import { echoRequestId, genRequestId } from "./http/requestId.js";
import { capabilityRoutes } from "./http/routes/capabilities.js";
import { actionRoutes } from "./http/routes/actions.js";
import { executeRoutes } from "./http/routes/execute.js";
import { toolRoutes } from "./http/routes/tools.js";
import { systemRoutes, type ReadinessCheck } from "./http/routes/system.js";
import { createLogger, type Logger } from "./observability/logger.js";
import { createMetrics, type Metrics } from "./observability/metrics.js";
import { KeyRing, type KeyIdentity } from "./security/apiKeys.js";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface AppDeps {
  /** Where log lines go (tests capture them). Defaults to stdout. */
  logDestination?: DestinationStream;
  logger?: Logger;
  metrics?: Metrics;
  clock?: Clock;
  /** Replaces the default checks (the orders backend). */
  readiness?: readonly ReadinessCheck[];
  /** Defaults to the fixture store in `config.backend.fixtureDir`. */
  ordersBackend?: OrdersBackend;
  /** Overrides `config.store` for proposals. */
  proposals?: ProposalStore;
  /** Overrides `config.store` for idempotency records. */
  idempotency?: IdempotencyStore;
  /** Overrides `config.store` for the per-proposal lock. */
  locks?: ProposalLock;
  /**
   * With `config.store.backend = redis`: a client to use instead of opening one (tests share
   * one between app instances). The app does not close a client it was given.
   */
  redis?: Redis;
  /** The capabilities to serve. Validated by the registry; an invalid one stops startup. */
  capabilities?: readonly Capability[];
}

export interface CapabilityLabel {
  readonly name: string;
  readonly kind: "read" | "write";
}

declare module "fastify" {
  interface FastifyContextConfig {
    auth?: RouteAuth;
  }
  interface FastifyInstance {
    registry: CapabilityRegistry;
    lifecycle: Lifecycle;
  }
  interface FastifyRequest {
    identity: KeyIdentity | null;
    problemCode: ProblemCode | null;
    capability: CapabilityLabel | null;
  }
}

const BODY_LIMIT_BYTES = 64 * 1024;

export function buildApp(config: Config, deps: AppDeps = {}) {
  const logger = deps.logger ?? createLogger(config.log, deps.logDestination);
  const metrics = deps.metrics ?? createMetrics();
  const keys = new KeyRing(config.security.apiKeys, config.security.hashSalt);
  const orders = deps.ordersBackend ?? new FixtureOrdersBackend(config.backend.fixtureDir, logger);
  const clock = deps.clock ?? systemClock;
  const stores = buildStores(config, deps, clock, logger);
  const { proposals, idempotency, locks } = stores;
  const lifecycle = new Lifecycle();
  const readiness = deps.readiness ?? [
    { name: "orders_backend", check: (signal: AbortSignal) => orders.ping(signal) },
    ...stores.readiness,
  ];
  // Throws RegistryError on any contract-rule violation: startup stops here.
  const registry = new CapabilityRegistry(deps.capabilities ?? orderCapabilities(orders));

  const app = Fastify({
    loggerInstance: logger,
    // One `request.completed` line per request comes from our onResponse hook instead.
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: "request_id",
    }),
    genReqId: genRequestId,
    bodyLimit: BODY_LIMIT_BYTES,
    // While draining, requests already on a kept-alive connection are served normally rather
    // than given Fastify's own 503 body, which the contract does not declare.
    return503OnClosing: false,
    ajv: {
      // Fastify's defaults strip unknown fields and coerce types. The contract wants unknown
      // fields refused (400) and types taken as sent.
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        useDefaults: false,
        allErrors: true,
      },
    },
  });

  app.decorateRequest("identity", null);
  app.decorateRequest("problemCode", null);
  app.decorateRequest("capability", null);
  app.decorateRequest("registered", null);

  app.addHook("onRequest", echoRequestId);
  app.addHook("onRequest", authenticate(keys));

  app.addHook("onResponse", async (request, reply) => {
    const capability = request.capability;
    const outcome = reply.statusCode < 400 ? "ok" : (request.problemCode ?? "upstream_error");
    if (capability !== null) {
      metrics.requests.inc({ capability: capability.name, kind: capability.kind, outcome });
      metrics.duration.observe(
        { capability: capability.name, kind: capability.kind },
        reply.elapsedTime / 1000,
      );
    }
    // Probes and scrapes are frequent and uninteresting unless they fail.
    if (request.routeOptions.config.auth === "none" && reply.statusCode < 400) return;
    request.log.info(
      {
        // A served capability is already bound to request.log by the lookup hook.
        ...(request.registered === null ? { capability: capability?.name ?? null } : {}),
        outcome,
        status: reply.statusCode,
        duration_ms: Math.round(reply.elapsedTime),
      },
      "request.completed",
    );
  });

  app.setErrorHandler((thrown, request, reply) => {
    const error = thrown instanceof Error ? thrown : new Error("non-Error value thrown");
    if (error instanceof StoreError) {
      request.log.error({ code: error.code }, "store.error");
      return sendProblem(
        request,
        reply,
        new Problem("upstream_error", "The gateway's store is unavailable. Retry later."),
      );
    }
    const problem = toProblem(error);
    if (problem !== null) return sendProblem(request, reply, problem);
    // The stack goes to the log only; the caller gets a fixed body.
    request.log.error({ err: error }, "request.unhandled_error");
    return sendProblem(request, reply, INTERNAL_PROBLEM);
  });

  app.setNotFoundHandler((request, reply) =>
    sendProblem(request, reply, new Problem("not_found", "No such endpoint.")),
  );

  void app.register(systemRoutes({ checks: readiness, metrics, lifecycle }));
  void app.register(capabilityRoutes(registry));
  void app.register(toolRoutes({ registry, clock }));
  void app.register(
    actionRoutes({
      registry,
      clock,
      proposals,
      proposalTtlS: config.actions.proposalTtlS,
      lifecycle,
    }),
  );
  void app.register(
    executeRoutes({ registry, clock, proposals, idempotency, locks, metrics, lifecycle }),
  );
  app.decorate("registry", registry);
  app.decorate("lifecycle", lifecycle);
  // Close the store only after every running propose and execute has stored its answer.
  app.addHook("onClose", async () => {
    await lifecycle.idle();
    await stores.close();
  });

  return app;
}

/**
 * Proposals, idempotency records and the lock, from `config.store`. Expired proposals are
 * kept as long as idempotency records, so a late execute learns `proposal_expired` instead
 * of a bare 404.
 */
function buildStores(config: Config, deps: AppDeps, clock: Clock, logger: Logger) {
  const retentionS = config.actions.idempotencyTtlS;
  if (config.store.backend === "memory") {
    return {
      proposals: deps.proposals ?? new InMemoryProposalStore(clock, retentionS),
      idempotency: deps.idempotency ?? new InMemoryIdempotencyStore(clock, retentionS),
      locks: deps.locks ?? new KeyedMutex(),
      readiness: [] as ReadinessCheck[],
      close: async () => {},
    };
  }
  const owned = deps.redis === undefined;
  const redis = deps.redis ?? createRedis(config.store, logger);
  const keys = new RedisKeys(config.store.keyPrefix);
  return {
    proposals: deps.proposals ?? new RedisProposalStore(redis, keys, clock, retentionS),
    idempotency: deps.idempotency ?? new RedisIdempotencyStore(redis, keys, retentionS),
    locks: deps.locks ?? new RedisLock(redis, keys, logger),
    readiness: [{ name: "store", check: () => pingRedis(redis) }] as ReadinessCheck[],
    close: async () => {
      if (owned) await redis.quit().catch(() => redis.disconnect());
    },
  };
}

export type App = ReturnType<typeof buildApp>;
