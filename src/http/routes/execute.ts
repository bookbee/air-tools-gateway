/**
 * POST /v1/actions/{name}/execute — execute key only. Handoff §7, "the part that must be
 * exactly right":
 *
 *   1. Replay check first: a stored response for (tenant, Idempotency-Key) is returned
 *      unchanged, and nothing else happens. The record is bound to the request it was first
 *      stored for (proposal, subject, capability): the same key with another request is
 *      400 invalid_arguments and nothing happens (TG-001, decision C12 revised).
 *   2. The proposal, looked up within the key's tenant. Missing, another subject, or another
 *      capability than :name are one identical 404.
 *   3. The per-proposal lock (in-process, or Redis across replicas); the replay check again
 *      inside it. Waiting longer than one holder's deadline → 504, not stored.
 *   4. Expired → 409 proposal_expired. Not open (executed, rejected, pending) under a new
 *      key → 409 already_executed.
 *   5. risk high → pending_approval; nothing performs.
 *   6. perform(): rejected → 200 rejected, nothing changed; else 200 done.
 *   7. The response is stored before the lock is released, first writer wins. A 5xx is not
 *      stored, so a retry with the same key learns the real outcome; perform() is safe to run
 *      again. Every state change is a compare-and-set from `open`, so even two executes that
 *      both got past the lock (one stalled past its expiry) finalise the proposal once.
 *   8. One `action.executed` audit line per execution, with no argument values.
 */
import { randomBytes } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { IdempotencyStore, StoredResponse } from "../../actions/idempotency.js";
import { LockTimeoutError, type ProposalLock } from "../../actions/locks.js";
import type { Proposal, ProposalState, ProposalStore } from "../../actions/proposals.js";
import type { Clock } from "../../app.js";
import type { CapabilityRegistry } from "../../capabilities/registry.js";
import type { Performed, WriteCapability } from "../../capabilities/types.js";
import type { Lifecycle } from "../../lifecycle.js";
import type { Metrics } from "../../observability/metrics.js";
import { EXECUTE_REQUEST_SCHEMA, lookupCapability, makeCtx, withDeadline } from "../pipeline.js";
import { PROBLEM_CONTENT_TYPE, Problem, type ProblemBody } from "../problems.js";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/** Contract: 16–128 characters of [A-Za-z0-9_.:-]. */
const IDEMPOTENCY_HEADERS_SCHEMA = {
  type: "object",
  required: ["idempotency-key"],
  properties: {
    "idempotency-key": {
      type: "string",
      minLength: 16,
      maxLength: 128,
      pattern: "^[A-Za-z0-9_.:-]+$",
    },
  },
} as const;

export interface ExecuteDeps {
  readonly registry: CapabilityRegistry;
  readonly clock: Clock;
  readonly proposals: ProposalStore;
  readonly idempotency: IdempotencyStore;
  readonly locks: ProposalLock;
  readonly metrics: Metrics;
  readonly lifecycle: Lifecycle;
}

interface ExecuteBody {
  proposal_id: string;
  subject: string | null;
}

/** `gx_` + 16 hex characters. */
export function newExecutionId(): string {
  return `gx_${randomBytes(8).toString("hex")}`;
}

/**
 * How long past the capability's deadline the lock is held at most: the store calls around
 * perform(). A distributed lock expires after `timeoutMs + LOCK_MARGIN_MS`.
 */
export const LOCK_MARGIN_MS = 5000;

/** The same key with a different request: refused, not replayed, never stored (TG-001). */
const keyReused = () =>
  new Problem(
    "invalid_arguments",
    "This Idempotency-Key was already used for a different request.",
  );

/** Whether a stored record belongs to this request. Older records carry only a proposal id. */
function sameRequest(
  stored: StoredResponse,
  proposalId: string,
  subject: string | null,
  capability: string,
): boolean {
  return (
    stored.proposalId === proposalId &&
    (stored.subject === undefined || stored.subject === subject) &&
    (stored.capability === undefined || stored.capability === capability)
  );
}

/** One answer for "missing", "not this subject's" and "not this capability's". */
const proposalNotFound = () => new Problem("not_found", "No such proposal.");

function problemResponse(problem: Problem, proposalId: string): StoredResponse {
  return {
    status: problem.status,
    contentType: PROBLEM_CONTENT_TYPE,
    body: problem.toBody(),
    proposalId,
  };
}

function okResponse(body: object, proposalId: string): StoredResponse {
  return { status: 200, contentType: JSON_CONTENT_TYPE, body, proposalId };
}

function send(request: FastifyRequest, reply: FastifyReply, response: StoredResponse) {
  if (response.contentType === PROBLEM_CONTENT_TYPE) {
    request.problemCode = (response.body as ProblemBody).code;
  }
  return reply.code(response.status).type(response.contentType).send(response.body);
}

