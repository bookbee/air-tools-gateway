/**
 * Proposals: what propose stored, bound to (tenant, subject, key, capability, arguments).
 *
 * Two implementations sit behind `ProposalStore`: this file's in-memory one (one replica) and
 * `redis/proposals.ts` (shared by replicas). Lookups are always tenant-scoped: another
 * tenant's proposal id is simply absent.
 *
 * A proposal is kept past its expiry (for `retentionS`) so execute can answer
 * `409 proposal_expired` rather than an indistinguishable 404.
 */
import { createHash, randomBytes } from "node:crypto";

import type { Clock } from "../app.js";
import type { Risk } from "../capabilities/types.js";

export type ProposalState = "open" | "executed" | "rejected" | "pending_approval";

export interface Proposal {
  readonly id: string;
  readonly tenant: string;
  readonly subject: string | null;
  readonly keyId: string;
  readonly capability: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly argsHash: string;
  readonly risk: Risk;
  readonly summary: string;
  readonly preview?: object;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly state: ProposalState;
}

export interface ProposalStore {
  /** Store a new proposal. Its id must not already exist. */
  create(proposal: Proposal): Promise<void>;
  /** The tenant's proposal with this id, or null. Never another tenant's. */
  get(tenant: string, id: string): Promise<Proposal | null>;
  /**
   * Compare-and-set: move the proposal from `from` to `to` and return true, or change nothing
   * and return false when it is missing or no longer in `from`. This is the fence that keeps
   * two executes (even on two replicas) from both finalising one proposal.
   */
  transition(tenant: string, id: string, from: ProposalState, to: ProposalState): Promise<boolean>;
}

const PROPOSAL_ID_BYTES = 6;

/** `gp_` + 12 hex characters. */
export function newProposalId(): string {
  return `gp_${randomBytes(PROPOSAL_ID_BYTES).toString("hex")}`;
}

/** Canonical JSON (sorted keys), so equal arguments always hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashArgs(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args), "utf8").digest("hex");
}

const key = (tenant: string, id: string) => `${tenant}\u0000${id}`;

export class InMemoryProposalStore implements ProposalStore {
  readonly #items = new Map<string, Proposal>();
  readonly #clock: Clock;
  readonly #retentionMs: number;

  /** @param retentionS how long an expired proposal is kept, to answer `proposal_expired`. */
  constructor(clock: Clock, retentionS: number) {
    this.#clock = clock;
    this.#retentionMs = retentionS * 1000;
  }

  #sweep(): void {
    const now = this.#clock.now().getTime();
    for (const [k, p] of this.#items) {
      if (p.expiresAt.getTime() + this.#retentionMs <= now) this.#items.delete(k);
    }
  }

  async create(proposal: Proposal): Promise<void> {
    this.#sweep();
    const k = key(proposal.tenant, proposal.id);
    if (this.#items.has(k)) throw new Error("proposal id collision");
    this.#items.set(k, structuredClone(proposal));
  }

  async get(tenant: string, id: string): Promise<Proposal | null> {
    const p = this.#items.get(key(tenant, id));
    if (p === undefined) return null;
    if (p.expiresAt.getTime() + this.#retentionMs <= this.#clock.now().getTime()) {
      this.#items.delete(key(tenant, id));
      return null;
    }
    return structuredClone(p);
  }

  async transition(
    tenant: string,
    id: string,
    from: ProposalState,
    to: ProposalState,
  ): Promise<boolean> {
    const k = key(tenant, id);
    const p = this.#items.get(k);
    if (p === undefined || p.state !== from) return false;
    this.#items.set(k, { ...p, state: to });
    return true;
  }

  /** Test support. */
  get size(): number {
    return this.#items.size;
  }
}
