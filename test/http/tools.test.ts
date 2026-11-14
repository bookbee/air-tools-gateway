/**
 * The read path: POST /v1/tools/{name} (handoff §10 tests 7–12).
 */
import { setImmediate } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import type { OrdersBackend } from "../../src/backends/orders.js";
import { orderCapabilities } from "../../src/capabilities/index.js";
import { buildTestApp, KEYS } from "../helpers/app.js";
import {
  buggyBackend,
  failingBackend,
  hangingBackend,
  LEAKY_BACKEND_MESSAGE,
} from "../helpers/backends.js";
import { readCap, writeCap } from "../helpers/capabilities.js";
import { contract, inject } from "../helpers/contract.js";

type App = ReturnType<typeof buildTestApp>["app"];

function call(app: App, name: string, body: unknown, key: string | null = KEYS.brightcartRead) {
  return inject(app, {
    method: "POST",
    url: `/v1/tools/${name}`,
    headers: key === null ? {} : { "x-api-key": key },
    payload: body as Record<string, unknown>,
  });
}

const listRecent = (subject: string | null, args: Record<string, unknown> = {}) => ({
  arguments: args,
  subject,
});
const getOrder = (subject: string | null, orderId: string) => ({
  arguments: { order_id: orderId },
  subject,
});

function appWith(backend: OrdersBackend) {
  return buildTestApp({
    ordersBackend: backend,
    capabilities: orderCapabilities(backend, { timeoutMs: 50 }),
  });
}

describe("the order capabilities match the contract's inventory example", () => {
  it("names, schemas, flags and descriptions are the contract's, verbatim", async () => {
    const { app } = buildTestApp();
    const res = await inject(app, {
      method: "GET",
      url: "/v1/capabilities",
      headers: { "x-api-key": KEYS.brightcartRead },
    });
    const example = (
      contract as {
        paths: Record<string, { get: { responses: Record<string, unknown> } }>;
      }
    ).paths["/v1/capabilities"]!.get.responses["200"] as {
      content: { "application/json": { example: { capabilities: { name: string }[] } } };
    };
    const expected = example.content["application/json"].example.capabilities;
    const served = res.json<{ capabilities: { name: string }[] }>().capabilities;
    for (const name of ["orders.list_recent", "orders.get", "orders.cancel"]) {
      expect(served.find((c) => c.name === name)).toEqual(expected.find((c) => c.name === name));
    }
  });
});

describe("orders.list_recent (test 7)", () => {
  it("returns only the subject's orders, newest first, small and flat", async () => {
    const { app } = buildTestApp();
    const res = await call(app, "orders.list_recent", listRecent("cust_1001"));
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      capability: string;
      truncated: boolean;
      as_of: string;
      data: { orders: unknown[] };
    }>();
    expect(body.capability).toBe("orders.list_recent");
    expect(body.truncated).toBe(false);
    expect(body.data.orders).toEqual([
      {
        order_id: "55120",
        placed_at: "2026-11-12",
        status: "confirmed",
        total: { amount: "1240.00", currency: "INR" },
        expected_delivery: "2026-11-18",
        cancellable: true,
      },
      {
        order_id: "48213",
        placed_at: "2026-10-30",
        status: "in_transit",
        total: { amount: "1899.00", currency: "INR" },
        expected_delivery: "2026-11-16",
        cancellable: false,
      },
      {
        order_id: "61007",
        placed_at: "2026-10-18",
        status: "delivered",
        total: { amount: "649.00", currency: "INR" },
        expected_delivery: "2026-10-22",
        cancellable: false,
      },
    ]);
    expect(res.body).not.toContain("cust_1002");
    expect(res.body).not.toContain("70011");
  });

  it("honours limit, and says when it left orders out", async () => {
    const { app } = buildTestApp();
    const res = await call(app, "orders.list_recent", listRecent("cust_1001", { limit: 1 }));
    const body = res.json<{ truncated: boolean; data: { orders: { order_id: string }[] } }>();
    expect(body.data.orders.map((o) => o.order_id)).toEqual(["55120"]);
    expect(body.truncated).toBe(true);
  });

  it("uses the clock for as_of", async () => {
    const now = new Date("2026-11-14T10:02:11.000Z");
    const { app } = buildTestApp({ clock: { now: () => now } });
    const res = await call(app, "orders.list_recent", listRecent("cust_1001"));
    expect(res.json<{ as_of: string }>().as_of).toBe("2026-11-14T10:02:11.000Z");
  });
});

