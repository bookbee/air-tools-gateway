/**
 * GET /v1/capabilities: the inventory, built once from the registry. Read key only.
 *
 * Every tenant sees the same capabilities in v1 (docs/enhancements.md, per-tenant sets).
 */
import type { FastifyInstance } from "fastify";

import type { CapabilityRegistry } from "../../capabilities/registry.js";

export function capabilityRoutes(registry: CapabilityRegistry) {
  return async function register(app: FastifyInstance) {
    app.get("/v1/capabilities", { config: { auth: "read" } }, async () => registry.inventory);
  };
}
