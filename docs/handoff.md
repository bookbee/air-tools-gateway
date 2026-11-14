# Handoff: build air-tools-gateway from scratch

You are starting a new repository, `~/git/air-tools-gateway` (run `git init`). Build a Node.js
REST service that is the AIR platform's single gateway to business systems: lookups (`read`
capabilities) and changes (`write` capabilities, behind propose then execute). Only
air-orchestrator-service calls it.

## 0. Ground rules

- **The contract is fixed input, not yours to redesign.** Its source is
  `~/git/air-orchestrator-service/docs/specs/0012-tools-gateway/contract.openapi.yaml`.
  Copy it into this repo as `contract/openapi.yaml` and treat the orchestrator's copy as
  authoritative. If something in it is wrong, ambiguous or unbuildable, stop and write the
  question down for the orchestrator session. Don't diverge quietly: the orchestrator's test
  double enforces the same file.
- **Read before you write:** the contract (especially `info.description`, the 11 rules), and
  `~/git/air-orchestrator-service/docs/specs/0012-tools-gateway/spec.md` §2, §7 and §9
  "Decisions taken", so you know how the caller behaves.
- **Do not edit any other repo** (air-orchestrator-service, air-rag-service,
  air-model-gateway, air-infrastructure-service, air-classifier-service, air-web-console).
  Reading them for conventions is fine. `~/git/air-rag-service` is the closest sibling for
  conventions: key hashing, `/v1/ready`, compose on `air-net`, a `make run-sit` with seeded data.
- **No language model anywhere.** No LLM SDK, no prompts, no calls to air-model-gateway. The
  orchestrator decides which capability to call; this service runs it deterministically.
- **No generic passthrough.** There is no endpoint that forwards a URL, method or body chosen
  by the caller. Every operation is a declared capability.
- **Never log or return a raw API key**, a backend URL or credential, a stack trace, or a raw
  backend error message.
- Don't commit or push unless the user asks.

## 1. What it is, in one picture

```
air-orchestrator-service ──X-API-Key (tenant's read key)────► GET  /v1/capabilities
   (plans, words answers,                                     POST /v1/tools/{name}
    verifies the customer)                                    POST /v1/actions/{name}/propose
                        └─X-API-Key (tenant's execute key)──► POST /v1/actions/{name}/execute
                                                                     │
                                                       capability registry → backend adapter
                                                                     │
                                                 fixture order store (v1) / real systems later
```

Two flows to keep in mind:

- **"Where are my recent orders?"** → `POST /v1/tools/orders.list_recent`
  `{"arguments":{"limit":5},"subject":"cust_1001"}` → that customer's orders, small and flat.
- **"Cancel my last order".** Turn 1: `orders.list_recent` with limit 1, then
  `POST /v1/actions/orders.cancel/propose` `{"arguments":{"order_id":"55120"},"subject":"cust_1001"}`
  returns a `gp_…` proposal and changes **nothing**. Turn 2, after the customer presses
  Confirm: `POST /v1/actions/orders.cancel/execute` with the **execute** key, an
  `Idempotency-Key`, and `{"proposal_id":"gp_…","subject":"cust_1001"}`. Re-check, act once,
  return `done`.

## 2. Decisions already taken (don't revisit)

1. **Tenancy by key.** Each tenant has exactly two keys: one with scope `read`, one with
   scope `execute`. A key belongs to one tenant and one scope. The tenant comes from the key.
   No request body names a tenant.
2. **Scopes.** A `read` key may call `GET /v1/capabilities`, `POST /v1/tools/*` and
   `POST /v1/actions/*/propose`. An `execute` key may call `POST /v1/actions/*/execute` only.
   A key outside its scope gets `403 forbidden`. Missing or unknown key: `401 unauthorized`.
3. **Subject.** `subject` is the tenant's own customer id. The orchestrator takes it from a
   customer token it has verified, so you trust it from an authenticated caller and use it
   for **ownership**: another customer's order is `404 not_found`, byte-for-byte the same
   response as a missing order.
4. **Keys are stored as salted sha256 digests**, `sha256(salt + raw)` in hex, like
   air-rag-service (`src/air_rag_service/security/api_keys.py`). Compare in constant time
   (`crypto.timingSafeEqual`).
