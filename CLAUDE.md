# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**air-tools-gateway** is the AIR platform's single gateway to business systems. It is a Node.js REST service that runs declared capabilities: lookups (`read`) and changes (`write`, behind propose then execute). Its only caller is air-orchestrator-service.

The full build brief is `docs/handoff.md`. It covers layout, capability specs, fixture data, the required test list and what "done" means. Read it before starting a new piece of work. Open contract questions, interim v1 choices and post-v1 enhancements are tracked in `docs/enhancements.md`. Add to it rather than expanding v1 scope.

## Ground rules

- **The contract is fixed input.** `contract/openapi.yaml` is copied from `~/git/air-orchestrator-service/docs/specs/0012-tools-gateway/contract.openapi.yaml`, and the orchestrator's copy is authoritative. Don't redesign it or quietly diverge from it, because the orchestrator's test double enforces the same file. If it is wrong, ambiguous or unbuildable, stop and write the question down in `docs/enhancements.md` §1 for the orchestrator session. Read its `info.description` (the 11 rules) and spec.md §2, §7 and §9 before changing behaviour.
- **When the drift test fails** (`test/contract/contract.test.ts`, "byte-identical to the orchestrator's"), the orchestrator changed its copy. Diff the two, re-copy it byte-for-byte with `cp` (never hand-edit), adapt the code if needed, and log anything unversioned or unclear as a question.
- **Do not edit other repos** (air-orchestrator-service, air-rag-service, air-model-gateway, air-infrastructure-service, air-classifier-service, air-web-console). Reading them is fine. `~/git/air-rag-service` is the closest sibling for conventions: key hashing, `/v1/ready`, compose on `air-net`, and `make run-sit`.
- **No language model anywhere.** That means no LLM SDK, no prompts and no calls to air-model-gateway. The orchestrator picks the capability, and this service runs it deterministically.
- **No generic passthrough.** No endpoint may forward a URL, method or body chosen by the caller. Every operation is a declared capability.
- **Never log or return** a raw API key, a backend URL or credential, a stack trace, or a raw backend error message. Log `subject` only as a short sha256 prefix. `invalid_arguments` details list field paths, never values.
- Don't commit or push unless asked.

## Stack

Node 22 LTS, TypeScript `strict`, ESM. Fastify 5 (tests use `app.inject` and open no sockets). Ajv 8 2020-12 (`ajv/dist/2020`) with `ajv-formats` for capability `inputSchema`s. pino, prom-client, vitest, eslint (typescript-eslint), prettier. undici comes later, for real backends.

Config comes from env vars with prefix `AIR_TOOLS_GATEWAY__` and `__` nesting (e.g. `AIR_TOOLS_GATEWAY__SECURITY__HASH_SALT`). It is validated once at startup with a schema. Only an invalid config or an invalid capability definition may stop startup. An unreachable backend makes `/v1/ready` return 503 and never crashes the service.

## Commands (Makefile)

- `make install`, `make env` (creates the gitignored `.env` from `.env.example`), `make key RAW=…` (prints the salted digest for a raw key)
- `make dev` (watch mode), `make run` (compiled), `make run-sit` (fixture mode, dev keys from `.env.example`). All on host port 8084; override with `PORT=…`.
- `make lint`, `make typecheck`, `make test`, **`make check`** (all three; must pass before calling work done). `make docker-check` runs the same in `node:22-slim` when there's no host Node.
- `make up` / `down` / `logs` / `status` (Docker on `air-net`, host 8084 → container 8080; `make up` checks that `air-net` exists, which requires air-infrastructure-service to be running). `make up INFRA=none` uses `docker-compose.standalone.yml`, without `air-net`. The compose file has the dev key digests inline, so `docker compose up -d --build air-tools-gateway` needs no `.env`.
- `make smoke` runs `sit/smoke.sh` against `BASE_URL` (default `http://localhost:8084`). It cancels order 55120, so restart the service before running it again.
- Single test: `npx vitest run test/http/execute.test.ts -t "<test name>"`
- Node 22 on this machine is in `~/.local/node-22/bin` (official nodejs.org build). If `node` isn't found, prefix commands with `PATH="$HOME/.local/node-22/bin:$PATH"`.

Dev raw keys (only their digests go in `.env.example`): `airtg_read_local_dev` / `airtg_exec_local_dev` (tenant `brightcart`), `airtg_read_othershop_dev` / `airtg_exec_othershop_dev` (tenant `othershop`).

## Architecture

**Endpoints:** `GET /v1/capabilities`, `POST /v1/tools/{name}`, `POST /v1/actions/{name}/propose` and `POST /v1/actions/{name}/execute`. `/v1/health`, `/v1/ready` and `/metrics` need no key.

