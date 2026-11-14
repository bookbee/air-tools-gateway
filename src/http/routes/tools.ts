/**
 * POST /v1/tools/{name}: run a `read` capability. Read key only.
 */
import type { FastifyInstance } from "fastify";

import type { Clock } from "../../app.js";
import type { CapabilityRegistry } from "../../capabilities/registry.js";
import type { ReadCapability } from "../../capabilities/types.js";
import {
  checkArguments,
  lookupCapability,
  makeCtx,
  TOOL_REQUEST_SCHEMA,
  withDeadline,
  type ToolRequestBody,
} from "../pipeline.js";

export function toolRoutes(deps: { registry: CapabilityRegistry; clock: Clock }) {
  return async function register(app: FastifyInstance) {
    app.post<{ Params: { name: string }; Body: ToolRequestBody }>(
      "/v1/tools/:name",
      {
        config: { auth: "read" },
        preValidation: lookupCapability(deps.registry, "read"),
        schema: { body: TOOL_REQUEST_SCHEMA },
      },
      async (request) => {
        const registered = request.registered!;
        const capability = registered.definition as ReadCapability;
        const { subject } = request.body;
        const args = checkArguments(registered, request.body.arguments, subject);

        const result = await withDeadline(capability, request, (signal) =>
          capability.run(makeCtx(request, subject, signal, deps.clock.now()), args),
        );

        // Contract ToolResult, field by field.
        return {
          capability: capability.name,
          data: result.data,
          truncated: result.truncated,
          as_of: result.asOf.toISOString(),
        };
      },
    );
  };
}