5. **v1 is single-replica, in-memory.** Proposals and idempotency records live in process
   memory with TTLs. Durable storage via air-infra's Redis is a later phase, so put both
   behind small interfaces.

## 3. Stack

- Node 22 LTS, TypeScript in `strict` mode, ESM.
- **Fastify 5** for HTTP, using `fastify.inject` in tests (no sockets).
- **Ajv 8 (2020-12 draft, `ajv/dist/2020`)** to compile each capability's `input_schema`, plus
  `ajv-formats`. Fastify's route schemas for the envelopes (`ToolRequest`, `ExecuteRequest`)
  with `additionalProperties: false`.
- **pino** for JSON logs, **prom-client** for metrics, **vitest** for tests, **undici** later
  for real backends, **eslint** with typescript-eslint, **prettier**.
- Config from environment variables with prefix `AIR_TOOLS_GATEWAY__` and `__` nesting, the
  estate convention. Parse and validate them once at startup with a schema (zod is fine). An
  invalid config or an invalid capability definition must stop startup with a clear message.
  Nothing else may stop it: an unreachable backend makes `/v1/ready` 503, never a crash.

## 4. Repository layout

```
air-tools-gateway/
  contract/openapi.yaml            copied from the orchestrator; authoritative there
  src/
    main.ts                        builds config, then app; listens on PORT (8080)
    app.ts                         buildApp(config, deps) → Fastify instance (no globals; tests build their own)
    config.ts                      env → typed, validated config
    http/
      requestId.ts                 read or create X-Request-ID; echo it; bind to the logger
      auth.ts                      X-API-Key → {keyId, tenant, scope}; 401/403
      problems.ts                  RFC 9457 problem+json with closed-set `code`; one error handler
      routes/system.ts             /v1/health, /v1/ready, /metrics
      routes/capabilities.ts       GET /v1/capabilities
      routes/tools.ts              POST /v1/tools/:name
      routes/actions.ts            POST /v1/actions/:name/propose, /execute
    capabilities/
      types.ts                     ReadCapability / WriteCapability definitions
      registry.ts                  load, validate (contract rules), compile schemas, look up by name+kind
      orders/listRecent.ts
      orders/get.ts
      orders/cancel.ts
    actions/
      proposals.ts                 ProposalStore interface + in-memory TTL implementation
      idempotency.ts               IdempotencyStore interface + in-memory TTL implementation
      locks.ts                     per-proposal async mutex
    backends/
      orders.ts                    OrdersBackend interface
      fixture/ordersFixture.ts     in-memory Brightcart data; cancel mutates it
    observability/
      logger.ts  metrics.ts
  fixtures/brightcart/orders.json  seed data (§8)
  scripts/hash-key.ts              prints raw key + digest for a salt
  sit/smoke.sh                     curl walkthrough against a running instance
  test/                            vitest suites (§10)
  Dockerfile  docker-compose.yml  docker-compose.standalone.yml  Makefile  .env.example  README.md  CLAUDE.md
```

## 5. Capability definitions

A capability is a plain object. The registry builds `/v1/capabilities` from these, so the
advertised list and the served list cannot drift.

```ts
type Ctx = { tenant: string; subject: string | null; keyId: string; requestId: string;
             signal: AbortSignal; log: Logger };

interface ReadCapability {
  name: string; kind: "read"; version: number; description: string;
  inputSchema: JsonSchemaObject; requiresSubject: boolean;
  timeoutMs: number;
  run(ctx: Ctx, args: unknown): Promise<{ data: object | unknown[]; truncated: boolean; asOf: Date }>;
}

interface WriteCapability {
  name: string; kind: "write"; version: number; description: string;
  inputSchema: JsonSchemaObject; requiresSubject: boolean; risk: "low" | "medium" | "high";
  timeoutMs: number;
  // checks ownership + current state, changes NOTHING; throws a Problem(code) when not possible
  prepare(ctx: Ctx, args: unknown): Promise<{ summary: string; preview?: object }>;
  // re-checks everything, then acts once
  perform(ctx: Ctx, args: unknown): Promise<{ result: object } | { rejected: ProblemCode }>;
}
```

