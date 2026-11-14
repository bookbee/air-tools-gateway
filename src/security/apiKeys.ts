/**
 * API key identity.
 *
 * A raw key exists in exactly two places: the caller's `X-API-Key` header and whatever handed
 * the key to them. Configuration carries salted sha256 digests only, as every AIR service does
 * (`sha256(salt + raw)`, hex). The ring is built once at startup and read-only afterwards.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const SCOPES = ["read", "execute"] as const;
export type Scope = (typeof SCOPES)[number];

export const KEY_PREFIX = "airtg_";

/** Longest header value we bother hashing; anything longer cannot be a key we issued. */
const MAX_RAW_KEY_LENGTH = 256;

export interface ApiKeyRecord {
  readonly id: string;
  readonly tenant: string;
  readonly scope: Scope;
  /** sha256(salt + raw), lowercase hex. */
  readonly keyHash: string;
}

/** Who a request is, once its key is known. Never carries the raw key or its digest. */
export interface KeyIdentity {
  readonly keyId: string;
  readonly tenant: string;
  readonly scope: Scope;
}

export function hashKey(raw: string, salt: string): string {
  return createHash("sha256")
    .update(salt + raw, "utf8")
    .digest("hex");
}

export function generateKey(): string {
  return KEY_PREFIX + randomBytes(24).toString("base64url");
}

interface Entry {
  readonly identity: KeyIdentity;
  readonly digest: Buffer;
}

export class KeyRing {
  readonly #salt: string;
  readonly #entries: readonly Entry[];

  constructor(records: readonly ApiKeyRecord[], salt: string) {
    this.#salt = salt;
    this.#entries = records.map((record) => ({
      identity: Object.freeze({ keyId: record.id, tenant: record.tenant, scope: record.scope }),
      digest: Buffer.from(record.keyHash.toLowerCase(), "hex"),
    }));
  }

  /**
   * Identify a raw key, or return null for a missing or unknown one.
   *
   * Every entry is compared in constant time and the loop never exits early, so timing says
   * nothing about which digest (or how much of one) matched.
   */
  identify(raw: string | undefined): KeyIdentity | null {
    if (raw === undefined || raw.length === 0 || raw.length > MAX_RAW_KEY_LENGTH) {
      return null;
    }
    const digest = Buffer.from(hashKey(raw, this.#salt), "hex");
    let match: KeyIdentity | null = null;
    for (const entry of this.#entries) {
      if (timingSafeEqual(digest, entry.digest)) {
        match = entry.identity;
      }
    }
    return match;
  }

  get size(): number {
    return this.#entries.length;
  }
}
