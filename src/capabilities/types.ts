/**
 * Capability definitions (handoff §5). A capability is a plain object; the registry turns the
 * list into the advertised inventory and the served routes, so the two cannot drift.
 *
 * `args` arrive already validated against `inputSchema` (defaults applied), and `ctx.subject`
 * is non-null whenever `requiresSubject` is true. Implementations narrow `args` themselves.
 */
import type { FastifyBaseLogger } from "fastify";

import type { ProblemCode } from "../http/problems.js";

export type Risk = "low" | "medium" | "high";
export type CapabilityKind = "read" | "write";

/** Contract: JSON Schema 2020-12, closed, never declaring `subject` or `tenant`. */
export interface JsonSchemaObject {
  readonly type: "object";
  readonly additionalProperties: false;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly [keyword: string]: unknown;
}

export interface Ctx {
  readonly tenant: string;
  readonly subject: string | null;
  readonly keyId: string;
  readonly requestId: string;
  /** Aborts at the capability's `timeoutMs`; pass it to every backend call. */
  readonly signal: AbortSignal;
  /** Request-scoped: already carries request_id, key_id, tenant, capability, subject_tag. */
  readonly log: FastifyBaseLogger;
  /** The request's clock reading, so a capability never calls `new Date()` itself. */
  readonly now: Date;
}

interface CapabilityBase {
  readonly name: string;
  readonly version: number;
  /** Read by the orchestrator's planner (a model): plain sentences, customer phrasings. */
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  readonly requiresSubject: boolean;
  readonly timeoutMs: number;
}

export interface ReadResult {
  readonly data: object;
  readonly truncated: boolean;
  readonly asOf: Date;
}

export interface ReadCapability extends CapabilityBase {
  readonly kind: "read";
  run(ctx: Ctx, args: unknown): Promise<ReadResult>;
}

export interface Prepared {
  /** What executing would do, in the customer's terms (≤ 500 characters). */
  readonly summary: string;
  readonly preview?: object;
}

export type Performed = { readonly result: object } | { readonly rejected: ProblemCode };

/** Execute's context: also the proposal being executed, the backend's idempotency reference. */
export interface ExecuteCtx extends Ctx {
  readonly proposalId: string;
}

export interface WriteCapability extends CapabilityBase {
  readonly kind: "write";
  readonly risk: Risk;
  /** Check ownership and current state; change NOTHING. Throw a Problem when not possible. */
  prepare(ctx: Ctx, args: unknown): Promise<Prepared>;
  /** Re-check everything, then act once. Must be safe to call again after a timeout. */
  perform(ctx: ExecuteCtx, args: unknown): Promise<Performed>;
}

export type Capability = ReadCapability | WriteCapability;
