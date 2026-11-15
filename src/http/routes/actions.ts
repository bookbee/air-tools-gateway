/**
 * POST /v1/actions/{name}/propose — read key. Prepares a `write` capability; changes nothing.
 * Execute lives in execute.ts.
 */
import type { FastifyInstance } from "fastify";

import {
  hashArgs,
  newProposalId,
  type Proposal,
  type ProposalStore,
} from "../../actions/proposals.js";
import type { Clock } from "../../app.js";
import type { CapabilityRegistry } from "../../capabilities/registry.js";
import type { WriteCapability } from "../../capabilities/types.js";
import { MAX_PROPOSAL_TTL_S } from "../../config.js";
import {
  checkArguments,
  lookupCapability,
  makeCtx,
  TOOL_REQUEST_SCHEMA,
  withDeadline,
  type ToolRequestBody,
} from "../pipeline.js";
import type { Lifecycle } from "../../lifecycle.js";

/** Contract `ProposalResponse.summary.maxLength`. */
const MAX_SUMMARY_LENGTH = 500;

export interface ActionDeps {
  readonly registry: CapabilityRegistry;
  readonly clock: Clock;
  readonly proposals: ProposalStore;
  readonly proposalTtlS: number;
  readonly lifecycle: Lifecycle;
}

export function actionRoutes(deps: ActionDeps) {
  const ttlMs = Math.min(deps.proposalTtlS, MAX_PROPOSAL_TTL_S) * 1000;

  return async function register(app: FastifyInstance) {
    app.post<{ Params: { name: string }; Body: ToolRequestBody }>(
      "/v1/actions/:name/propose",
      {
        config: { auth: "read" },
        preValidation: lookupCapability(deps.registry, "write"),
        schema: { body: TOOL_REQUEST_SCHEMA },
      },
      (request) =>
        deps.lifecycle.track(async () => {
          const registered = request.registered!;
          const capability = registered.definition as WriteCapability;
          const { subject } = request.body;
          const args = checkArguments(registered, request.body.arguments, subject);
          const now = deps.clock.now();

          // prepare() checks and changes nothing. A Problem here (404, 422) stores nothing.
          const prepared = await withDeadline(capability, request, (signal) =>
            capability.prepare(makeCtx(request, subject, signal, now), args),
          );
          if (prepared.summary.length === 0 || prepared.summary.length > MAX_SUMMARY_LENGTH) {
            // A capability bug: the contract caps the summary. Fixed 500, nothing stored.
            throw new Error(`${capability.name}: summary length ${prepared.summary.length}`);
          }

          const proposal: Proposal = {
            id: newProposalId(),
            tenant: request.identity!.tenant,
            subject,
            keyId: request.identity!.keyId,
            capability: capability.name,
            args,
            argsHash: hashArgs(args),
            risk: capability.risk,
            summary: prepared.summary,
            ...(prepared.preview !== undefined ? { preview: prepared.preview } : {}),
            createdAt: now,
            expiresAt: new Date(now.getTime() + ttlMs),
            state: "open",
          };
          await deps.proposals.create(proposal);
          request.log.info(
            { proposal_id: proposal.id, risk: proposal.risk, args_hash: proposal.argsHash },
            "action.proposed",
          );

          // Contract ProposalResponse, field by field.
          return {
            proposal_id: proposal.id,
            capability: proposal.capability,
            risk: proposal.risk,
            summary: proposal.summary,
            expires_at: proposal.expiresAt.toISOString(),
            ...(proposal.preview !== undefined ? { preview: proposal.preview } : {}),
          };
        }),
    );
  };
}
