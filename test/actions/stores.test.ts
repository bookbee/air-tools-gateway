/**
 * The same behaviour from both store implementations: in-memory (always) and Redis (with
 * `make test-redis`). Execute's correctness rests on these guarantees, whichever backs it.
 */
import { createLogger } from "../../src/observability/logger.js";
import { describe, expect, it } from "vitest";

import { InMemoryIdempotencyStore, type IdempotencyStore } from "../../src/actions/idempotency.js";
import { KeyedMutex, LockTimeoutError, type ProposalLock } from "../../src/actions/locks.js";
import {
  hashArgs,
  InMemoryProposalStore,
  newProposalId,
  type Proposal,
  type ProposalStore,
} from "../../src/actions/proposals.js";
import { RedisIdempotencyStore } from "../../src/actions/redis/idempotency.js";
import { RedisLock } from "../../src/actions/redis/lock.js";
import { RedisProposalStore } from "../../src/actions/redis/proposals.js";
import { StoreError } from "../../src/actions/storeError.js";
import { captureLogs } from "../helpers/app.js";
import { TestClock } from "../helpers/clock.js";
import { DEAD_REDIS_URL, TEST_REDIS_URL, useTestRedis } from "../helpers/redis.js";
import { Redis } from "ioredis";
import { RedisKeys } from "../../src/actions/redis/client.js";

const silent = () => createLogger({ format: "json", level: "silent" }, captureLogs().stream);

interface Stores {
  proposals: ProposalStore;
  idempotency: IdempotencyStore;
  lock: ProposalLock;
}

type Factory = (clock: TestClock, retentionS: number) => Stores;

const factories: [string, () => Factory | null][] = [
  [
    "memory",
    () => (clock, retentionS) => ({
      proposals: new InMemoryProposalStore(clock, retentionS),
      idempotency: new InMemoryIdempotencyStore(clock, retentionS),
      lock: new KeyedMutex(),
    }),
  ],
  [
    "redis",
    () => {
      if (TEST_REDIS_URL === "") return null;
      const { redis, keys } = useTestRedis();
      return (clock, retentionS) => {
        const k = keys();
        return {
          proposals: new RedisProposalStore(redis, k, clock, retentionS),
          idempotency: new RedisIdempotencyStore(redis, k, retentionS),
          lock: new RedisLock(redis, k, silent()),
        };
      };
    },
  ],
];

function proposal(clock: TestClock, overrides: Partial<Proposal> = {}): Proposal {
  const now = clock.now();
  return {
    id: newProposalId(),
    tenant: "brightcart",
    subject: "cust_1001",
    keyId: "brightcart-read",
    capability: "orders.cancel",
    // An empty array and a large integer: both must round-trip exactly.
    args: { order_id: "55120", tags: [], n: 9_007_199_254_740_991, nested: { a: null } },
    argsHash: hashArgs({ order_id: "55120" }),
    risk: "low",
    summary: "Cancel order 55120 — refund ₹1,240.00.",
    preview: { refund: { amount: 1240, currency: "INR" } },
    createdAt: now,
    expiresAt: new Date(now.getTime() + 600_000),
    state: "open",
    ...overrides,
  };
}

const response = (n: number) => ({
  status: 200,
  contentType: "application/json; charset=utf-8",
  body: { status: "done", n, list: [] },
  proposalId: "gp_000000000001",
});

const LOCK = { holdMs: 5000, waitMs: 5000 };