describe("orders.get (test 8)", () => {
  it("returns one order with items, tracking and what can still be done", async () => {
    const { app } = buildTestApp();
    const res = await call(app, "orders.get", getOrder("cust_1001", "48213"));
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: unknown }>().data).toEqual({
      order_id: "48213",
      placed_at: "2026-10-30",
      status: "in_transit",
      total: { amount: "1899.00", currency: "INR" },
      expected_delivery: "2026-11-16",
      items: [
        { name: "Steel water bottle, 1 L", qty: 2, price: { amount: "499.00", currency: "INR" } },
        { name: "Insulated lunch box", qty: 1, price: { amount: "901.00", currency: "INR" } },
      ],
      tracking: { carrier: "BlueDart", status: "in_transit", last_update: "2026-11-14T08:30:00Z" },
      cancellable: false,
      returnable: false,
    });
  });

  it("another customer's order is byte-for-byte the same 404 as a missing one", async () => {
    const { app } = buildTestApp();
    const notMine = await call(app, "orders.get", getOrder("cust_1001", "70011"));
    const missing = await call(app, "orders.get", getOrder("cust_1001", "99999"));
    expect(notMine.statusCode).toBe(404);
    expect(notMine.json()).toMatchObject({ code: "not_found" });
    expect(notMine.body).toBe(missing.body);
    expect(notMine.headers["content-type"]).toBe(missing.headers["content-type"]);
    expect(notMine.headers["content-length"]).toBe(missing.headers["content-length"]);
  });
});

describe("tenants never see each other's data (test 9)", () => {
  it("an othershop key reading 55120 gets othershop's order, never Brightcart's", async () => {
    const { app } = buildTestApp();
    const res = await call(app, "orders.get", getOrder("cust_2001", "55120"), KEYS.othershopRead);
    expect(res.statusCode).toBe(200);
    const data = res.json<{ data: { total: { amount: string }; items: { name: string }[] } }>()
      .data;
    expect(data.total.amount).toBe("799.00");
    expect(data.items[0]?.name).toBe("Othershop desk lamp");
    expect(res.body).not.toContain("1240.00");
  });

  it("the same subject on another tenant's key sees only that tenant's orders", async () => {
    const { app } = buildTestApp();
    const theirs = await call(
      app,
      "orders.list_recent",
      listRecent("cust_1001"),
      KEYS.othershopRead,
    );
    expect(
      theirs
        .json<{ data: { orders: { order_id: string }[] } }>()
        .data.orders.map((o) => o.order_id),
    ).toEqual(["90001"]);
    const brightcarts = await call(
      app,
      "orders.get",
      getOrder("cust_1001", "48213"),
      KEYS.othershopRead,
    );
    expect(brightcarts.statusCode).toBe(404);
  });
});

