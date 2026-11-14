/**
 * The request pipeline shared by the tools and actions routes (handoff §6):
 *
 *   1. request id            (onRequest, requestId.ts)
 *   2. auth and scope        (onRequest, auth.ts)
 *   3. capability lookup     (preValidation, `lookupCapability`) — by name AND route kind
 *   4. envelope validation   (Fastify route schema, closed)
 *   5. argument validation   (`checkArguments`, the capability's compiled schema)
 *   6. subject check         (`checkArguments`)
 *   7. handler under a deadline (`withDeadline`)
 *   8. response shaping      (each route builds the contract's fields explicitly)
 *   9. one error handler     (app.ts)
 */
import type { FastifyReply, FastifyRequest } from "fastify";

import { BackendError } from "../backends/orders.js";
import type { CapabilityRegistry, RegisteredCapability } from "../capabilities/registry.js";
import type { Capability, CapabilityKind, Ctx } from "../capabilities/types.js";
import { subjectTag } from "../observability/logger.js";
import { Problem } from "./problems.js";

/** Metric label for a name the registry does not serve, so callers cannot add label values. */
export const UNKNOWN_CAPABILITY_LABEL = "unknown";

const SUBJECT_SCHEMA = { type: ["string", "null"], maxLength: 128 } as const;

/** Contract `ToolRequest`: the envelope for tools and propose. */
export const TOOL_REQUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["arguments", "subject"],
  properties: {
    arguments: { type: "object" },
    subject: SUBJECT_SCHEMA,
    locale: { type: "string", maxLength: 16 },
  },
} as const;

/** Contract `ExecuteRequest`. */
export const EXECUTE_REQUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["proposal_id", "subject"],
  properties: {
    proposal_id: { type: "string", maxLength: 128 },
    subject: SUBJECT_SCHEMA,
  },
} as const;

export interface ToolRequestBody {
  arguments: Record<string, unknown>;
  subject: string | null;
  locale?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    registered: RegisteredCapability | null;
  }
}

/** Step 3, as a preValidation hook: the name must be a capability of this route's kind. */
export function lookupCapability(registry: CapabilityRegistry, kind: CapabilityKind) {
  return async function lookupHook(request: FastifyRequest, _reply: FastifyReply) {
    const { name } = request.params as { name: string };
    const registered = registry.get(name, kind);
    if (registered === null) {
      request.capability = { name: UNKNOWN_CAPABILITY_LABEL, kind };
      throw new Problem("unknown_capability", `No ${kind} capability with that name.`);
    }
    request.registered = registered;
    request.capability = { name: registered.definition.name, kind };
    request.log = request.log.child({ capability: registered.definition.name });
  };
}

/** Steps 5 and 6. Returns the validated arguments, defaults applied. */
export function checkArguments(
  registered: RegisteredCapability,
  args: unknown,
  subject: string | null,
): Record<string, unknown> {
  const checked = registered.checkArgs(args);
  if (!checked.ok) throw new Problem("invalid_arguments", checked.detail);
  if (registered.definition.requiresSubject && subject === null) {
    throw new Problem("invalid_arguments", "subject: required by this capability");
  }
  return checked.value;
}

export function makeCtx(
  request: FastifyRequest,
  subject: string | null,
  signal: AbortSignal,
  now: Date,
): Ctx {
  const identity = request.identity;
  if (identity === null) throw new Error("makeCtx called before authentication");
  const tag = subjectTag(subject);
  if (tag !== null) request.log = request.log.child({ subject_tag: tag });
  return {
    tenant: identity.tenant,
    subject,
    keyId: identity.keyId,
    requestId: request.id,
    signal,
    log: request.log,
    now,
  };
}

class DeadlineExceeded extends Error {
  constructor() {
    super("deadline exceeded");
    this.name = "DeadlineExceeded";
  }
}

/**
 * Step 7: run `fn` under the capability's timeout. The signal is passed to the backend; the
 * race also covers a backend that ignores it.
 *
 * - deadline passed            → 504 upstream_timeout
 * - a Problem from the handler → itself
 * - BackendError               → 502 upstream_error (its message logged, never returned)
 * - anything else              → rethrown, so the error handler answers a fixed 500
 */
export async function withDeadline<T>(
  capability: Capability,
  request: FastifyRequest,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const reason = new DeadlineExceeded();
      controller.abort(reason);
      reject(reason);
    }, capability.timeoutMs);
  });
  try {
    return await Promise.race([fn(controller.signal), deadline]);
  } catch (error) {
    if (error instanceof Problem) throw error;
    if (error instanceof DeadlineExceeded || controller.signal.aborted) {
      request.log.warn({ timeout_ms: capability.timeoutMs }, "capability.timeout");
      throw new Problem("upstream_timeout", "The business system did not answer in time.");
    }
    if (error instanceof BackendError) {
      request.log.error({ err: error }, "capability.backend_error");
      throw new Problem("upstream_error", "The business system could not complete the request.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
