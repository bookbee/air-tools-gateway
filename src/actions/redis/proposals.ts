/**
 * Proposals in Redis, shared by every replica.
 *
 * One hash per proposal: `data` is the immutable proposal as JSON, written once, and `state`
 * is the one field that changes. Keeping them apart means the compare-and-set script never
 * re-encodes the proposal (Lua's cjson would turn `[]` into `{}` and round large numbers).
 * The key expires when the in-memory store would forget it: `expiresAt + retention`.
 */
import type { Redis } from "ioredis";

import type { Clock } from "../../app.js";
import type { Proposal, ProposalState, ProposalStore } from "../proposals.js";
import { guarded } from "../storeError.js";
import type { RedisKeys } from "./client.js";

/** KEYS[1] proposal; ARGV data, state, ttl ms. Returns 1 when created, 0 when it exists. */
const CREATE = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('HSET', KEYS[1], 'data', ARGV[1], 'state', ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1`;

/** KEYS[1] proposal; ARGV from, to. Returns 1 when moved, 0 when missing or not in `from`. */
const TRANSITION = `
if redis.call('HGET', KEYS[1], 'state') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'state', ARGV[2])
return 1`;

type StoredProposal = Omit<Proposal, "createdAt" | "expiresAt" | "state"> & {
  createdAt: string;
  expiresAt: string;
};

export class RedisProposalStore implements ProposalStore {
  readonly #redis: Redis;
  readonly #keys: RedisKeys;
  readonly #clock: Clock;
  readonly #retentionMs: number;

  /** @param retentionS how long an expired proposal is kept, to answer `proposal_expired`. */
  constructor(redis: Redis, keys: RedisKeys, clock: Clock, retentionS: number) {
    this.#redis = redis;
    this.#keys = keys;
    this.#clock = clock;
    this.#retentionMs = retentionS * 1000;
  }

  async create(proposal: Proposal): Promise<void> {
    const { state, createdAt, expiresAt, ...rest } = proposal;
    const data: StoredProposal = {
      ...rest,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    const ttlMs = Math.max(
      1,
      expiresAt.getTime() + this.#retentionMs - this.#clock.now().getTime(),
    );
    const created = await guarded(() =>
      this.#redis.eval(
        CREATE,
        1,
        this.#keys.proposal(proposal.tenant, proposal.id),
        JSON.stringify(data),
        state,
        String(ttlMs),
      ),
    );
    if (created !== 1) throw new Error("proposal id collision");
  }

  async get(tenant: string, id: string): Promise<Proposal | null> {
    const [data, state] = await guarded(() =>
      this.#redis.hmget(this.#keys.proposal(tenant, id), "data", "state"),
    );
    if (data == null || state == null) return null;
    const stored = JSON.parse(data) as StoredProposal;
    // Same rule as the in-memory store, against the injected clock rather than Redis's.
    const expiresAt = new Date(stored.expiresAt);
    if (expiresAt.getTime() + this.#retentionMs <= this.#clock.now().getTime()) return null;
    // A tenant mismatch cannot happen (the tenant is in the key); checked anyway.
    if (stored.tenant !== tenant) return null;
    return {
      ...stored,
      createdAt: new Date(stored.createdAt),
      expiresAt,
      state: state as ProposalState,
    };
  }

  async transition(
    tenant: string,
    id: string,
    from: ProposalState,
    to: ProposalState,
  ): Promise<boolean> {
    const moved = await guarded(() =>
      this.#redis.eval(TRANSITION, 1, this.#keys.proposal(tenant, id), from, to),
    );
    return moved === 1;
  }
}
