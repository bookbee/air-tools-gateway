/**
 * More than one replica: app instances that share their stores and one order system.
 *
 * - Redis (with `make test-redis`): the real multi-replica setup. The lock spans instances,
 *   so a proposal is performed once however the executes are spread.
 * - The fence, always: even with a lock that does nothing (as if it expired under a stalled
 *   holder), the compare-and-set state change and the backend reference still yield one
 *   `done` and one refund.
 * - Redis down, always: readiness says so, store routes answer 502, nothing crashes or leaks.
 */
import { afterAll, describe, expect, it } from "vitest";

import { InMemoryIdempotencyStore } from "../../src/actions/idempotency.js";
import type { ProposalLock } from "../../src/actions/locks.js";
import { InMemoryProposalStore } from "../../src/actions/proposals.js";
import { FixtureOrdersBackend } from "../../src/backends/fixture/ordersFixture.js";
import type { OrdersBackend } from "../../src/backends/orders.js";
import { orderCapabilities } from "../../src/capabilities/index.js";
import { createLogger } from "../../src/observability/logger.js";
import { buildTestApp, captureLogs, KEYS, testConfig } from "../helpers/app.js";
import { TestClock } from "../helpers/clock.js";
import { inject } from "../helpers/contract.js";
import { DEAD_REDIS_URL, TEST_REDIS_URL, describeRedis, useTestRedis } from "../helpers/redis.js";

type App = ReturnType<typeof buildTestApp>["app"];

