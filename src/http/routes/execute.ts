/**
 * POST /v1/actions/{name}/execute — execute key only. Handoff §7, "the part that must be
 * exactly right":
 *
 *   1. Replay check first: a stored response for (tenant, Idempotency-Key) is returned
 *      unchanged, and nothing else happens.
 *   2. The proposal, looked up within the key's tenant. Missing, another subject, or another
 *      capability than :name are one identical 404.
 *   3. The per-proposal lock; the replay check again inside it.
 *   4. Expired → 409 proposal_expired. Not open (executed, rejected, pending) under a new
 *      key → 409 already_executed.
 *   5. risk high → pending_approval; nothing performs.
 *   6. perform(): rejected → 200 rejected, nothing changed; else 200 done.
 *   7. The response is stored before the lock is released. A 5xx is not stored, so a retry
 *      with the same key learns the real outcome; perform() is safe to run again.
 *   8. One `action.executed` audit line per execution, with no argument values.
 */
import { randomBytes } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { IdempotencyStore, StoredResponse } from "../../actions/idempotency.js";
import type { KeyedMutex } from "../../actions/locks.js";
import type { Proposal, ProposalStore } from "../../actions/proposals.js";
import type { Clock } from "../../app.js";
import type { CapabilityRegistry } from "../../capabilities/registry.js";
import type { Performed, WriteCapability } from "../../capabilities/types.js";
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
  readonly locks: KeyedMutex;
  readonly metrics: Metrics;
}

interface ExecuteBody {
  proposal_id: string;
  subject: string | null;
}

/** `gx_` + 16 hex characters. */
export function newExecutionId(): string {
  return `gx_${randomBytes(8).toString("hex")}`;
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

    const now = deps.clock.now();
    if (now.getTime() >= proposal.expiresAt.getTime()) {
      return problemResponse(
        new Problem("proposal_expired", "The proposal has expired. Propose the change again."),
        proposal.id,
      );
    }
    if (proposal.state !== "open") {
      return problemResponse(
        new Problem("already_executed", "This proposal has already been executed."),
        proposal.id,
      );
    }

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
      await deps.proposals.setState(tenant, proposal.id, "pending_approval");
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
      await deps.proposals.setState(tenant, proposal.id, "rejected");
      record("rejected");
      return okResponse({ status: "rejected", ...base, code: performed.rejected }, proposal.id);
    }
    await deps.proposals.setState(tenant, proposal.id, "executed");
    record("done");
    return okResponse({ status: "done", ...base, result: performed.result }, proposal.id);
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
        const { tenant } = request.identity!;
        const { proposal_id: proposalId, subject } = request.body;
        const idempotencyKey = request.headers["idempotency-key"];
        if (capability.requiresSubject && subject === null) {
          throw new Problem("invalid_arguments", "subject: required by this capability");
        }

        // 1. Replay first.
        const replay = await deps.idempotency.get(tenant, idempotencyKey);
        if (replay !== null) {
          request.log.info({ proposal_id: replay.proposalId }, "action.replayed");
          return send(request, reply, replay);
        }

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
        const response = await deps.locks.run(`${tenant}\u0000${proposal.id}`, async () => {
          const again = await deps.idempotency.get(tenant, idempotencyKey);
          if (again !== null) return again;
          const decided = await decide(request, capability, proposal);
          // 7. Stored before the lock is released.
          await deps.idempotency.put(tenant, idempotencyKey, decided);
          return decided;
        });
        return send(request, reply, response);
      },
    );
  };
}
