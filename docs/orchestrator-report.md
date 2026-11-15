# Report to air-orchestrator-service (spec 0012)

From the air-tools-gateway session, per `docs/handoff.md` §12. The gateway is built and
passing: `make check` (213 tests, every response validated against the contract) and
`sit/smoke.sh` (13 checks of the handoff §11 flow).

## Where it is

| From | Base URL |
|---|---|
| Host | `http://localhost:8084` |
| `air-net` | `http://air-tools-gateway:8080` |

Start it with `make up` (needs air-net) or `make run-sit` (host). The fixture store is in
memory and resets on restart.

## Development keys

Salt `air-tools-gateway-dev-salt`; only digests are configured on the gateway side.

| Tenant | `read` key | `execute` key |
|---|---|---|
| `brightcart` | `airtg_read_local_dev` | `airtg_exec_local_dev` |
| `othershop` | `airtg_read_othershop_dev` | `airtg_exec_othershop_dev` |

Fixture subjects: brightcart `cust_1001` (48213 in transit, 55120 confirmed, 61007 delivered),
`cust_1002` (70011 packed); othershop `cust_2001` (its own 55120, ₹799), `cust_1001` (90001).

## Contract built against

`info.version` **0.1.0**, file sha256 `c13f7880ebd7882f…`: your working copy as of
2026-11-14 23:39, including the uncommitted `patternProperties` line (see C10). A test
fails here whenever the two copies differ.

## Questions and deviations

Line numbers are in `contract.openapi.yaml`.

| # | Line | Question | What the gateway does now |
|---|---|---|---|
| C1 | 284 (execute responses) | Execute declares no `400`, but a missing or malformed `Idempotency-Key` (298), unknown body fields, or a null subject need one. Add `400: InvalidArguments`? | **Deviation:** returns `400 invalid_arguments`. |
| C2 | 572 (`ProblemCode`) | No `500` response and no internal code anywhere. | **Deviation:** a fixed `500` with `code: upstream_error`. |
| C3 | 41 (rule 8), 333 | After `rejected`, may a *different* `Idempotency-Key` retry the same proposal? | No: the proposal is final, and another key gets `409 already_executed`. |
| C4 | 400 (`RateLimited`) | What limits, per what? | Not implemented; `429` never sent. |
| C5 | 556 (`ExecuteResponse`) | The handoff's `pending_approval` / `rejected` bodies omit required fields. | Follows the contract: `execution_id` and `capability` are always present. |
| C6 | 51 (rule 11) | Metric is named `{capability,outcome}`; we add `kind`. OK? | Emits `{capability,kind,outcome}`. |
| C7 | 505 (`locale`) | Should `summary` follow `locale`? | Ignored; `en-IN` formatting (`₹1,240.00`). |
| C8 | 556, spec §9 Q6 | Answered by Q6 (check later via `orders.get`). Open on our side: showing the approved outcome needs an approval queue. | `pending_approval` stored and replayed; nothing performs. |
| C9 | 284 | Unknown `:name` on execute vs a stored replay: which wins? | Capability lookup runs first, so `unknown_capability`. |
| C10 | 482 (`input_schema`) | The `patternProperties` rule was added with `info.version` still 0.1.0, and uncommitted. Bump to 0.1.1? | Re-synced byte-for-byte; the registry already refused it. |
| C11 | 518 (`truncated`) | Does "the gateway left records out" include the caller's own `limit`? | `true` whenever the customer has more orders than returned. |
| C12 | 298, rule 8 | Same `Idempotency-Key` with a *different* `proposal_id`: replay or refuse? | **Revised 2026-11-15 (TG-001):** refused with `400 invalid_arguments`, nothing performed or stored. Same key, same request still replays unchanged. Open: 400 (C1) or a declared 422? |
| C13 | 284 | If `perform()` throws a 4xx instead of returning `rejected`? | Returned and stored; proposal left open. `orders.cancel` never does this. |

## Behaviour worth knowing on your side

- A `504` on execute is never stored, and the proposal stays open. Retrying with the same
  `Idempotency-Key` returns the real outcome: `done` if the cancel happened, without a second
  refund. That matters if you ever let an operator retry, since REQ-TGW-018 forbids automatic
  retries.
- `orders.cancel`'s `summary` is the contract example's text exactly.
- Not found, not this subject's and not this capability's are byte-identical 404s, for both
  orders and proposals.

## Since this report (2026-11-15)

- **State survives restarts on air-net.** Proposals and idempotency records now live in
  air-infra's Redis (`airtg:*`), so a replay after a gateway restart returns the stored answer.
  The fixture orders still reset on restart.
- **New 5xx causes, same codes.** If Redis is unavailable, propose and execute answer
  `502 upstream_error`, and `/v1/ready` is 503 with `{"name":"store","ok":false}`. An execute
  that waited too long behind another execute of the same proposal gets
  `504 upstream_timeout`. Neither is stored, so retrying with the same `Idempotency-Key` is
  safe.
- **Draining.** On SIGTERM, `/v1/ready` is 503 with `{"name":"draining","ok":false}` while
  running executes finish.
- **Your `make sit-tools`** now runs as step 4 of our `make sit-joint`.
- **A reused `Idempotency-Key` is refused (TG-001, C12 revised).** The same key with a
  different `proposal_id`, `subject` or capability now gets `400 invalid_arguments`
  ("This Idempotency-Key was already used for a different request.") and nothing performs.
  It used to replay the first response, which could hand one customer another's result.
  Keys derived from your `prop_` id never hit this. Open question: keep 400 (the C1
  deviation) or declare 422 on execute?
- **A SIT customer, `cust_1003` (Brightcart).** Seven orders, newest first: 80101
  confirmed, 80102 packed, 80103 confirmed (all three cancellable), 80104 in transit, 80105
  already cancelled, 80106 delivered (returnable), 80107 delivered. `orders.list_recent` at
  the default limit returns five with `truncated: true`. The existing customers are
  unchanged.