At startup the registry **refuses to start** if any definition breaks the contract. That
means:
- name does not match `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$` or is over 64 characters;
- duplicate name;
- `inputSchema` is not `type: "object"` with `additionalProperties: false`, or declares a
  property named `subject` or `tenant`;
- description is over 1000 characters;
- a write has no `risk`;
- more than 64 capabilities.

The orchestrator silently drops entries that break these rules, so catching them here is the
only place a mistake becomes visible.

**Descriptions are read by the orchestrator's planner (a model) to pick the capability.**
Write them as plain sentences that say what the capability returns or does and which
customer phrasings it answers. The contract has the three to use verbatim.

### v1 capabilities (exactly these three)

| Name | Kind | Args | Behaviour |
|---|---|---|---|
| `orders.list_recent` | read | `limit` 1–10, default 5 | Subject's orders, newest first: `order_id`, `placed_at`, `status`, `total{amount,currency}`, `expected_delivery`, `cancellable` |
| `orders.get` | read | `order_id` (`^[0-9]{4,12}$`) | One order with `items[{name,qty,price}]`, `status`, `tracking{carrier,status,last_update}`, `cancellable`, `returnable` |
| `orders.cancel` | write, risk `low` | `order_id`, optional `reason` enum | Prepare: owned, status in {`confirmed`,`packed`}, else `422 invalid_state`; summary "Cancel order 55120 (₹1,240.00). The refund goes to your original payment method within 3 business days." Perform: re-check, set status `cancelled`, return `{order_id, refund{amount,currency,eta_business_days:3}}` |

All three set `requiresSubject: true`. A null subject is `400 invalid_arguments`.

## 6. Request pipeline (every route)

1. **Request id.** Use `X-Request-ID` if present (≤128 chars), else generate one. Echo it on
   the response and put it on every log line.
2. **Auth.** Hash the key and look it up, giving `{keyId, tenant, scope}`; `401` if missing or
   unknown. Then the scope check for the route: `403` on a mismatch.
3. **Capability lookup** by `:name` **and the kind the route serves.** An unknown name, or a
   read name on an actions route (or the reverse), is `404 unknown_capability`.
4. **Envelope validation.** Unknown fields are `400 invalid_arguments`.
5. **Argument validation** with the compiled Ajv schema: `400 invalid_arguments`. List
   failing field paths in `detail`, never the values.
6. **Subject check:** `requiresSubject` with a null subject is `400`.
7. **Handler**, under an `AbortSignal` timeout of `timeoutMs`. A timeout is
   `504 upstream_timeout`, a backend failure `502 upstream_error`.
8. **Response shaping.** Return only the contract's fields.
9. **One error handler** turns every thrown `Problem` into `application/problem+json` with
   `type`, `title`, `status`, `code` and a safe `detail`. Anything else becomes a fixed
   `500 upstream_error`, with the stack logged and never returned.

## 7. Propose and execute: the part that must be exactly right

**Propose** (read key):
- run the pipeline, then `prepare()`. If it throws, return the problem (`422 invalid_state`
  etc.) and store nothing;
- otherwise store `{proposalId:"gp_"+12 random hex, tenant, subject, capability, args,
  argsHash, risk, summary, preview, createdAt, expiresAt: now+min(config TTL, 10 min), state:"open"}`;
- return `ProposalResponse`.

**Execute** (execute key, `Idempotency-Key` header required, 16–128 chars, `^[A-Za-z0-9_.:-]+$`,
else `400`):
1. **Replay check first.** If `(tenant, Idempotency-Key)` already has a stored response,
   return it unchanged (same status and body) and do nothing else.
2. Look up the proposal by id **within the key's tenant**. A missing proposal, a different
   subject, or a different capability than `:name` is `404 not_found`, the same response for
   all three.
3. Take the per-proposal lock, so two concurrent executes act once. Re-run the replay check
   inside the lock.
4. Expired: `409 proposal_expired`. State `executed` (under a different idempotency key):
   `409 already_executed`.
5. `risk: "high"`: mark `pending_approval`, store and return `{status:"pending_approval"}`. No
   v1 capability is high risk, but implement and test the branch with a test-only capability.
