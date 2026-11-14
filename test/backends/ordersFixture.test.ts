import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FixtureOrdersBackend } from "../../src/backends/fixture/ordersFixture.js";
import { BackendError } from "../../src/backends/orders.js";
import { createLogger } from "../../src/observability/logger.js";
import { inject } from "../helpers/contract.js";
import { buildTestApp, captureLogs, testConfig } from "../helpers/app.js";

const NOW = new Date("2026-11-14T10:00:00Z");
const live = () => new AbortController().signal;

function backend(dir = "fixtures") {
  const { stream, logs } = captureLogs();
  return {
    orders: new FixtureOrdersBackend(dir, createLogger({ format: "json", level: "debug" }, stream)),
    logs,
  };
}

describe("FixtureOrdersBackend reads", () => {
  it("lists only the customer's orders, newest first, honouring limit", async () => {
    const { orders } = backend();
    const all = await orders.listRecent("brightcart", "cust_1001", 10, live());
    expect(all.orders.map((o) => o.orderId)).toEqual(["55120", "48213", "61007"]);
    expect(all.total).toBe(3);
    const one = await orders.listRecent("brightcart", "cust_1001", 1, live());
    expect(one.orders.map((o) => o.orderId)).toEqual(["55120"]);
    expect(one.total).toBe(3);
  });

  it("gets an order only for its owner; someone else's is null, like a missing one", async () => {
    const { orders } = backend();
    expect((await orders.get("brightcart", "cust_1001", "55120", live()))?.total.amount).toBe(
      "1240.00",
    );
    expect(await orders.get("brightcart", "cust_1002", "55120", live())).toBeNull();
    expect(await orders.get("brightcart", "cust_1001", "99999", live())).toBeNull();
  });

  it("keeps tenants apart, even when order numbers collide", async () => {
    const { orders } = backend();
    const other = await orders.get("othershop", "cust_2001", "55120", live());
    expect(other?.total.amount).toBe("799.00");
    expect(await orders.get("othershop", "cust_1001", "55120", live())).toBeNull();
    const list = await orders.listRecent("othershop", "cust_1001", 10, live());
    expect(list.orders.map((o) => o.orderId)).toEqual(["90001"]);
  });

  it("an unknown tenant simply has no orders", async () => {
    const { orders } = backend();
    expect(await orders.listRecent("nobody", "cust_1001", 5, live())).toEqual({
      orders: [],
      total: 0,
    });
  });

  it("returns copies: changing a result changes nothing stored", async () => {
    const { orders } = backend();
    const order = await orders.get("brightcart", "cust_1001", "55120", live());
    (order as { status: string }).status = "delivered";
    expect((await orders.get("brightcart", "cust_1001", "55120", live()))?.status).toBe(
      "confirmed",
    );
  });

  it("an aborted signal fails the call", async () => {
    const { orders } = backend();
    const controller = new AbortController();
    controller.abort(new Error("deadline"));
    await expect(orders.get("brightcart", "cust_1001", "55120", controller.signal)).rejects.toThrow(
      "deadline",
    );
  });
});

describe("FixtureOrdersBackend.cancel", () => {
  const cancel = (
    orders: FixtureOrdersBackend,
    customer: string,
    id: string,
    reference = "gp_aaaaaaaaaaaa",
  ) => orders.cancel("brightcart", customer, id, { reference, now: NOW }, live());

  it("cancels a confirmed order once, with a refund of its total", async () => {
    const { orders } = backend();
    expect(await cancel(orders, "cust_1001", "55120")).toMatchObject({
      kind: "cancelled",
      order: { status: "cancelled" },
      refund: { amount: "1240.00", currency: "INR", etaBusinessDays: 3 },
    });
    expect((await orders.get("brightcart", "cust_1001", "55120", live()))?.status).toBe(
      "cancelled",
    );
  });

  it("cancels a packed order", async () => {
    const { orders } = backend();
    expect((await cancel(orders, "cust_1002", "70011")).kind).toBe("cancelled");
  });

  it("repeating with the same reference returns the first outcome and changes nothing", async () => {
    const { orders } = backend();
    const first = await cancel(orders, "cust_1001", "55120");
    const again = await cancel(orders, "cust_1001", "55120");
    expect(again.kind).toBe("already_cancelled");
    if (first.kind === "cancelled" && again.kind === "already_cancelled") {
      expect(again.refund).toEqual(first.refund);
    }
  });

  it("a different reference on a cancelled order is not cancellable", async () => {
    const { orders } = backend();
    await cancel(orders, "cust_1001", "55120", "gp_111111111111");
    expect(await cancel(orders, "cust_1001", "55120", "gp_222222222222")).toEqual({
      kind: "not_cancellable",
      status: "cancelled",
    });
  });

  it.each([
    ["in_transit", "48213"],
    ["delivered", "61007"],
  ])("refuses a %s order and leaves it unchanged", async (status, id) => {
    const { orders } = backend();
    expect(await cancel(orders, "cust_1001", id)).toEqual({ kind: "not_cancellable", status });
    expect((await orders.get("brightcart", "cust_1001", id, live()))?.status).toBe(status);
  });

  it("someone else's order is not_found and stays unchanged", async () => {
    const { orders } = backend();
    expect(await cancel(orders, "cust_1001", "70011")).toEqual({ kind: "not_found" });
    expect((await orders.get("brightcart", "cust_1002", "70011", live()))?.status).toBe("packed");
  });

  it("a new instance reloads the fixture, so a restart resets it", async () => {
    const first = backend().orders;
    await cancel(first, "cust_1001", "55120");
    const restarted = backend().orders;
    expect((await restarted.get("brightcart", "cust_1001", "55120", live()))?.status).toBe(
      "confirmed",
    );
  });
});

describe("a broken fixture never stops startup", () => {
  function brokenDir(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), "airtg-fixture-"));
    mkdirSync(join(dir, "brightcart"));
    writeFileSync(join(dir, "brightcart", "orders.json"), contents);
    return dir;
  }

  it.each([
    ["missing directory", join(tmpdir(), "airtg-does-not-exist")],
    ["malformed JSON", brokenDir("{nope")],
    ["schema violation", brokenDir('{"orders":[{"order_id":"1"}]}')],
  ])("%s: not ready, calls fail with BackendError", async (_label, dir) => {
    const { orders, logs } = backend(dir);
    expect(await orders.ping(live())).toBe(false);
    await expect(orders.listRecent("brightcart", "cust_1001", 5, live())).rejects.toBeInstanceOf(
      BackendError,
    );
    expect(logs.records().some((r) => r.msg === "fixture.load_failed")).toBe(true);
  });
});

describe("/v1/ready with the orders backend", () => {
  it("is ready with the shipped fixtures", async () => {
    const { app } = buildTestApp();
    const res = await inject(app, { method: "GET", url: "/v1/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready", checks: [{ name: "orders_backend", ok: true }] });
  });

  it("is 503 when the fixture cannot load, and the app still starts", async () => {
    const config = testConfig({
      AIR_TOOLS_GATEWAY__BACKEND__FIXTURE_DIR: join(tmpdir(), "airtg-does-not-exist"),
    });
    const { app } = buildTestApp({}, config);
    const res = await inject(app, { method: "GET", url: "/v1/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: "not_ready",
      checks: [{ name: "orders_backend", ok: false }],
    });
    expect(res.body).not.toContain("airtg-does-not-exist");
  });
});
