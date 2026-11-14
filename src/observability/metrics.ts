/**
 * Prometheus metrics, on a registry owned by one app instance (no module-level singletons, so
 * every test gets a clean registry).
 *
 * Label cardinality is bounded: `capability` comes from the registry (at most 64 names, or
 * `none` for an unknown one), `outcome` is `ok` or a closed-set problem code.
 */
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export interface Metrics {
  readonly registry: Registry;
  readonly requests: Counter<"capability" | "kind" | "outcome">;
  readonly duration: Histogram<"capability" | "kind">;
  readonly executions: Counter<"capability" | "status">;
}

export function createMetrics(options: { defaultMetrics?: boolean } = {}): Metrics {
  const registry = new Registry();
  if (options.defaultMetrics ?? true) collectDefaultMetrics({ register: registry });
  return {
    registry,
    requests: new Counter({
      name: "air_tools_gateway_requests_total",
      help: "Capability requests, by capability, kind and outcome (ok or a problem code).",
      labelNames: ["capability", "kind", "outcome"],
      registers: [registry],
    }),
    duration: new Histogram({
      name: "air_tools_gateway_request_duration_seconds",
      help: "Capability request latency.",
      labelNames: ["capability", "kind"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
    executions: new Counter({
      name: "air_tools_gateway_executions_total",
      help: "Execute outcomes, by capability and status.",
      labelNames: ["capability", "status"],
      registers: [registry],
    }),
  };
}
