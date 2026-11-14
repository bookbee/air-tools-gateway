/**
 * Execute: POST /v1/actions/{name}/execute (handoff §7 and §10 tests 15–24).
 */
import { setImmediate, setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { InMemoryIdempotencyStore } from "../../src/actions/idempotency.js";
import { InMemoryProposalStore } from "../../src/actions/proposals.js";
import { FixtureOrdersBackend } from "../../src/backends/fixture/ordersFixture.js";
import type { OrdersBackend } from "../../src/backends/orders.js";
import { orderCapabilities } from "../../src/capabilities/index.js";
import type { Capability } from "../../src/capabilities/types.js";
import { createLogger } from "../../src/observability/logger.js";
import { buildTestApp, captureLogs, KEYS } from "../helpers/app.js";
import { writeCap } from "../helpers/capabilities.js";
import { TestClock } from "../helpers/clock.js";
import { inject } from "../helpers/contract.js";

type App = ReturnType<typeof buildTestApp>["app"];

const KEY_A = "orch-prop_aaaaaaaaaaaa:1";
const KEY_B = "orch-prop_bbbbbbbbbbbb:1";

function fixture() {
  return new FixtureOrdersBackend(
    "fixtures",
    createLogger({ format: "json", level: "silent" }, captureLogs().stream),
  );
}

/** Wraps a backend, counting cancels and optionally slowing them or losing the first answer. */
function instrumented(
  inner: FixtureOrdersBackend,
  options: { cancelDelayMs?: number; loseFirstCancelAnswer?: boolean } = {},
) {
  const calls = { cancel: 0 };
  const backend: OrdersBackend = {
    listRecent: (...a) => inner.listRecent(...a),
    get: (...a) => inner.get(...a),
    ping: (...a) => inner.ping(...a),
    async cancel(...a) {
      calls.cancel += 1;
      if (options.cancelDelayMs !== undefined) await sleep(options.cancelDelayMs);
      const outcome = await inner.cancel(...a);
      if (options.loseFirstCancelAnswer === true && calls.cancel === 1) {
        // The change happened, but the answer never comes back.
        return new Promise(() => undefined);
      }
      return outcome;
    },
  };
  return { backend, calls };
}

function harness(
  options: {
    cancelDelayMs?: number;
    loseFirstCancelAnswer?: boolean;
    timeoutMs?: number;
    extra?: Capability[];
  } = {},
) {
  const clock = new TestClock();
  const store = fixture();
  const { backend, calls } = instrumented(store, options);
  const proposals = new InMemoryProposalStore(clock, 86_400);
  const idempotency = new InMemoryIdempotencyStore(clock, 86_400);
  const { app, logs } = buildTestApp({
    clock,
    proposals,
    idempotency,
    ordersBackend: backend,
    capabilities: [
      ...orderCapabilities(backend, { timeoutMs: options.timeoutMs ?? 2000 }),
      ...(options.extra ?? []),
    ],
  });
  return { app, logs, clock, store, calls, proposals, idempotency };
}

async function propose(
  app: App,
  args: Record<string, unknown> = { order_id: "55120" },
  options: { name?: string; subject?: string; key?: string } = {},
): Promise<string> {
  const res = await inject(app, {
    method: "POST",
    url: `/v1/actions/${options.name ?? "orders.cancel"}/propose`,
    headers: { "x-api-key": options.key ?? KEYS.brightcartRead },
    payload: { arguments: args, subject: options.subject ?? "cust_1001" },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ proposal_id: string }>().proposal_id;
}

function execute(
  app: App,
  proposalId: string,
  options: {
    name?: string;
    subject?: string | null;
    key?: string | null;
    idempotencyKey?: string | null;
  } = {},
) {
  const headers: Record<string, string> = {};
  const key = options.key === undefined ? KEYS.brightcartExec : options.key;
  if (key !== null) headers["x-api-key"] = key;
  const idem = options.idempotencyKey === undefined ? KEY_A : options.idempotencyKey;
  if (idem !== null) headers["idempotency-key"] = idem;
  return inject(app, {
    method: "POST",
    url: `/v1/actions/${options.name ?? "orders.cancel"}/execute`,
    headers,
    payload: {
      proposal_id: proposalId,
      subject: options.subject === undefined ? "cust_1001" : options.subject,
    },
  });
}

async function statusOf(store: FixtureOrdersBackend, orderId = "55120", subject = "cust_1001") {
  return (await store.get("brightcart", subject, orderId, new AbortController().signal))?.status;
}

describe("execute performs once and returns done (test 15)", () => {
  it("cancels the order and returns the refund", async () => {
    const { app, store, calls } = harness();
    const id = await propose(app);
    const res = await execute(app, id);
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.execution_id).toMatch(/^gx_[0-9a-f]{16}$/);
    expect(body).toEqual({
      status: "done",
      execution_id: body.execution_id,
      capability: "orders.cancel",
      result: {
        order_id: "55120",
        refund: { amount: "1240.00", currency: "INR", eta_business_days: 3 },
      },
    });
    expect(await statusOf(store)).toBe("cancelled");
    expect(calls.cancel).toBe(1);
  });
});

describe("idempotency", () => {
  it("a replay with the same key returns the identical response and acts no more (test 16)", async () => {
    const { app, store, calls } = harness();
    const id = await propose(app);
    const first = await execute(app, id);
    const second = await execute(app, id);
    const third = await execute(app, id);
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.body).toBe(first.body);
    expect(third.body).toBe(first.body);
    expect(second.headers["content-type"]).toBe(first.headers["content-type"]);
    expect(calls.cancel).toBe(1);
    expect(await statusOf(store)).toBe("cancelled");
  });

  it("the replay wins even after the proposal has expired", async () => {
    const { app, clock } = harness();
    const id = await propose(app);
    const first = await execute(app, id);
    clock.advance(3600);
    expect((await execute(app, id)).body).toBe(first.body);
  });

  it("a different key on an executed proposal is 409 already_executed (test 17)", async () => {
    const { app, calls } = harness();
    const id = await propose(app);
    await execute(app, id, { idempotencyKey: KEY_A });
    const res = await execute(app, id, { idempotencyKey: KEY_B });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "already_executed" });
    expect(calls.cancel).toBe(1);
  });

  it("two concurrent executes with different keys: one done, one 409, one change (test 18)", async () => {
    // The slow cancel keeps the first execute inside the lock while the second arrives.
    const { app, store, calls } = harness({ cancelDelayMs: 30 });
    const id = await propose(app);
    const [a, b] = await Promise.all([
      execute(app, id, { idempotencyKey: KEY_A }),
      execute(app, id, { idempotencyKey: KEY_B }),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    const done = a.statusCode === 200 ? a : b;
    const refused = a.statusCode === 200 ? b : a;
    expect(done.json()).toMatchObject({ status: "done" });
    expect(refused.json()).toMatchObject({ code: "already_executed" });
    expect(calls.cancel).toBe(1);
    expect(await statusOf(store)).toBe("cancelled");
  });

  it("two concurrent executes with the same key: both get the one response", async () => {
    const { app, calls } = harness({ cancelDelayMs: 30 });
    const id = await propose(app);
    const [a, b] = await Promise.all([execute(app, id), execute(app, id)]);
    expect(a.body).toBe(b.body);
    expect(a.json()).toMatchObject({ status: "done" });
    expect(calls.cancel).toBe(1);
  });

  it("idempotency records are tenant-scoped", async () => {
    const { app } = harness();
    const brightcart = await propose(app);
    await execute(app, brightcart, { idempotencyKey: KEY_A });
    // othershop reuses the same Idempotency-Key string for its own proposal.
    const othershop = await propose(
      app,
      { order_id: "55120" },
      { key: KEYS.othershopRead, subject: "cust_2001" },
    );
    const res = await execute(app, othershop, {
      key: KEYS.othershopExec,
      subject: "cust_2001",
      idempotencyKey: KEY_A,
    });
    expect(res.json()).toMatchObject({
      status: "done",
      result: { refund: { amount: "799.00" } },
    });
  });
});

