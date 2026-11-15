/**
 * Propose: POST /v1/actions/{name}/propose (handoff §10 tests 13–14, and §7 "Propose").
 */
import { describe, expect, it } from "vitest";

import { InMemoryProposalStore } from "../../src/actions/proposals.js";
import { FixtureOrdersBackend } from "../../src/backends/fixture/ordersFixture.js";
import type { OrdersBackend } from "../../src/backends/orders.js";
import { orderCapabilities } from "../../src/capabilities/index.js";
import { createLogger } from "../../src/observability/logger.js";
import { buildTestApp, captureLogs, KEYS, testConfig } from "../helpers/app.js";
import { failingBackend, hangingBackend } from "../helpers/backends.js";
import { readCap, writeCap } from "../helpers/capabilities.js";
import { TestClock } from "../helpers/clock.js";
import { inject } from "../helpers/contract.js";

type App = ReturnType<typeof buildTestApp>["app"];

function harness(options: { backend?: OrdersBackend; ttl?: string; timeoutMs?: number } = {}) {
  const clock = new TestClock();
  const backend =
    options.backend ??
    new FixtureOrdersBackend(
      "fixtures",
      createLogger({ format: "json", level: "silent" }, captureLogs().stream),
    );
  const proposals = new InMemoryProposalStore(clock, 86_400);
  const config = testConfig(
    options.ttl === undefined ? {} : { AIR_TOOLS_GATEWAY__ACTIONS__PROPOSAL_TTL_S: options.ttl },
  );
  const { app, logs } = buildTestApp(
    {
      clock,
      proposals,
      ordersBackend: backend,
      capabilities: orderCapabilities(backend, { timeoutMs: options.timeoutMs ?? 2000 }),
    },
    config,
  );
  return { app, logs, clock, backend, proposals };
}

function propose(
  app: App,
  name: string,
  args: Record<string, unknown>,
  subject: string | null = "cust_1001",
  key: string | null = KEYS.brightcartRead,
) {
  return inject(app, {
    method: "POST",
    url: `/v1/actions/${name}/propose`,
    headers: key === null ? {} : { "x-api-key": key },
    payload: { arguments: args, subject },
  });
}

async function statusOf(app: App, orderId: string, subject = "cust_1001") {
  const res = await inject(app, {
    method: "POST",
    url: "/v1/tools/orders.get",
    headers: { "x-api-key": KEYS.brightcartRead },
    payload: { arguments: { order_id: orderId }, subject },
  });
  return res.json<{ data: { status: string } }>().data.status;
}

describe("propose orders.cancel", () => {
  it("returns a proposal in the customer's terms, as the contract's example", async () => {
    const { app } = harness();
    const res = await propose(app, "orders.cancel", { order_id: "55120", reason: "changed_mind" });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.proposal_id).toMatch(/^gp_[0-9a-f]{12}$/);
    expect(body).toEqual({
      proposal_id: body.proposal_id,
      capability: "orders.cancel",
      risk: "low",
      summary:
        "Cancel order 55120 (₹1,240.00). The refund goes to your original payment method within 3 business days.",
      expires_at: "2026-11-14T10:12:11.000Z",
      preview: { order_id: "55120", refund: { amount: "1240.00", currency: "INR" } },
    });
  });

  it("changes nothing (test 13)", async () => {
    const { app } = harness();
    await propose(app, "orders.cancel", { order_id: "55120" });
    await propose(app, "orders.cancel", { order_id: "55120" });
    expect(await statusOf(app, "55120")).toBe("confirmed");
  });

  it("stores the proposal bound to tenant, subject, key, capability and arguments", async () => {
    const { app, proposals } = harness();
    const res = await propose(app, "orders.cancel", { order_id: "55120" });
    const id = res.json<{ proposal_id: string }>().proposal_id;
    const stored = await proposals.get("brightcart", id);
    expect(stored).toMatchObject({
      tenant: "brightcart",
      subject: "cust_1001",
      keyId: "brightcart-read",
      capability: "orders.cancel",
      args: { order_id: "55120" },
      risk: "low",
      state: "open",
    });
    expect(stored?.argsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await proposals.get("othershop", id)).toBeNull();
  });

  it("each propose is a new proposal", async () => {
    const { app, proposals } = harness();
    const a = await propose(app, "orders.cancel", { order_id: "55120" });
    const b = await propose(app, "orders.cancel", { order_id: "55120" });
    expect(a.json<{ proposal_id: string }>().proposal_id).not.toBe(
      b.json<{ proposal_id: string }>().proposal_id,
    );
    expect(proposals.size).toBe(2);
  });

  it("a packed order can be proposed too", async () => {
    const { app } = harness();
    const res = await propose(app, "orders.cancel", { order_id: "70011" }, "cust_1002");
    expect(res.statusCode).toBe(200);
  });

  it("expires after the configured TTL", async () => {
    const { app } = harness({ ttl: "120" });
    const res = await propose(app, "orders.cancel", { order_id: "55120" });
    expect(res.json<{ expires_at: string }>().expires_at).toBe("2026-11-14T10:04:11.000Z");
  });
});

