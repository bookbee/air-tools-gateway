/**
 * Estate conventions (contract rule 11): liveness, readiness and metrics. No key needed.
 */
import type { FastifyInstance } from "fastify";

import type { Metrics } from "../../observability/metrics.js";

export interface ReadinessCheck {
  readonly name: string;
  /** Resolve true when the dependency can serve. A throw or a timeout counts as not ready. */
  check(signal: AbortSignal): Promise<boolean>;
}

const READY_CHECK_TIMEOUT_MS = 2000;

async function runCheck(check: ReadinessCheck): Promise<{ name: string; ok: boolean }> {
  const signal = AbortSignal.timeout(READY_CHECK_TIMEOUT_MS);
  const timedOut = new Promise<boolean>((resolve) => {
    signal.addEventListener("abort", () => resolve(false), { once: true });
  });
  try {
    const ok = await Promise.race([check.check(signal), timedOut]);
    return { name: check.name, ok: ok === true };
  } catch {
    return { name: check.name, ok: false };
  }
}

export function systemRoutes(deps: { checks: readonly ReadinessCheck[]; metrics: Metrics }) {
  return async function register(app: FastifyInstance) {
    app.get("/v1/health", { config: { auth: "none" } }, async () => ({ status: "ok" as const }));

    app.get("/v1/ready", { config: { auth: "none" } }, async (request, reply) => {
      const checks = await Promise.all(deps.checks.map(runCheck));
      const ready = checks.every((c) => c.ok);
      if (!ready) request.log.warn({ checks }, "ready.not_ready");
      return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready", checks });
    });

    app.get("/metrics", { config: { auth: "none" } }, async (_request, reply) => {
      return reply
        .type(deps.metrics.registry.contentType)
        .send(await deps.metrics.registry.metrics());
    });
  };
}
