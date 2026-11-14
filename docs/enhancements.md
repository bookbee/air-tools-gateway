# Suggestions and long-term enhancements

Things to revisit **after** the handoff tasks in `docs/handoff.md` are done. Nothing here
changes v1 scope. Section 1 also feeds the report back to the orchestrator session
(handoff §12).

Status key: **open** (not decided), **interim** (v1 does something specific until it is
decided), **later** (agreed direction, not built yet).

## 1. Contract questions for the orchestrator

The contract (`contract/openapi.yaml`, v0.1.0) is authoritative and is never edited here.
Each item below is raised with the orchestrator session, and any change is versioned there
first.

| # | Contract location | Question | v1 behaviour (interim) |
|---|---|---|---|
| C1 | `paths./v1/actions/{name}/execute.responses` | Execute lists no `400`. A missing or malformed `Idempotency-Key`, unknown body fields, or a null `subject` on a `requires_subject` capability all need one. Add `400: InvalidArguments` to execute? | Return `400 invalid_arguments` and record it as a deviation. |
| C2 | `components.schemas.ProblemCode`, all paths | There is no `500` response and no internal-error code. What should an unexpected error return? | Fixed `500` with `code: upstream_error`, a generic detail, and the stack logged only. |
| C3 | `ExecuteResponse` / rule 8 | After an execute returns `rejected`, may a *different* `Idempotency-Key` try the same proposal again? The contract only covers `already_executed`. | The proposal becomes final. Another key gets `409 already_executed`, so the customer must make a fresh proposal. |
| C4 | `responses.RateLimited` (`429`) | Rate limiting is in the contract, but the handoff does not ask for it. What limits, and per what (key, tenant, subject)? | Not implemented. No `429` is ever returned. |
| C5 | `ExecuteResponse.required` vs handoff §7.5 | The handoff's `{status:"pending_approval"}` and `{status:"rejected", code}` leave out `execution_id` and `capability`, which the contract requires. | Follow the contract: every execute response carries `execution_id` and `capability`. |
| C6 | Rule 11, metric labels | The contract names `air_tools_gateway_requests_total{capability,outcome}`. The handoff adds `kind`. Is the extra label acceptable? | Emit `{capability,kind,outcome}`, which includes the contract's labels. |
| C7 | `ToolRequest.locale` | Is the `summary` text (e.g. `₹1,240.00`) expected to follow `locale`? | Ignore `locale`. Summaries use `en-IN` formatting. |
| C8 | `pending_approval` (spec 0012 §9 Q6) | ~~How does a `pending_approval` outcome resolve?~~ **Answered by the orchestrator (spec 0012 §9 Q6):** the customer asks later, and a later turn looks the record up with a `read` capability (`orders.get`). No push and no status endpoint. Open for the gateway: once an approver acts, `orders.get` must show the result, which needs the approval queue (§3). | Proposal marked `pending_approval`. The response is stored under the idempotency key. Nothing performs. |
| C10 | `info.version` / `Capability.input_schema.description` | On 2026-11-14 the orchestrator's copy gained "must not declare … a top-level `patternProperties`. The orchestrator drops an entry that does." with `info.version` still `0.1.0`, and uncommitted in that repo. The contract's own header says a change must be versioned. Bump to 0.1.1, or is a clarification exempt? | Re-synced byte-for-byte (the drift test caught it). The registry already refused `patternProperties` (step 5), so there's no behaviour change. |
| C11 | `ToolResult.truncated` | "True when the gateway itself left records out (for example, a list cap)." Does that include the caller's own `limit`? | `orders.list_recent` sets `truncated: true` whenever the customer has more orders than were returned, so the planner knows to ask for more. |
| C12 | Rule 8 / execute `Idempotency-Key` | If the same `Idempotency-Key` is sent with a *different* `proposal_id`, should the gateway replay the first response (handoff §7.1: "return it unchanged") or refuse the mismatch (as Stripe does with a 4xx)? The orchestrator derives the key from its own proposal id, so it should never happen. | Replays the first response unchanged, as the handoff says. The replay log line names the original proposal. |
| C13 | Execute, outcome of a 4xx thrown by `perform()` | The contract's execute 200 has `rejected` for refusals. If a capability throws a 4xx Problem instead, what then? | Returned as the problem, stored under the key, proposal left open. `orders.cancel` never does this; it returns `rejected`. |
| C9 | `/v1/actions/{name}/execute`, 404 ordering | Should an unknown or wrong-kind `:name` on execute be `404 unknown_capability` even when the `Idempotency-Key` already has a stored response? | Capability lookup runs before the replay check, so `unknown_capability` wins. |

## 2. Small choices made in v1

These follow the contract's examples or the handoff. Revisit them only if a consumer objects.

