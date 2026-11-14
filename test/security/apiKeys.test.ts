import { describe, expect, it } from "vitest";

import { generateKey, hashKey, KEY_PREFIX, KeyRing } from "../../src/security/apiKeys.js";

const SALT = "test-salt";

function ring() {
  return new KeyRing(
    [
      { id: "a-read", tenant: "a", scope: "read", keyHash: hashKey("raw-a-read", SALT) },
      {
        id: "a-exec",
        tenant: "a",
        scope: "execute",
        keyHash: hashKey("raw-a-exec", SALT).toUpperCase(),
      },
    ],
    SALT,
  );
}

describe("hashKey", () => {
  it("is sha256(salt + raw) in lowercase hex, the estate convention", () => {
    // Reference value computed outside Node: printf '%s' 'saltraw' | shasum -a 256
    expect(hashKey("raw", "salt")).toBe(
      "f95366ccb8a2f4ce79da01f9cb2696acd92cc047e97da6515b2b9e02b477e18f",
    );
    expect(hashKey("raw", "salt")).not.toBe(hashKey("raw", "other-salt"));
  });
});

describe("KeyRing.identify", () => {
  it("returns the key's id, tenant and scope for a known key", () => {
    expect(ring().identify("raw-a-read")).toEqual({ keyId: "a-read", tenant: "a", scope: "read" });
  });

  it("accepts digests configured in uppercase", () => {
    expect(ring().identify("raw-a-exec")?.scope).toBe("execute");
  });

  it.each([undefined, "", "unknown", "x".repeat(257)])("returns null for %j", (raw) => {
    expect(ring().identify(raw)).toBeNull();
  });

  it("never exposes the raw key or its digest on the identity", () => {
    const identity = ring().identify("raw-a-read");
    const text = JSON.stringify(identity);
    expect(text).not.toContain("raw-a-read");
    expect(text).not.toContain(hashKey("raw-a-read", SALT));
  });
});

describe("generateKey", () => {
  it("makes distinct, prefixed keys", () => {
    const a = generateKey();
    const b = generateKey();
    expect(a.startsWith(KEY_PREFIX)).toBe(true);
    expect(a).not.toBe(b);
  });
});
