/**
 * Graceful shutdown (src/lifecycle.ts): draining shows on /v1/ready, a running execute
 * finishes and stores its answer before the store closes, and a drain that overruns is cut
 * off with exit code 1.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it, vi } from "vitest";

import { FixtureOrdersBackend } from "../src/backends/fixture/ordersFixture.js";
import type { OrdersBackend } from "../src/backends/orders.js";
import { orderCapabilities } from "../src/capabilities/index.js";
import { Lifecycle, shutdown } from "../src/lifecycle.js";
import { createLogger } from "../src/observability/logger.js";
import { buildTestApp, captureLogs, KEYS, testConfig } from "./helpers/app.js";
import { inject } from "./helpers/contract.js";
import { describeRedis, TEST_REDIS_URL, useTestRedis } from "./helpers/redis.js";

type App = ReturnType<typeof buildTestApp>["app"];

/** The fixture, with cancel answering after `delayMs`, or never. */
function slowBackend(delayMs: number | "never"): OrdersBackend {
  const inner = new FixtureOrdersBackend(
    "fixtures",
    createLogger({ format: "json", level: "silent" }, captureLogs().stream),
  );
  return {
    listRecent: (...a) => inner.listRecent(...a),
    get: (...a) => inner.get(...a),
    ping: (...a) => inner.ping(...a),
    async cancel(...a) {
      if (delayMs === "never") return new Promise(() => undefined);
      await sleep(delayMs);
      return inner.cancel(...a);
    },
  };
}

async function propose(app: App): Promise<string> {
  const res = await inject(app, {
    method: "POST",
    url: "/v1/actions/orders.cancel/propose",
    headers: { "x-api-key": KEYS.brightcartRead },
    payload: { arguments: { order_id: "55120" }, subject: "cust_1001" },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ proposal_id: string }>().proposal_id;
}

const IDEMPOTENCY_KEY = "shutdown-test-key-0001";

function execute(app: App, proposalId: string) {
  return inject(app, {
    method: "POST",
    url: "/v1/actions/orders.cancel/execute",
    headers: { "x-api-key": KEYS.brightcartExec, "idempotency-key": IDEMPOTENCY_KEY },
    payload: { proposal_id: proposalId, subject: "cust_1001" },
  });
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await sleep(5);
  expect(condition()).toBe(true);
}

describe("Lifecycle", () => {
  it("counts tracked actions and resolves idle when the last one ends", async () => {
    const lifecycle = new Lifecycle();
    await lifecycle.idle();
    let finish!: () => void;
    const running = lifecycle.track(() => new Promise<void>((r) => (finish = r)));
    const failing = lifecycle.track(() => Promise.reject(new Error("x"))).catch(() => "failed");
    expect(await failing).toBe("failed");
    expect(lifecycle.inFlight).toBe(1);
    let idle = false;
    void lifecycle.idle().then(() => (idle = true));
    await sleep(5);
    expect(idle).toBe(false);
    finish();
    await running;
    await sleep(0);
    expect(idle).toBe(true);
    expect(lifecycle.inFlight).toBe(0);
  });
});

describe("shutdown", () => {
  it("draining makes /v1/ready 503 with a draining check", async () => {
    const { app } = buildTestApp();
    expect((await inject(app, { method: "GET", url: "/v1/ready" })).statusCode).toBe(200);
    app.lifecycle.startDraining();
    const res = await inject(app, { method: "GET", url: "/v1/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "not_ready" });
    expect(res.json<{ checks: unknown[] }>().checks).toContainEqual({
      name: "draining",
      ok: false,
    });
    await app.close();
  });

  it("waits for a running execute to finish, then exits 0", async () => {
    const backend = slowBackend(150);
    const { app, logs } = buildTestApp({
      ordersBackend: backend,
      capabilities: orderCapabilities(backend),
    });
    const id = await propose(app);
    const pending = execute(app, id);
    await until(() => app.lifecycle.inFlight === 1);

    const exit = vi.fn();
    const code = shutdown(app, "SIGTERM", { drainTimeoutMs: 5000, exit });
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe("done");
    expect(await code).toBe(0);
    expect(exit).toHaveBeenCalledWith(0);

    const messages = logs.records().map((r) => r.msg);
    expect(messages.indexOf("action.executed")).toBeLessThan(messages.indexOf("shutdown.complete"));
    expect(logs.records().find((r) => r.msg === "shutdown.requested")).toMatchObject({
      signal: "SIGTERM",
      in_flight_actions: 1,
    });
  });

  it("cuts off a drain that overruns, with exit code 1", async () => {
    const backend = slowBackend("never");
    const { app, logs } = buildTestApp({
      ordersBackend: backend,
      capabilities: orderCapabilities(backend, { timeoutMs: 30_000 }),
    });
    const id = await propose(app);
    void execute(app, id);
    await until(() => app.lifecycle.inFlight === 1);
    const exit = vi.fn();
    expect(await shutdown(app, "SIGTERM", { drainTimeoutMs: 100, exit })).toBe(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logs.records().find((r) => r.msg === "shutdown.forced")).toMatchObject({
      in_flight_actions: 1,
    });
  });
});

describeRedis("shutdown with Redis", () => {
  const { redis, keys } = useTestRedis();

  it("stores the running execute's answer before closing its own Redis client", async () => {
    const k = keys();
    const backend = slowBackend(150);
    const { app } = buildTestApp(
      { ordersBackend: backend, capabilities: orderCapabilities(backend) },
      testConfig({
        AIR_TOOLS_GATEWAY__STORE__BACKEND: "redis",
        AIR_TOOLS_GATEWAY__STORE__REDIS_URL: TEST_REDIS_URL,
        AIR_TOOLS_GATEWAY__STORE__KEY_PREFIX: k.prefix,
      }),
    );
    // The app opened its own client: wait until it is connected.
    for (let i = 0; i < 100; i++) {
      const ready = await inject(app, { method: "GET", url: "/v1/ready" });
      if (ready.statusCode === 200) break;
      await sleep(10);
    }
    const id = await propose(app);
    const pending = execute(app, id);
    await until(() => app.lifecycle.inFlight === 1);
    const exit = vi.fn();
    const code = shutdown(app, "SIGTERM", { drainTimeoutMs: 5000, exit });
    expect((await pending).statusCode).toBe(200);
    expect(await code).toBe(0);
    expect(await redis.get(k.idempotency("brightcart", IDEMPOTENCY_KEY))).toContain('"done"');
  });
});