6. `perform()`: on `{rejected: code}`, return `200 {status:"rejected", code}` with nothing
   changed; on success, mark the proposal `executed` and return
   `200 {status:"done", execution_id:"gx_…", result}`.
7. Store the response under `(tenant, Idempotency-Key)` for 24 h, **before** releasing the
   lock. A 5xx (timeout or backend failure) is **not** stored, so a later call with the same
   key can learn the real outcome. Before returning a 504, make `perform()` safe to run again
   by having it re-check state: an order already `cancelled` by this proposal returns `done`,
   not a second refund.
8. Write one audit log line, `action.executed`: `proposal_id`, `capability`, `tenant`,
   `key_id`, `status`, `execution_id`, no argument values.

## 8. Fixture data (tenant `brightcart`)

Two customers, and orders the orchestrator's earlier SIT already mentions:

| order_id | subject | status | total (INR) | notes |
|---|---|---|---|---|
| 48213 | cust_1001 | in_transit | 1899.00 | placed 2026-10-30, expected 2026-11-16, not cancellable |
| 55120 | cust_1001 | confirmed | 1240.00 | placed 2026-11-12, cancellable |
| 61007 | cust_1001 | delivered | 649.00 | returnable |
| 70011 | cust_1002 | packed | 2310.00 | cancellable, used for "not yours" tests |

Also add a second tenant, `othershop`, with one order whose number collides with a
Brightcart one (`55120`) and a different customer. That way cross-tenant leakage would show
up as wrong data, not as a 404. The fixture store reloads from `fixtures/` at startup, so a
restart resets it.

## 9. Configuration, keys, runtime

`.env.example` (the gitignored `.env` is made by `make env`):

```
AIR_TOOLS_GATEWAY__APP__ENV=development
AIR_TOOLS_GATEWAY__HTTP__PORT=8080
AIR_TOOLS_GATEWAY__SECURITY__HASH_SALT=air-tools-gateway-dev-salt
AIR_TOOLS_GATEWAY__SECURITY__API_KEYS=[{"id":"brightcart-read","tenant":"brightcart","scope":"read","key_hash":"…"},{"id":"brightcart-exec","tenant":"brightcart","scope":"execute","key_hash":"…"},{"id":"othershop-read",…},{"id":"othershop-exec",…}]
AIR_TOOLS_GATEWAY__BACKEND__MODE=fixture
AIR_TOOLS_GATEWAY__BACKEND__FIXTURE_DIR=fixtures
AIR_TOOLS_GATEWAY__ACTIONS__PROPOSAL_TTL_S=600
AIR_TOOLS_GATEWAY__ACTIONS__IDEMPOTENCY_TTL_S=86400
AIR_TOOLS_GATEWAY__LOG__FORMAT=json
```

Development raw keys (only their digests go in `.env.example`; compute them with
`make key RAW=…`):
- `airtg_read_local_dev` and `airtg_exec_local_dev` for `brightcart`;
- `airtg_read_othershop_dev` and `airtg_exec_othershop_dev` for `othershop`.

**Ports and Docker.** The container listens on 8080, the host port is **8084**.
`docker-compose.yml`:
- service `air-tools-gateway`, `image: air-tools-gateway:local`, `ports: ["8084:8080"]`;
- `restart: unless-stopped`;
- a healthcheck on `/v1/health`;
- joins `air-net` as its default network (`networks: default: {name: air-net, external: true}`),
  exactly as `~/git/air-orchestrator-service/docker-compose.yml` does.

`air-net` exists only while air-infrastructure-service is up, so `make up` checks for it and
says so. Add `docker-compose.standalone.yml` without air-net, as air-rag-service does. The
Dockerfile is multi-stage `node:22-slim`, runs as a non-root user, and contains only
production dependencies.

**Makefile targets:**
- `help`, `install`, `env`, `key RAW=…`;
- `dev` (watch mode on the host, port 8084), `run`, `run-sit` (host, fixture mode, 8084);
- `lint`, `typecheck`, `test`, `check` (lint, typecheck and test; must pass before calling work done);
- `up`, `down`, `logs`, `smoke` (runs `sit/smoke.sh` against `BASE_URL`, default `http://localhost:8084`).