describe("expiry (test 19)", () => {
  it("an expired proposal is 409 proposal_expired, and nothing changes", async () => {
    const { app, clock, store, calls } = harness();
    const id = await propose(app);
    clock.advance(600);
    const res = await execute(app, id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "proposal_expired" });
    expect(calls.cancel).toBe(0);
    expect(await statusOf(store)).toBe("confirmed");
  });

  it("one second before expiry still executes", async () => {
    const { app, clock } = harness();
    const id = await propose(app);
    clock.advance(599);
    expect((await execute(app, id)).json()).toMatchObject({ status: "done" });
  });
});

describe("a proposal belongs to whoever made it (test 20)", () => {
  it("another subject, another tenant's key, or another :name: one identical 404", async () => {
    const { app, calls } = harness({ extra: [writeCap()] });
    const id = await propose(app);
    const otherSubject = await execute(app, id, { subject: "cust_1002" });
    const otherTenant = await execute(app, id, { key: KEYS.othershopExec });
    const otherName = await execute(app, id, { name: "test.change" });
    const unknownId = await execute(app, "gp_000000000000");
    for (const res of [otherSubject, otherTenant, otherName]) {
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(unknownId.body);
    }
    expect(unknownId.json()).toMatchObject({ code: "not_found" });
    expect(calls.cancel).toBe(0);
  });

  it("a failed match does not burn the Idempotency-Key", async () => {
    const { app } = harness();
    const id = await propose(app);
    await execute(app, id, { subject: "cust_1002" });
    expect((await execute(app, id)).json()).toMatchObject({ status: "done" });
  });
});