describe("validation (test 10)", () => {
  it.each([
    [
      "an unknown envelope field",
      { ...listRecent("cust_1001"), tenant: "othershop-xyz" },
      "body/tenant: unknown field",
    ],
    ["a missing subject field", { arguments: {} }, "body/subject: required"],
    ["missing arguments", { subject: "cust_1001" }, "body/arguments: required"],
    [
      "arguments that are not an object",
      { arguments: [1], subject: "cust_1001" },
      "body/arguments",
    ],
    [
      "a limit over the maximum",
      listRecent("cust_1001", { limit: 500 }),
      "arguments/limit: failed maximum",
    ],
    [
      "a limit of the wrong type",
      listRecent("cust_1001", { limit: "5" }),
      "arguments/limit: failed type",
    ],
    [
      "a subject smuggled into arguments",
      listRecent("cust_1001", { subject: "cust_9999" }),
      "arguments/subject: unknown field",
    ],
    ["a null subject on a per-customer capability", listRecent(null), "subject: required"],
    ["a subject over 128 characters", listRecent("c".repeat(129)), "body/subject"],
  ])("%s is 400 invalid_arguments", async (_label, body, expected) => {
    const { app } = buildTestApp();
    const res = await call(app, "orders.list_recent", body);
    expect(res.statusCode).toBe(400);
    const problem = res.json<{ code: string; detail: string }>();
    expect(problem.code).toBe("invalid_arguments");
    expect(problem.detail).toContain(expected);
  });

  it("an order number off the pattern is 400", async () => {
    const { app } = buildTestApp();
    const res = await call(app, "orders.get", getOrder("cust_1001", "55"));
    expect(res.statusCode).toBe(400);
  });

  it("detail never echoes a value", async () => {
    const { app } = buildTestApp();
    const res = await call(app, "orders.list_recent", {
      arguments: { limit: 987654, note: "secret-note-value" },
      subject: "cust_1001",
      extra: "secret-extra-value",
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toMatch(/987654|secret-note-value|secret-extra-value|cust_1001/);
  });
});

describe("unknown capability (test 11)", () => {
  it.each(["orders.nope", "payments.refund_all", "NOT-A-NAME"])(
    "%s is 404 unknown_capability",
    async (name) => {
      const { app } = buildTestApp();
      const res = await call(app, name, listRecent("cust_1001"));
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: "unknown_capability" });
    },
  );

  it("a write capability on the tools route is 404 unknown_capability", async () => {
    const { app } = buildTestApp({ capabilities: [readCap(), writeCap()] });
    const res = await call(app, "test.change", { arguments: { id: "1234" }, subject: "cust_1001" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "unknown_capability" });
  });

  it("the key is checked first: no key on an unknown name is 401", async () => {
    const { app } = buildTestApp();
    const res = await call(app, "orders.nope", listRecent("cust_1001"), null);
    expect(res.statusCode).toBe(401);
  });

  it("an execute key is refused before lookup: 403", async () => {
    const { app } = buildTestApp();
    const res = await call(app, "orders.list_recent", listRecent("cust_1001"), KEYS.brightcartExec);
    expect(res.statusCode).toBe(403);
  });
});

describe("backend failures (test 12)", () => {
  it("a backend that does not answer in time is 504 upstream_timeout", async () => {
    const { app } = appWith(hangingBackend());
    const res = await call(app, "orders.list_recent", listRecent("cust_1001"));
    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ code: "upstream_timeout" });
  });

  it("a backend failure is 502 upstream_error, without its message", async () => {
    const { app, logs } = appWith(failingBackend());
    const res = await call(app, "orders.get", getOrder("cust_1001", "55120"));
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: "upstream_error" });
    expect(res.body).not.toMatch(/orders\.internal|s3cr3t|ECONNRESET/);
    await setImmediate();
    // The message is kept for operators, in the log.
    expect(logs.text()).toContain("ECONNRESET");
  });

  it("a bug that is not a backend failure is the fixed 500", async () => {
    const { app } = appWith(buggyBackend());
    const res = await call(app, "orders.get", getOrder("cust_1001", "55120"));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(LEAKY_BACKEND_MESSAGE);
  });
});

describe("observability", () => {
  it("counts requests by capability, kind and outcome; unknown names share one label", async () => {
    const { app } = buildTestApp();
    await call(app, "orders.list_recent", listRecent("cust_1001"));
    await call(app, "orders.get", getOrder("cust_1001", "99999"));
    await call(app, "made.up_name", listRecent("cust_1001"));
    const metrics = (await app.inject({ method: "GET", url: "/metrics" })).body;
    expect(metrics).toMatch(
      /air_tools_gateway_requests_total\{capability="orders\.list_recent",kind="read",outcome="ok"\} 1/,
    );
    expect(metrics).toMatch(
      /air_tools_gateway_requests_total\{capability="orders\.get",kind="read",outcome="not_found"\} 1/,
    );
    expect(metrics).toMatch(
      /air_tools_gateway_requests_total\{capability="unknown",kind="read",outcome="unknown_capability"\} 1/,
    );
    expect(metrics).not.toContain("made.up_name");
  });

  it("logs carry the capability and a subject tag, never the raw subject", async () => {
    const { app, logs } = buildTestApp();
    await inject(app, {
      method: "POST",
      url: "/v1/tools/orders.list_recent",
      headers: { "x-api-key": KEYS.brightcartRead, "x-request-id": "turn-77" },
      payload: listRecent("cust_1001"),
    });
    await setImmediate();
    const done = logs.records().find((r) => r.msg === "request.completed");
    expect(done).toMatchObject({
      request_id: "turn-77",
      key_id: "brightcart-read",
      tenant: "brightcart",
      capability: "orders.list_recent",
      outcome: "ok",
      status: 200,
    });
    expect(done?.subject_tag).toMatch(/^[0-9a-f]{12}$/);
    expect(logs.text()).not.toContain("cust_1001");
  });
});