function sharedBackend() {
  const inner = new FixtureOrdersBackend(
    "fixtures",
    createLogger({ format: "json", level: "silent" }, captureLogs().stream),
  );
  const calls = { cancel: 0 };
  const backend: OrdersBackend = {
    listRecent: (...a) => inner.listRecent(...a),
    get: (...a) => inner.get(...a),
    ping: (...a) => inner.ping(...a),
    async cancel(...a) {
      calls.cancel += 1;
      // Long enough for every concurrent execute to be past its replay check.
      await new Promise((r) => setTimeout(r, 30));
      return inner.cancel(...a);
    },
  };
  return { inner, backend, calls };
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

function execute(app: App, proposalId: string, idempotencyKey: string) {
  return inject(app, {
    method: "POST",
    url: "/v1/actions/orders.cancel/execute",
    headers: { "x-api-key": KEYS.brightcartExec, "idempotency-key": idempotencyKey },
    payload: { proposal_id: proposalId, subject: "cust_1001" },
  });
}

const key = (i: number) => `replica-test-key-${String(i).padStart(4, "0")}`;

async function order55120(inner: FixtureOrdersBackend) {
  return inner.get("brightcart", "cust_1001", "55120", new AbortController().signal);
}

/** Executes spread round-robin over the apps; returns each status code. */
async function storm(apps: App[], proposalId: string, keys: (i: number) => string, n: number) {
  const results = await Promise.all(
    Array.from({ length: n }, (_, i) => execute(apps[i % apps.length]!, proposalId, keys(i))),
  );
  return results;
}

// Three apps and 30-way storms per test: slower than the default 5 s allows on a busy runner.
describeRedis("replicas sharing Redis", { timeout: 15_000 }, () => {
  const { redis, keys } = useTestRedis();
  const apps: App[] = [];
  afterAll(async () => {
    await Promise.all(apps.map((a) => a.close()));
  });

  function replicas(n: number, prefix = keys().prefix) {
    const { inner, backend, calls } = sharedBackend();
    const config = testConfig({
      AIR_TOOLS_GATEWAY__STORE__BACKEND: "redis",
      AIR_TOOLS_GATEWAY__STORE__REDIS_URL: TEST_REDIS_URL,
      AIR_TOOLS_GATEWAY__STORE__KEY_PREFIX: prefix,
    });
    const made = Array.from({ length: n }, () => {
      const { app } = buildTestApp(
        { redis, ordersBackend: backend, capabilities: orderCapabilities(backend) },
        config,
      );
      apps.push(app);
      return app;
    });
    return { apps: made, inner, backend, calls, prefix };
  }

  it("a proposal made on one replica executes on another", async () => {
    const {
      apps: [a, b],
    } = replicas(2);
    const id = await propose(a!);
    const res = await execute(b!, id, key(1));
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe("done");
  });

  it("30 concurrent executes with different keys over 3 replicas: one done, one cancel", async () => {
    const { apps: three, inner, calls } = replicas(3);
    const id = await propose(three[0]!);
    const results = await storm(three, id, key, 30);
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(29);
    for (const r of results.filter((r) => r.statusCode === 409)) {
      expect(r.json<{ code: string }>().code).toBe("already_executed");
    }
    expect(calls.cancel).toBe(1);
    expect((await order55120(inner))?.status).toBe("cancelled");
  });

  it("30 concurrent executes with one key over 3 replicas: one response, byte-identical", async () => {
    const { apps: three, calls } = replicas(3);
    const id = await propose(three[0]!);
    const results = await storm(three, id, () => "replica-test-one-key-0001", 30);
    expect(new Set(results.map((r) => r.body)).size).toBe(1);
    expect(results[0]!.statusCode).toBe(200);
    expect(calls.cancel).toBe(1);
  });

  it("a replica started later (a restart) replays the stored response", async () => {
    const first = replicas(1);
    const id = await propose(first.apps[0]!);
    const res = await execute(first.apps[0]!, id, key(7));
    await first.apps[0]!.close();
    const {
      apps: [later],
    } = replicas(1, first.prefix);
    const replay = await execute(later!, id, key(7));
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toBe(res.body);
    const other = await execute(later!, id, key(8));
    expect(other.statusCode).toBe(409);
  });

  it("readiness includes the store", async () => {
    const {
      apps: [a],
    } = replicas(1);
    const res = await inject(a!, { method: "GET", url: "/v1/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ checks: unknown[] }>().checks).toContainEqual({ name: "store", ok: true });
  });

  it("does not close a Redis client it was given", async () => {
    const {
      apps: [a],
    } = replicas(1);
    await a!.close();
    expect(await redis.ping()).toBe("PONG");
  });
});

describe("the fence holds without a working lock", () => {
  it("20 executes over 2 replicas with a no-op lock: one done, one refund", async () => {
    const clock = new TestClock();
    const proposals = new InMemoryProposalStore(clock, 86_400);
    const idempotency = new InMemoryIdempotencyStore(clock, 86_400);
    const noLock: ProposalLock = { run: (_k, _o, fn) => fn() };
    const { inner, backend, calls } = sharedBackend();
    const make = () =>
      buildTestApp({
        clock,
        proposals,
        idempotency,
        locks: noLock,
        ordersBackend: backend,
        capabilities: orderCapabilities(backend),
      });
    const a = make();
    const b = make();
    const id = await propose(a.app);
    const results = await storm([a.app, b.app], id, key, 20);
    const done = results.filter((r) => r.statusCode === 200);
    expect(done).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(19);
    // Every execute performed (nothing serialised them), but the backend acted once.
    expect(calls.cancel).toBe(20);
    const order = await order55120(inner);
    expect(order?.status).toBe("cancelled");
    const lostRaces = [...a.logs.records(), ...b.logs.records()].filter(
      (r) => r.msg === "action.lost_race",
    );
    expect(lostRaces).toHaveLength(19);
  });
});

describe("Redis unreachable", () => {
  it("ready is 503, store routes are 502, reads still work, nothing names the host", async () => {
    const { app, logs } = buildTestApp(
      {},
      testConfig({
        AIR_TOOLS_GATEWAY__STORE__BACKEND: "redis",
        AIR_TOOLS_GATEWAY__STORE__REDIS_URL: DEAD_REDIS_URL,
        AIR_TOOLS_GATEWAY__STORE__COMMAND_TIMEOUT_MS: "200",
      }),
    );
    try {
      const ready = await inject(app, { method: "GET", url: "/v1/ready" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json<{ checks: unknown[] }>().checks).toContainEqual({
        name: "store",
        ok: false,
      });

      const tool = await inject(app, {
        method: "POST",
        url: "/v1/tools/orders.get",
        headers: { "x-api-key": KEYS.brightcartRead },
        payload: { arguments: { order_id: "55120" }, subject: "cust_1001" },
      });
      expect(tool.statusCode).toBe(200);

      const proposed = await inject(app, {
        method: "POST",
        url: "/v1/actions/orders.cancel/propose",
        headers: { "x-api-key": KEYS.brightcartRead },
        payload: { arguments: { order_id: "55120" }, subject: "cust_1001" },
      });
      expect(proposed.statusCode).toBe(502);
      expect(proposed.json<{ code: string }>().code).toBe("upstream_error");

      const executed = await execute(app, "gp_000000000000", key(1));
      expect(executed.statusCode).toBe(502);

      for (const text of [proposed.body, executed.body, logs.text()]) {
        expect(text).not.toContain("127.0.0.1");
        expect(text).not.toContain("redis://");
      }
      expect(logs.records().some((r) => r.msg === "store.error")).toBe(true);
    } finally {
      await app.close();
    }
  });
});