describe("re-validation at execute (test 21)", () => {
  it("the order ships between propose and execute: rejected invalid_state, nothing changes", async () => {
    const { app, store, calls } = harness();
    const id = await propose(app);
    store.setStatus("brightcart", "55120", "in_transit");
    const res = await execute(app, id);
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body).toEqual({
      status: "rejected",
      execution_id: body.execution_id,
      capability: "orders.cancel",
      code: "invalid_state",
    });
    expect(calls.cancel).toBe(1);
    expect(await statusOf(store)).toBe("in_transit");
  });

  it("a rejected proposal is final: another key gets 409 already_executed", async () => {
    const { app, store } = harness();
    const id = await propose(app);
    store.setStatus("brightcart", "55120", "in_transit");
    await execute(app, id, { idempotencyKey: KEY_A });
    store.setStatus("brightcart", "55120", "confirmed");
    const res = await execute(app, id, { idempotencyKey: KEY_B });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "already_executed" });
  });
});

describe("high risk (test 22)", () => {
  it("returns pending_approval and performs nothing", async () => {
    let performed = 0;
    const risky = writeCap({
      name: "test.risky",
      risk: "high",
      perform: () => {
        performed += 1;
        return Promise.resolve({ result: {} });
      },
    });
    const { app, proposals } = harness({ extra: [risky] });
    const id = await propose(app, { id: "1234" }, { name: "test.risky" });
    const res = await execute(app, id, { name: "test.risky" });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body).toEqual({
      status: "pending_approval",
      execution_id: body.execution_id,
      capability: "test.risky",
    });
    expect(performed).toBe(0);
    expect((await proposals.get("brightcart", id))?.state).toBe("pending_approval");
    // Replays the same answer; a new key does not slip past the approval.
    expect((await execute(app, id, { name: "test.risky" })).body).toBe(res.body);
    expect((await execute(app, id, { name: "test.risky", idempotencyKey: KEY_B })).statusCode).toBe(
      409,
    );
    expect(performed).toBe(0);
  });
});