export function executeRoutes(deps: ExecuteDeps) {
  /** Steps 4–6, inside the lock. Returns the response to store; throws a 5xx Problem. */
  async function decide(
    request: FastifyRequest,
    capability: WriteCapability,
    found: Proposal,
  ): Promise<StoredResponse> {
    const { tenant } = request.identity!;
    // Re-read inside the lock: another execute may have just changed the state.
    const proposal = await deps.proposals.get(tenant, found.id);
    if (proposal === null) return problemResponse(proposalNotFound(), found.id);

    const alreadyExecuted = () =>
      problemResponse(
        new Problem("already_executed", "This proposal has already been executed."),
        proposal.id,
      );
    const now = deps.clock.now();
    if (now.getTime() >= proposal.expiresAt.getTime()) {
      return problemResponse(
        new Problem("proposal_expired", "The proposal has expired. Propose the change again."),
        proposal.id,
      );
    }
    if (proposal.state !== "open") return alreadyExecuted();

    /** Compare-and-set from open. False: another execute finalised it first. */
    const finalise = async (to: ProposalState) => {
      const moved = await deps.proposals.transition(tenant, proposal.id, "open", to);
      if (!moved) request.log.warn({ proposal_id: proposal.id, to }, "action.lost_race");
      return moved;
    };

    const executionId = newExecutionId();
    const record = (status: "done" | "rejected" | "pending_approval") => {
      deps.metrics.executions.inc({ capability: capability.name, status });
      request.log.info(
        { proposal_id: proposal.id, execution_id: executionId, status },
        "action.executed",
      );
    };
    const base = { execution_id: executionId, capability: capability.name };

    if (proposal.risk === "high") {
      if (!(await finalise("pending_approval"))) return alreadyExecuted();
      record("pending_approval");
      return okResponse({ status: "pending_approval", ...base }, proposal.id);
    }

    let performed: Performed;
    try {
      performed = await withDeadline(capability, request, (signal) =>
        capability.perform(
          { ...makeCtx(request, proposal.subject, signal, now), proposalId: proposal.id },
          proposal.args,
        ),
      );
    } catch (error) {
      if (error instanceof Problem && error.status < 500) {
        // A definite refusal from the capability: final, and nothing changed.
        return problemResponse(error, proposal.id);
      }
      // Timeout, backend failure or bug: the outcome is unknown. Not stored, proposal
      // stays open, so the same Idempotency-Key can learn the real outcome later.
      deps.metrics.executions.inc({ capability: capability.name, status: "unknown" });
      request.log.warn(
        { proposal_id: proposal.id, execution_id: executionId },
        "action.execution_unknown",
      );
      throw error;
    }

    if ("rejected" in performed) {
      if (!(await finalise("rejected"))) return alreadyExecuted();
      record("rejected");
      return okResponse({ status: "rejected", ...base, code: performed.rejected }, proposal.id);
    }
    // Lost race: the other execute ran perform() too, which the backend's idempotency
    // reference (the proposal id) made a no-op. Its response is the one that counts.
    if (!(await finalise("executed"))) return alreadyExecuted();
    record("done");
    return okResponse({ status: "done", ...base, result: performed.result }, proposal.id);
  }

  /** Steps 1–3 and 7. */
  async function answer(
    request: FastifyRequest,
    capability: WriteCapability,
    proposalId: string,
    subject: string | null,
    idempotencyKey: string,
  ): Promise<StoredResponse> {
    const { tenant } = request.identity!;
    /** A stored record for this key: replayed if it is this request's, refused otherwise. */
    const replayOrRefuse = (stored: StoredResponse): StoredResponse => {
      if (!sameRequest(stored, proposalId, subject, capability.name)) {
        request.log.warn({ proposal_id: proposalId }, "action.idempotency_key_reused");
        throw keyReused();
      }
      request.log.info({ proposal_id: stored.proposalId }, "action.replayed");
      return stored;
    };

    // 1. Replay first.
    const replay = await deps.idempotency.get(tenant, idempotencyKey);
    if (replay !== null) return replayOrRefuse(replay);

    // 2. Tenant-scoped lookup; three mismatches, one answer.
    const proposal = await deps.proposals.get(tenant, proposalId);
    if (
      proposal === null ||
      proposal.subject !== subject ||
      proposal.capability !== capability.name
    ) {
      throw proposalNotFound();
    }

    // 3. One execute of this proposal at a time.
    const holdMs = capability.timeoutMs + LOCK_MARGIN_MS;
    try {
      return await deps.locks.run(
        `${tenant}:${proposal.id}`,
        { holdMs, waitMs: holdMs },
        async () => {
          const again = await deps.idempotency.get(tenant, idempotencyKey);
          if (again !== null) return replayOrRefuse(again);
          const decided = await decide(request, capability, proposal);
          // 7. Stored before the lock is released; the first stored response wins.
          const stored = await deps.idempotency.putIfAbsent(tenant, idempotencyKey, {
            ...decided,
            subject,
            capability: capability.name,
          });
          if (sameRequest(stored, proposalId, subject, capability.name)) return stored;
          // A reused key raced us (another proposal's execute stored first, under its own
          // lock). This proposal was still decided: answer its real outcome, unstored.
          request.log.warn({ proposal_id: proposalId }, "action.idempotency_key_reused");
          return decided;
        },
      );
    } catch (error) {
      if (!(error instanceof LockTimeoutError)) throw error;
      request.log.warn({ proposal_id: proposal.id }, "action.lock_timeout");
      throw new Problem(
        "upstream_timeout",
        "Another execute of this proposal is still running. Retry with the same Idempotency-Key.",
      );
    }
  }

  return async function register(app: FastifyInstance) {
    app.post<{
      Params: { name: string };
      Body: ExecuteBody;
      Headers: { "idempotency-key": string };
    }>(
      "/v1/actions/:name/execute",
      {
        config: { auth: "execute" },
        preValidation: lookupCapability(deps.registry, "write"),
        schema: { body: EXECUTE_REQUEST_SCHEMA, headers: IDEMPOTENCY_HEADERS_SCHEMA },
      },
      async (request, reply) => {
        const capability = request.registered!.definition as WriteCapability;
        const { proposal_id: proposalId, subject } = request.body;
        const idempotencyKey = request.headers["idempotency-key"];
        if (capability.requiresSubject && subject === null) {
          throw new Problem("invalid_arguments", "subject: required by this capability");
        }

        // Tracked, so a shutdown waits for the answer to be stored before closing the store.
        const response = await deps.lifecycle.track(() =>
          answer(request, capability, proposalId, subject, idempotencyKey),
        );
        return send(request, reply, response);
      },
    );
  };
}