for (const [name, make] of factories) {
  const factory = make();
  describe.runIf(factory !== null)(`${name} stores`, () => {
    const stores = (clock = new TestClock(), retentionS = 86_400) => factory!(clock, retentionS);

    describe("ProposalStore", () => {
      it("round-trips a proposal exactly, dates included", async () => {
        const clock = new TestClock();
        const { proposals } = stores(clock);
        const p = proposal(clock);
        await proposals.create(p);
        expect(await proposals.get("brightcart", p.id)).toEqual(p);
      });

      it("is tenant-scoped", async () => {
        const clock = new TestClock();
        const { proposals } = stores(clock);
        const p = proposal(clock);
        await proposals.create(p);
        expect(await proposals.get("othershop", p.id)).toBeNull();
        expect(await proposals.transition("othershop", p.id, "open", "executed")).toBe(false);
        expect((await proposals.get("brightcart", p.id))?.state).toBe("open");
      });

      it("refuses a duplicate id", async () => {
        const clock = new TestClock();
        const { proposals } = stores(clock);
        const p = proposal(clock);
        await proposals.create(p);
        await expect(proposals.create(p)).rejects.toThrow("collision");
      });

      it("keeps an expired proposal for the retention period, then forgets it", async () => {
        const clock = new TestClock();
        const { proposals } = stores(clock, 3600);
        const p = proposal(clock);
        await proposals.create(p);
        clock.advance(601);
        expect((await proposals.get("brightcart", p.id))?.id).toBe(p.id);
        clock.advance(3600);
        expect(await proposals.get("brightcart", p.id)).toBeNull();
      });

      it("transitions by compare-and-set only", async () => {
        const clock = new TestClock();
        const { proposals } = stores(clock);
        const p = proposal(clock);
        await proposals.create(p);
        expect(await proposals.transition("brightcart", p.id, "open", "executed")).toBe(true);
        expect(await proposals.transition("brightcart", p.id, "open", "rejected")).toBe(false);
        expect((await proposals.get("brightcart", p.id))?.state).toBe("executed");
        expect(await proposals.transition("brightcart", newProposalId(), "open", "executed")).toBe(
          false,
        );
      });

      it("lets exactly one of many concurrent transitions win", async () => {
        const clock = new TestClock();
        const { proposals } = stores(clock);
        const p = proposal(clock);
        await proposals.create(p);
        const wins = await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            proposals.transition("brightcart", p.id, "open", i % 2 ? "executed" : "rejected"),
          ),
        );
        expect(wins.filter(Boolean)).toHaveLength(1);
      });
    });

    describe("IdempotencyStore", () => {
      it("stores the first response and returns it to every later writer", async () => {
        const { idempotency } = stores();
        expect(await idempotency.get("brightcart", "key-0000000000000001")).toBeNull();
        expect(
          await idempotency.putIfAbsent("brightcart", "key-0000000000000001", response(1)),
        ).toEqual(response(1));
        expect(
          await idempotency.putIfAbsent("brightcart", "key-0000000000000001", response(2)),
        ).toEqual(response(1));
        expect(await idempotency.get("brightcart", "key-0000000000000001")).toEqual(response(1));
      });

      it("is tenant-scoped", async () => {
        const { idempotency } = stores();
        await idempotency.putIfAbsent("brightcart", "key-0000000000000002", response(1));
        expect(await idempotency.get("othershop", "key-0000000000000002")).toBeNull();
      });

      it("keeps one winner among concurrent writers", async () => {
        const { idempotency } = stores();
        const results = await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            idempotency.putIfAbsent("brightcart", "key-0000000000000003", response(i)),
          ),
        );
        expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
      });
    });

    describe("ProposalLock", () => {
      it("runs holders of one key one at a time, and different keys in parallel", async () => {
        const { lock } = stores();
        let inside = 0;
        let maxInside = 0;
        const holder = () =>
          lock.run("brightcart:gp_aaaaaaaaaaaa", LOCK, async () => {
            inside += 1;
            maxInside = Math.max(maxInside, inside);
            await new Promise((r) => setTimeout(r, 15));
            inside -= 1;
          });
        await Promise.all([holder(), holder(), holder(), holder()]);
        expect(maxInside).toBe(1);

        const order: string[] = [];
        await Promise.all([
          lock.run("brightcart:gp_bbbbbbbbbbbb", LOCK, async () => {
            await new Promise((r) => setTimeout(r, 40));
            order.push("slow");
          }),
          lock.run("brightcart:gp_cccccccccccc", LOCK, async () => {
            order.push("fast");
          }),
        ]);
        expect(order).toEqual(["fast", "slow"]);
      });

      it("releases the lock when the holder throws", async () => {
        const { lock } = stores();
        await expect(
          lock.run("brightcart:gp_dddddddddddd", LOCK, async () => {
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
        expect(await lock.run("brightcart:gp_dddddddddddd", LOCK, async () => "next")).toBe("next");
      });
    });
  });
}

describe.runIf(TEST_REDIS_URL !== "")("RedisLock only", () => {
  const { redis, keys } = useTestRedis();

  it("gives up after waitMs with LockTimeoutError", async () => {
    const lock = new RedisLock(redis, keys(), silent());
    let release!: () => void;
    const held = lock.run("t:gp_eeeeeeeeeeee", LOCK, () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 20));
    await expect(
      lock.run("t:gp_eeeeeeeeeeee", { holdMs: 1000, waitMs: 80 }, async () => "never"),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    release();
    await held;
  });

  it("expires a stalled holder's lock after holdMs, and the stalled holder frees nothing", async () => {
    const k = keys();
    const lock = new RedisLock(redis, k, silent());
    let releaseStalled!: () => void;
    const stalled = lock.run(
      "t:gp_ffffffffffff",
      { holdMs: 50, waitMs: 1000 },
      () => new Promise<void>((r) => (releaseStalled = r)),
    );
    await new Promise((r) => setTimeout(r, 80));
    // The lock expired: a second holder gets in, and is still holding when the first ends.
    let releaseSecond!: () => void;
    const second = lock.run(
      "t:gp_ffffffffffff",
      { holdMs: 5000, waitMs: 1000 },
      () => new Promise<void>((r) => (releaseSecond = r)),
    );
    await new Promise((r) => setTimeout(r, 20));
    releaseStalled();
    await stalled;
    expect(await redis.exists(k.lock("t:gp_ffffffffffff"))).toBe(1);
    releaseSecond();
    await second;
    expect(await redis.exists(k.lock("t:gp_ffffffffffff"))).toBe(0);
  });
});

describe("Redis unreachable", () => {
  it("every store call fails fast with a StoreError that names no host", async () => {
    const redis = new Redis(DEAD_REDIS_URL, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: 200,
      retryStrategy: () => null,
    });
    redis.on("error", () => undefined);
    const clock = new TestClock();
    const k = new RedisKeys("airtg-test-dead");
    const calls = [
      () => new RedisProposalStore(redis, k, clock, 60).get("brightcart", "gp_000000000000"),
      () => new RedisProposalStore(redis, k, clock, 60).create(proposal(clock)),
      () => new RedisIdempotencyStore(redis, k, 60).get("brightcart", "key-0000000000000001"),
      () => new RedisLock(redis, k, silent()).run("t:x", LOCK, async () => 1),
    ];
    for (const call of calls) {
      const started = Date.now();
      const error = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(StoreError);
      expect((error as Error).message).toBe("store unavailable");
      expect(JSON.stringify(error)).not.toContain("127.0.0.1");
      expect(Date.now() - started).toBeLessThan(1000);
    }
    redis.disconnect();
  });
});