- `expected_delivery` for order 55120 is `2026-11-18`, from the contract example. The
  handoff table leaves it blank.
- Problem `type` is `https://air.local/problems/<code>`, from the `NotPossible` example.
- `limit` defaults to 5 through Ajv `useDefaults`, so the default lives in the schema the
  orchestrator also sees.
- `AIR_TOOLS_GATEWAY__ACTIONS__PROPOSAL_TTL_S` over 600 **stops startup** instead of being
  silently capped at 10 minutes (handoff §7 says `min(config TTL, 10 min)`). A
  misconfiguration is visible, and the contract's maximum still holds.
- `AIR_TOOLS_GATEWAY__ACTIONS__IDEMPOTENCY_TTL_S` under 86400 stops startup (contract rule 8).
- `AIR_TOOLS_GATEWAY__LOG__FORMAT` accepts only `json`. A pretty format for local use would
  need `pino-pretty`. Pipe through it instead (`make dev | npx pino-pretty`).
- An unknown path is `404 not_found` before any key check, so an unauthenticated caller can
  tell routes exist. The paths are public in the contract anyway.
- Proposal ids are `gp_` + 12 hex characters. Execution ids are `gx_` + 8 or more hex
  characters.

## 3. Long-term enhancements

### Storage and scale
- **later — Durable proposal and idempotency stores in air-infra's Redis.** v1 keeps them
  in memory, behind `ProposalStore` / `IdempotencyStore`, so a restart loses open proposals and
  the 24 h replay window. Use Redis TTLs and `SET NX` for the replay record.
- **later — A distributed per-proposal lock.** The in-process mutex is only correct with one
  replica. Use a Redis lock with a fencing token, or make the backend's state change
  conditional (compare-and-set on order status), before running more than one replica.
- **open — Graceful shutdown.** Drain in-flight executes on SIGTERM so a deploy doesn't
  produce avoidable "outcome unknown" answers.

### Real backends
- **later — An HTTP adapter for the real order system**, using undici. It needs per-call
  timeouts from `timeoutMs`, connection pooling, and mapping backend errors to
  `upstream_error` / `upstream_timeout` without passing their messages through.
- **later — A circuit breaker per backend**, with `/v1/ready` reflecting breaker state, so a
  failing system fails fast instead of using up the orchestrator's deadline.
- **open — Conditional writes at the backend.** `perform()` re-checks state, but the check
  and the change are two calls. The real cancel should be atomic ("cancel if status in
  {confirmed, packed}"), and backend-side idempotency should be used where offered.
- **later — Backend credentials from a secrets manager**, not env vars, with rotation.

### Security
- **later — Key rotation.** Allow two active digests per tenant and scope while a rotation
  overlaps, and record `key_id` in the audit line to tell them apart.
- **open — Per-key salt or HMAC-SHA256 with a server secret** instead of one shared salt.
  v1 keeps the estate convention (`sha256(salt + raw)`) for parity with air-rag-service.
- **open — Network hardening on air-net.** Consider mTLS or at least a source allow-list,
  since only air-orchestrator-service should reach the gateway.
- **later — Rate limiting** (see C4), per tenant key and per subject, returning `429` with
  `Retry-After`.
- **later — Dependency scanning and an SBOM** in CI, and a pinned base image digest in the
  Dockerfile.

### Capabilities
- **open — Per-tenant capability sets.** `/v1/capabilities` is "every capability this key's
  tenant may use". In v1 every tenant gets the same three. Add a per-tenant enable list once
  a second real tenant needs it.
- **later — More order capabilities**: `orders.track`, `orders.return` (write) and
  `orders.update_address` (write, `medium` risk), each with descriptions written for the
  planner.
- **later — An approval queue for `high` risk** (see C8): store, notify an approver, and
  give a way to fetch the outcome. This needs a contract change first.
- **open — Limits** (`limit_exceeded`, `not_permitted`): per-customer caps such as
  cancellations per day, enforced in both `prepare()` and `perform()`.

### Observability and audit
- **later — Durable audit trail.** `action.executed` is a log line today. Ship it to an
  append-only store (Postgres or Mongo via air-infra) so executions can be queried and
  kept.
- **later — Tracing** with OpenTelemetry, propagating `X-Request-ID` / `traceparent` from
  the orchestrator through to backend calls.
- **open — Alerting** on `upstream_timeout` rate for execute, which means outcomes the
  customer was told are unknown.

### Contract and delivery
- **later — Contract drift check in CI.** Compare `contract/openapi.yaml` to the
  orchestrator's copy on every build and fail when they differ.
- **open — Joint SIT automation.** Run the orchestrator and gateway together on air-net
  with this fixture data, as a scripted check rather than a manual walkthrough.
- **later — Load test** of the execute path under concurrency, to prove "acts once" beyond
  the unit test.