describe("propose refuses what is not possible, and stores nothing (test 14)", () => {
  it.each([
    ["in transit", "48213", "The order has already shipped."],
    ["delivered", "61007", "The order has already been delivered."],
  ])("an order %s is 422 invalid_state", async (_label, orderId, detail) => {
    const { app, proposals } = harness();
    const res = await propose(app, "orders.cancel", { order_id: orderId });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      type: "https://air.local/problems/invalid_state",
      title: "Not possible in the order's current state",
      code: "invalid_state",
      detail,
    });
    expect(proposals.size).toBe(0);
  });

  it("cust_1003's 80105 is cancelled in the fixture itself: 422, no prior cancel needed", async () => {
    const { app, proposals } = harness();
    const res = await propose(app, "orders.cancel", { order_id: "80105" }, "cust_1003");
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      code: "invalid_state",
      detail: "The order is already cancelled.",
    });
    expect(proposals.size).toBe(0);
  });

  it("an already cancelled order is 422 invalid_state", async () => {
    const { app, backend, proposals } = harness();
    (backend as FixtureOrdersBackend).setStatus("brightcart", "55120", "cancelled");
    const res = await propose(app, "orders.cancel", { order_id: "55120" });
    expect(res.json()).toMatchObject({
      code: "invalid_state",
      detail: "The order is already cancelled.",
    });
    expect(proposals.size).toBe(0);
  });

  it("another customer's order is the same 404 as a missing one", async () => {
    const { app, proposals } = harness();
    const notMine = await propose(app, "orders.cancel", { order_id: "70011" });
    const missing = await propose(app, "orders.cancel", { order_id: "99999" });
    expect(notMine.statusCode).toBe(404);
    expect(notMine.body).toBe(missing.body);
    expect(proposals.size).toBe(0);
  });

  it("another tenant's colliding order number is not found", async () => {
    const { app } = harness();
    // othershop's 55120 belongs to cust_2001, not cust_1001.
    const res = await propose(
      app,
      "orders.cancel",
      { order_id: "55120" },
      "cust_1001",
      KEYS.othershopRead,
    );
    expect(res.statusCode).toBe(404);
  });

  it.each([
    ["an order number off the pattern", { order_id: "55" }, "arguments/order_id"],
    ["an unknown reason", { order_id: "55120", reason: "because" }, "arguments/reason"],
    ["a missing order number", {}, "arguments/order_id: required"],
    [
      "a smuggled tenant",
      { order_id: "55120", tenant: "othershop" },
      "arguments/tenant: unknown field",
    ],
  ])("%s is 400", async (_label, args, expected) => {
    const { app, proposals } = harness();
    const res = await propose(app, "orders.cancel", args);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ detail: string }>().detail).toContain(expected);
    expect(proposals.size).toBe(0);
  });

  it("a null subject is 400", async () => {
    const { app } = harness();
    const res = await propose(app, "orders.cancel", { order_id: "55120" }, null);
    expect(res.statusCode).toBe(400);
  });

  it("a timeout is 504 and a backend failure 502, storing nothing", async () => {
    const slow = harness({ backend: hangingBackend(), timeoutMs: 50 });
    expect((await propose(slow.app, "orders.cancel", { order_id: "55120" })).statusCode).toBe(504);
    expect(slow.proposals.size).toBe(0);
    const broken = harness({ backend: failingBackend() });
    expect((await propose(broken.app, "orders.cancel", { order_id: "55120" })).statusCode).toBe(
      502,
    );
    expect(broken.proposals.size).toBe(0);
  });
});

describe("propose: route, kind and key", () => {
  it.each(["orders.get", "orders.list_recent", "orders.nope"])(
    "%s is 404 unknown_capability on propose",
    async (name) => {
      const { app } = harness();
      const res = await propose(app, name, { order_id: "55120" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: "unknown_capability" });
    },
  );

  it("an execute key is 403, a missing key 401", async () => {
    const { app } = harness();
    expect(
      (await propose(app, "orders.cancel", { order_id: "55120" }, "cust_1001", KEYS.brightcartExec))
        .statusCode,
    ).toBe(403);
    expect(
      (await propose(app, "orders.cancel", { order_id: "55120" }, "cust_1001", null)).statusCode,
    ).toBe(401);
  });

  it("a summary over the contract's 500 characters is a fixed 500 and stores nothing", async () => {
    const proposals = new InMemoryProposalStore(new TestClock(), 60);
    const { app } = buildTestApp({
      proposals,
      capabilities: [
        readCap(),
        writeCap({ prepare: () => Promise.resolve({ summary: "x".repeat(501) }) }),
      ],
    });
    const res = await propose(app, "test.change", { id: "1234" });
    expect(res.statusCode).toBe(500);
    expect(proposals.size).toBe(0);
  });

  it("logs the proposal without argument values", async () => {
    const { app, logs } = harness();
    await propose(app, "orders.cancel", { order_id: "55120", reason: "found_cheaper" });
    const line = logs.records().find((r) => r.msg === "action.proposed");
    expect(line).toMatchObject({ capability: "orders.cancel", risk: "low" });
    expect(JSON.stringify(line)).not.toMatch(/55120|found_cheaper|cust_1001/);
  });
});