**Tenancy and scope come from the key.** Each tenant has one `read` key and one `execute` key, stored as `sha256(salt + raw)` hex and compared with `crypto.timingSafeEqual`. A read key may call capabilities, tools and propose. An execute key may call execute only. A missing or unknown key gets 401, and a key outside its scope gets 403. No request body names a tenant. `subject` is the tenant's customer id, already verified by the orchestrator, and is used for ownership. Another customer's resource must return a 404 that is byte-identical to the 404 for a missing one.

**Capability registry** (`src/capabilities/`). Each capability is a plain `ReadCapability` (`run`) or `WriteCapability` (`prepare`, which checks and changes nothing, and `perform`, which re-checks and acts once) object. The registry builds `/v1/capabilities` from these objects, so the advertised list and the served list can't drift. The registry **refuses to start** on any contract violation: a bad name pattern or a name over 64 chars, a duplicate, an `inputSchema` that isn't a closed `type: object`, a `subject`/`tenant` property, a description over 1000 chars, a write with no `risk`, or more than 64 capabilities. The orchestrator silently drops bad entries, so this check is the only place such a mistake shows up. Descriptions are read by the orchestrator's planner model and should be written as plain sentences. v1 has exactly three capabilities: `orders.list_recent`, `orders.get` and `orders.cancel`.

**Request pipeline (every route):** request id (`X-Request-ID`, echoed) → auth and scope check → capability lookup by name **and route kind** (a wrong kind gives 404 `unknown_capability`) → envelope validation (closed, gives 400) → Ajv argument validation (400) → subject check (400) → handler under an `AbortSignal` timeout (timeout gives 504 `upstream_timeout`, backend failure gives 502 `upstream_error`) → response shaping to contract fields only. A single error handler turns every `Problem` into RFC 9457 `application/problem+json` with a closed-set `code`. Any other error becomes a fixed 500 and its stack is logged, never returned.

**Propose and execute must be exactly right** (`src/actions/`, see handoff §7). Propose runs `prepare()` and, on success, stores a `gp_…` proposal with a TTL of at most 10 min. Execute requires an `Idempotency-Key` and runs these steps in order:

1. Replay check on `(tenant, key)`.
2. Tenant-scoped proposal lookup. Wrong subject, wrong capability and missing proposal all give the same 404.
3. Per-proposal lock, then a second replay check.
4. Expired gives 409 `proposal_expired`. Already executed gives 409 `already_executed`.
5. `risk: high` gives `pending_approval`.
6. `perform()` returns `done` or `rejected`.
7. Store the response for 24 h before releasing the lock. **5xx responses are not stored**, so `perform()` must be safe to re-run.
8. Write one `action.executed` audit log line without argument values.

**Storage:** v1 is single-replica and in-memory. `ProposalStore` and `IdempotencyStore` sit behind interfaces so Redis (via air-infra) can replace them later. Backends sit behind interfaces like `OrdersBackend`. In fixture mode the backend loads `fixtures/` at startup and mutates the data in memory, so a restart resets it. The fixtures include a second tenant, `othershop`, whose order `55120` collides with Brightcart's `55120`, so cross-tenant leakage shows up as wrong data rather than as a 404.

**Where things live:** `src/http/pipeline.ts` holds the shared pipeline (lookup hook, envelope schemas, `checkArguments`, `withDeadline`). Routes are in `src/http/routes/` (`tools.ts`, `actions.ts` for propose, `execute.ts`). Every route must declare `config.auth` (`"none" | "read" | "execute"`); a route without one is refused with a 500. Fastify's Ajv is configured in `app.ts` with `removeAdditional: false` and `coerceTypes: false`, so unknown body fields are a 400, not silently stripped. Don't undo that.

**Write capabilities get `ExecuteCtx`** (`Ctx` plus `proposalId`) in `perform`. `orders.cancel` passes the proposal id to `OrdersBackend.cancel` as an idempotency reference: the same reference again returns `already_cancelled` with the first refund, which is what makes a retry after a 504 safe. Ownership is part of every backend query: lookups take `(tenant, customerId)` and return `null` for "not yours" exactly as for "missing".

**Testing:** `buildApp(config, deps)` takes no globals, so each test builds its own app through `test/helpers/app.ts` (`buildTestApp`, `KEYS`, captured logs). Inject `TestClock` (`test/helpers/clock.ts`) and stand-in backends (`test/helpers/backends.ts`) instead of sleeping. Call routes with `inject(app, …)` from `test/helpers/contract.ts`, not `app.inject`: it checks every response's status, Content-Type and body against `contract/openapi.yaml`. Its `KNOWN_DEVIATIONS` lists the only undeclared responses allowed (C1: 400 on execute; C2: 500). The required behaviour tests are listed in `docs/handoff.md` §10.

## Repository conventions

- Main branch is `develop`; open PRs against it.
- `.env` and `.env.*` are gitignored; only `.env.example` is committed.