**Observability:**
- logs carry `request_id`, `key_id`, `tenant`, `capability`, `outcome`, `duration_ms`;
  `subject` is logged only as a short sha256 prefix;
- metrics:
  - `air_tools_gateway_requests_total{capability,kind,outcome}`, where `outcome` is `ok` or
    the problem code;
  - `air_tools_gateway_request_duration_seconds{capability,kind}`;
  - `air_tools_gateway_executions_total{capability,status}`;
- `/metrics` and `/v1/health` need no key. `/v1/ready` reports `{status, checks:[{name:"orders_backend", ok}]}`.

## 10. Tests that must exist (vitest, `app.inject`)

Name them as behaviour. Each line is one test or a small table of cases.

**Auth and scope**
1. A missing or unknown key gets 401 with `code: unauthorized`.
2. A read key on execute gets 403 `forbidden`.
3. An execute key on capabilities, tools or propose gets 403.
4. A raw key never appears in any log line. Capture pino output during the auth tests and
   assert it.

**Registry**
5. Each contract-rule violation stops startup: bad name, duplicate, open schema,
   `subject` property, missing risk, too many.
6. `/v1/capabilities` equals the registry, and every entry validates against the contract's
   `Capability` schema. Load `contract/openapi.yaml` in the test and validate with Ajv; this
   catches drift between the code and the contract.

**Read path**
7. `list_recent` returns only the subject's orders, newest first, and honours `limit`.
8. Another customer's order through `orders.get` gives the same 404 body as a nonexistent
   order. Compare them structurally.
9. Cross-tenant: an `othershop` key reading `55120` gets othershop's order, never
   Brightcart's.
10. Unknown fields in the envelope, or invalid args (`limit: 500`), give 400, and `detail`
    never echoes values.
11. An unknown capability, or the wrong kind for the route, gives 404 `unknown_capability`.
12. A backend timeout gives 504 `upstream_timeout`, and a backend throw gives 502, without
    leaking its message.

**Write path**
13. Propose changes nothing: the order's status is unchanged afterwards.
14. Proposing on a non-cancellable order gives 422 `invalid_state` and stores no proposal.
15. Execute performs once and returns `done`; the order is now `cancelled`.
16. A replay with the same Idempotency-Key returns the identical response and acts nothing
    more.
17. A different Idempotency-Key on an executed proposal gives 409 `already_executed`.
18. Two concurrent executes with different keys: exactly one `done`, one 409, one state change.
19. An expired proposal gives 409 `proposal_expired`. Use an injectable clock; no sleeping.
20. Execute with another subject, another tenant's key, or a mismatched `:name` gives 404,
    the same body for all three.
21. Re-validation: the order ships between propose and execute, so the result is
    `rejected` with `invalid_state`, and nothing changes.
22. A high-risk test capability returns `pending_approval` and performs nothing.
23. A 5xx execute is not stored, so a retry with the same key finds the real state and returns
    `done` without a second state change.
24. One `action.executed` audit line per execution, with no argument values.

**Contract conformance**
25. Every response body in the suite validates against the contract's response schema for
    its route and status.

## 11. Done means

- `make check` passes, and `make up` serves on :8084, joined to air-net.
- `make smoke` walks the whole flow:
  - health and ready;
  - capabilities;
  - list recent orders for `cust_1001`;
  - get `55120`;
  - propose a cancel;
  - execute with the execute key, then replay it;
  - a read key on execute is refused;
  - `cust_1002` can't see `55120`.
- README covers what it is, the 11 rules, how to run, the dev keys, and how to add a
  capability. CLAUDE.md records the ground rules above for future sessions.

## 12. Report back to the orchestrator session

When it's running, send the user a short note for the air-orchestrator-service session
containing:
- the base URLs (host `http://localhost:8084`, air-net `http://air-tools-gateway:8080`);
- the dev raw keys per tenant and scope;
- the contract version you built against;
- every contract question or deviation you hit, each with the line it concerns.

The orchestrator implements its side (spec 0012) against the same contract and runs a joint
SIT with this fixture data.
