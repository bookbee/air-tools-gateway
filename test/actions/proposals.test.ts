import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  hashArgs,
  InMemoryProposalStore,
  newProposalId,
  type Proposal,
} from "../../src/actions/proposals.js";
import { TestClock } from "../helpers/clock.js";

function proposal(clock: TestClock, overrides: Partial<Proposal> = {}): Proposal {
  const now = clock.now();
  return {
    id: newProposalId(),
    tenant: "brightcart",
    subject: "cust_1001",
    keyId: "brightcart-read",
    capability: "orders.cancel",
    args: { order_id: "55120" },
    argsHash: hashArgs({ order_id: "55120" }),
    risk: "low",
    summary: "Cancel it.",
    createdAt: now,
    expiresAt: new Date(now.getTime() + 600_000),
    state: "open",
    ...overrides,
  };
}

describe("proposal ids and argument hashes", () => {
  it("ids are gp_ + 12 hex characters, and distinct", () => {
    const ids = new Set(Array.from({ length: 200 }, newProposalId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^gp_[0-9a-f]{12}$/);
  });

  it("hashes arguments independently of key order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(hashArgs({ order_id: "1", reason: "other" })).toBe(
      hashArgs({ reason: "other", order_id: "1" }),
    );
    expect(hashArgs({ order_id: "1" })).not.toBe(hashArgs({ order_id: "2" }));
  });
});

describe("InMemoryProposalStore", () => {
  it("is tenant-scoped: another tenant's id is absent", async () => {
    const clock = new TestClock();
    const store = new InMemoryProposalStore(clock, 86_400);
    const p = proposal(clock);
    await store.create(p);
    expect((await store.get("brightcart", p.id))?.id).toBe(p.id);
    expect(await store.get("othershop", p.id)).toBeNull();
  });

  it("keeps an expired proposal for the retention period, then forgets it", async () => {
    const clock = new TestClock();
    const store = new InMemoryProposalStore(clock, 3600);
    const p = proposal(clock);
    await store.create(p);
    clock.advance(601);
    expect((await store.get("brightcart", p.id))?.id).toBe(p.id);
    clock.advance(3600);
    expect(await store.get("brightcart", p.id)).toBeNull();
    expect(store.size).toBe(0);
  });

  it("sweeps long-expired proposals when new ones are created", async () => {
    const clock = new TestClock();
    const store = new InMemoryProposalStore(clock, 60);
    await store.create(proposal(clock));
    clock.advance(700);
    await store.create(proposal(clock));
    expect(store.size).toBe(1);
  });

  it("returns copies and updates state in place", async () => {
    const clock = new TestClock();
    const store = new InMemoryProposalStore(clock, 60);
    const p = proposal(clock);
    await store.create(p);
    const read = await store.get("brightcart", p.id);
    (read as { state: string }).state = "executed";
    expect((await store.get("brightcart", p.id))?.state).toBe("open");
    await store.setState("brightcart", p.id, "executed");
    expect((await store.get("brightcart", p.id))?.state).toBe("executed");
  });

  it("refuses a duplicate id", async () => {
    const clock = new TestClock();
    const store = new InMemoryProposalStore(clock, 60);
    const p = proposal(clock);
    await store.create(p);
    await expect(store.create(p)).rejects.toThrow("collision");
  });
});