describe("an unknown outcome is not stored (test 23)", () => {
  it("a 504 execute is retried with the same key and returns done, with one change", async () => {
    const { app, store, calls, idempotency } = harness({
      loseFirstCancelAnswer: true,
      timeoutMs: 300, // only the lost cancel answer should hit it, never propose
    });
    const id = await propose(app);
    const lost = await execute(app, id);
    expect(lost.statusCode).toBe(504);
    expect(lost.json()).toMatchObject({ code: "upstream_timeout" });
    expect(idempotency.size).toBe(0);
    // The cancel did happen; the retry must learn that, not cancel or refund again.
    expect(await statusOf(store)).toBe("cancelled");

    const retry = await execute(app, id);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({
      status: "done",
      result: { refund: { amount: "1240.00", eta_business_days: 3 } },
    });
    expect(calls.cancel).toBe(2);
    expect(await statusOf(store)).toBe("cancelled");
    // And now it is final.
    expect((await execute(app, id)).body).toBe(retry.body);
    expect(calls.cancel).toBe(2);
  });
});

describe("audit (test 24)", () => {
  it("one action.executed line per execution, with no argument values", async () => {
    const { app, logs } = harness();
    const id = await propose(app, { order_id: "55120", reason: "found_cheaper" });
    const res = await execute(app, id);
    await execute(app, id); // a replay is not an execution
    await execute(app, id, { idempotencyKey: KEY_B }); // a 409 is not one either
    await setImmediate();
    const audits = logs.records().filter((r) => r.msg === "action.executed");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      proposal_id: id,
      capability: "orders.cancel",
      tenant: "brightcart",
      key_id: "brightcart-exec",
      status: "done",
      execution_id: res.json<{ execution_id: string }>().execution_id,
    });
    expect(JSON.stringify(audits[0])).not.toMatch(/55120|found_cheaper|cust_1001|1240/);
  });

  it("counts executions by capability and status", async () => {
    const { app } = harness();
    await execute(app, await propose(app)); // one propose + one execute: two ok write requests
    const metrics = (await app.inject({ method: "GET", url: "/metrics" })).body;
    expect(metrics).toMatch(
      /air_tools_gateway_executions_total\{capability="orders\.cancel",status="done"\} 1/,
    );
    expect(metrics).toMatch(
      /air_tools_gateway_requests_total\{capability="orders\.cancel",kind="write",outcome="ok"\} 2/,
    );
  });
});

describe("the request itself", () => {
  it.each([
    ["missing", null],
    ["too short", "short-key"],
    ["too long", "k".repeat(129)],
    ["with forbidden characters", "orch prop/aaaa bbbb"],
  ])("an Idempotency-Key %s is 400 and executes nothing", async (_label, key) => {
    const { app, calls } = harness();
    const id = await propose(app);
    const res = await execute(app, id, { idempotencyKey: key });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_arguments" });
    expect(res.json<{ detail: string }>().detail).toContain("idempotency-key");
    expect(calls.cancel).toBe(0);
  });

  it("a read key on execute is 403; no key is 401", async () => {
    const { app, calls } = harness();
    const id = await propose(app);
    expect((await execute(app, id, { key: KEYS.brightcartRead })).statusCode).toBe(403);
    expect((await execute(app, id, { key: null })).statusCode).toBe(401);
    expect(calls.cancel).toBe(0);
  });

  it("an unknown field in the body is 400", async () => {
    const { app } = harness();
    const id = await propose(app);
    const res = await inject(app, {
      method: "POST",
      url: "/v1/actions/orders.cancel/execute",
      headers: { "x-api-key": KEYS.brightcartExec, "idempotency-key": KEY_A },
      payload: { proposal_id: id, subject: "cust_1001", confirm: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it("a null subject is 400", async () => {
    const { app } = harness();
    const id = await propose(app);
    expect((await execute(app, id, { subject: null })).statusCode).toBe(400);
  });

  it("a read capability on execute is 404 unknown_capability", async () => {
    const { app } = harness();
    const id = await propose(app);
    const res = await execute(app, id, { name: "orders.get" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "unknown_capability" });
  });
});
