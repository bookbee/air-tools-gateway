# air-tools-gateway

The AIR platform's single gateway to business systems. It serves declared **capabilities**:
`read` ones (lookups) and `write` ones (changes, behind propose then execute). Only
air-orchestrator-service calls it. It makes no language-model call: the orchestrator decides
which capability a conversation needs, and this service runs it deterministically and safely.

v1 serves three capabilities over an in-memory fixture order store:

| Capability           | Kind              | What it does                                                                |
| -------------------- | ----------------- | --------------------------------------------------------------------------- |
| `orders.list_recent` | read              | The customer's recent orders, newest first (`limit` 1–10, default 5)        |
| `orders.get`         | read              | One order with items, tracking, and whether it can be cancelled or returned |
| `orders.cancel`      | write, risk `low` | Cancel an order that hasn't shipped; refund to the original payment method  |

## The contract

[`contract/openapi.yaml`](contract/openapi.yaml) is a copy of
`air-orchestrator-service/docs/specs/0012-tools-gateway/contract.openapi.yaml`, which is
authoritative. It is never edited here: a test fails when the two differ. Questions about it
go to the orchestrator and are tracked in [`docs/enhancements.md`](docs/enhancements.md) §1.

The rules it sets (its `info.description` has them in full):

1. **Declared capabilities only.** Every operation is named in `GET /v1/capabilities` with a
   JSON Schema for its arguments. There is no generic "call this URL" endpoint.
2. **Arguments are validated** against a closed schema that never declares `subject` or
   `tenant`: identity travels in the envelope.
3. **The tenant comes from the API key.** Each tenant has one `read` key and one `execute` key,
   stored as salted sha256 digests. No request names a tenant.
4. **The subject is enforced.** Someone else's order is `404 not_found`, byte-for-byte like a
   missing one.
5. **Two key scopes.** `read`: capabilities, tools, propose. `execute`: execute only. Outside
   its scope a key gets `403`.
6. **Propose changes nothing.** It checks and previews, and stores a proposal that expires
   within 10 minutes.
7. **Execute re-checks everything.** The orchestrator's confirmation is evidence, not
   authority.
8. **Execute is idempotent.** The same `Idempotency-Key` returns the same response for 24 hours
   and never acts twice. A different key for an executed proposal is `409 already_executed`.
9. **Responses are small and flat.** No raw backend payloads, no other customers' data.
10. **Errors are RFC 9457** `application/problem+json` with a closed-set `code`. `detail` never
    carries a URL, credential, stack trace or backend message.
11. **Estate conventions:** `/v1/health`, `/v1/ready`, `X-Request-ID` echoed, JSON logs,
    Prometheus metrics at `/metrics`, a timeout on every backend call.

## Running it

Needs Node 22 LTS for host runs and Docker for container runs.

```sh
make install            # npm ci
make check              # lint, typecheck, tests: must pass before work is done

make run-sit            # host, fixture data, dev keys, http://localhost:8084
make smoke              # walk the whole flow against :8084 (in another terminal)
```

In Docker, on the platform's shared network:

```sh
cd ../air-infrastructure-service && make up    # creates air-net
make up                                        # builds, starts on :8084, reports readiness
# or: docker compose up -d --build air-tools-gateway
make smoke
make logs / make down
```

`make up INFRA=none` runs on this project's own network instead of `air-net`.

| Where            | Base URL                        |
| ---------------- | ------------------------------- |
| Host             | `http://localhost:8084`         |
| Inside `air-net` | `http://air-tools-gateway:8080` |

The fixture store lives in memory and reloads at startup, so **restart to reset it**.
`make smoke` cancels order 55120 and says so when you run it twice.

Other targets: `make dev` (watch mode), `make run` (compiled), `make env` (`.env` from
`.env.example`), `make key RAW=…` (digest for a raw key), `make help` for the list.
Configuration is environment variables prefixed `AIR_TOOLS_GATEWAY__` with `__` nesting; see
[`.env.example`](.env.example).

## Development keys

Only their digests are configured (`.env.example`, `docker-compose.yml`), with the salt
`air-tools-gateway-dev-salt`.

| Tenant       | Scope   | Raw key                    |
| ------------ | ------- | -------------------------- |
| `brightcart` | read    | `airtg_read_local_dev`     |
| `brightcart` | execute | `airtg_exec_local_dev`     |
| `othershop`  | read    | `airtg_read_othershop_dev` |
| `othershop`  | execute | `airtg_exec_othershop_dev` |

Fixture customers: Brightcart `cust_1001` (orders 48213 in transit, 55120 confirmed, 61007
delivered) and `cust_1002` (70011 packed); othershop `cust_2001` (its own 55120) and `cust_1001`
(90001). The colliding numbers make a cross-tenant leak show up as wrong data.

```sh
curl -s localhost:8084/v1/tools/orders.list_recent \
  -H 'X-API-Key: airtg_read_local_dev' -H 'Content-Type: application/json' \
  -d '{"arguments":{"limit":5},"subject":"cust_1001"}'
```

## Adding a capability

1. Write a factory in `src/capabilities/<namespace>/` that returns a `ReadCapability` (`run`)
   or a `WriteCapability` (`prepare`, which changes nothing, and `perform`, which re-checks and
   acts once and is safe to repeat; it gets the proposal id as `ctx.proposalId` for the
   backend's idempotency reference). See `src/capabilities/types.ts`.
2. Give it a closed `inputSchema` (`type: "object"`, `additionalProperties: false`, no
   `subject`, `tenant` or `patternProperties`). Write the `description` for the orchestrator's
   planner, a model: plain sentences naming the customer phrasings it answers.
3. Add it to `orderCapabilities` in `src/capabilities/index.ts` (or a sibling list).
4. Shape results into small, flat objects. Throw `Problem("not_found" | "invalid_state" | …)`
   for refusals; let backends throw `BackendError`.
5. Add tests through `test/helpers/contract.ts`'s `inject`, which checks every response
   against the contract.

The registry refuses to start if a definition breaks a contract rule, because the
orchestrator would otherwise drop it silently. The name must be in a namespace the
orchestrator's channel allow-list admits before the planner sees it.

## More

- [`docs/handoff.md`](docs/handoff.md): the build brief.
- [`docs/enhancements.md`](docs/enhancements.md): open contract questions, interim v1
  choices, and what comes after v1.
