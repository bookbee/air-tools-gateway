import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ConfigError, DEV_HASH_SALT, envToTree, loadConfig } from "../src/config.js";
import { hashKey } from "../src/security/apiKeys.js";

const P = "AIR_TOOLS_GATEWAY__";
const DIGEST = "a".repeat(64);

function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    [`${P}SECURITY__HASH_SALT`]: "a-very-secret-salt",
    [`${P}SECURITY__API_KEYS`]: JSON.stringify([
      { id: "t-read", tenant: "t", scope: "read", key_hash: DIGEST },
    ]),
    ...overrides,
  };
}

function problemsOf(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error("expected loadConfig to throw");
}

/** Parse KEY=VALUE lines, as `make env` + a shell would. */
function readDotenv(path: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) env[match[1]!] = match[2]!;
  }
  return env;
}

describe("envToTree", () => {
  it("nests on __ and lowercases, ignoring other variables", () => {
    expect(
      envToTree({ [`${P}HTTP__PORT`]: "9000", [`${P}SECURITY__HASH_SALT`]: "s", PATH: "/bin" }),
    ).toEqual({ http: { port: "9000" }, security: { hash_salt: "s" } });
  });

  it("refuses prototype-polluting names", () => {
    expect(() => envToTree({ [`${P}CONSTRUCTOR__X`]: "1" })).toThrow(ConfigError);
  });
});

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig(baseEnv());
    expect(config.http).toEqual({ host: "0.0.0.0", port: 8080 });
    expect(config.app.env).toBe("development");
    expect(config.backend).toEqual({ mode: "fixture", fixtureDir: "fixtures" });
    expect(config.actions).toEqual({ proposalTtlS: 600, idempotencyTtlS: 86_400 });
    expect(config.security.apiKeys).toEqual([
      { id: "t-read", tenant: "t", scope: "read", keyHash: DIGEST },
    ]);
  });

  it("accepts .env.example, whose digests are the documented dev keys", () => {
    const config = loadConfig(readDotenv(".env.example"));
    const byId = Object.fromEntries(config.security.apiKeys.map((k) => [k.id, k]));
    const salt = config.security.hashSalt;
    expect(byId["brightcart-read"]?.keyHash).toBe(hashKey("airtg_read_local_dev", salt));
    expect(byId["brightcart-exec"]?.keyHash).toBe(hashKey("airtg_exec_local_dev", salt));
    expect(byId["othershop-read"]?.keyHash).toBe(hashKey("airtg_read_othershop_dev", salt));
    expect(byId["othershop-exec"]?.keyHash).toBe(hashKey("airtg_exec_othershop_dev", salt));
    expect(byId["brightcart-exec"]?.scope).toBe("execute");
    expect(byId["othershop-read"]?.tenant).toBe("othershop");
  });

  it.each([
    ["missing salt", { [`${P}SECURITY__HASH_SALT`]: "" }, "SECURITY__HASH_SALT"],
    ["keys not JSON", { [`${P}SECURITY__API_KEYS`]: "nope" }, "SECURITY__API_KEYS"],
    ["no keys", { [`${P}SECURITY__API_KEYS`]: "[]" }, "SECURITY__API_KEYS"],
    [
      "bad digest",
      {
        [`${P}SECURITY__API_KEYS`]: JSON.stringify([
          { id: "k", tenant: "t", scope: "read", key_hash: "abc" },
        ]),
      },
      "API_KEYS[0].key_hash",
    ],
    [
      "unknown scope",
      {
        [`${P}SECURITY__API_KEYS`]: JSON.stringify([
          { id: "k", tenant: "t", scope: "admin", key_hash: DIGEST },
        ]),
      },
      "API_KEYS[0].scope",
    ],
    [
      "duplicate id",
      {
        [`${P}SECURITY__API_KEYS`]: JSON.stringify([
          { id: "k", tenant: "t", scope: "read", key_hash: DIGEST },
          { id: "k", tenant: "t", scope: "execute", key_hash: "b".repeat(64) },
        ]),
      },
      "API_KEYS[1].id",
    ],
    [
      "one digest for two records",
      {
        [`${P}SECURITY__API_KEYS`]: JSON.stringify([
          { id: "k1", tenant: "t", scope: "read", key_hash: DIGEST },
          { id: "k2", tenant: "u", scope: "read", key_hash: DIGEST },
        ]),
      },
      "API_KEYS[1].key_hash",
    ],
    ["port out of range", { [`${P}HTTP__PORT`]: "70000" }, "HTTP__PORT"],
    ["proposal TTL over 10 min", { [`${P}ACTIONS__PROPOSAL_TTL_S`]: "601" }, "PROPOSAL_TTL_S"],
    [
      "idempotency TTL under 24 h",
      { [`${P}ACTIONS__IDEMPOTENCY_TTL_S`]: "3600" },
      "IDEMPOTENCY_TTL_S",
    ],
    ["unknown setting (a typo)", { [`${P}HTTP__PROT`]: "1" }, "prot"],
    [
      "dev salt in production",
      { [`${P}APP__ENV`]: "production", [`${P}SECURITY__HASH_SALT`]: DEV_HASH_SALT },
      "SECURITY__HASH_SALT",
    ],
  ])("refuses %s, naming the variable", (_label, overrides, expected) => {
    const problems = problemsOf(baseEnv(overrides));
    expect(problems.join("\n")).toContain(expected);
  });

  it("never echoes a value in its message", () => {
    const problems = problemsOf(
      baseEnv({
        [`${P}APP__ENV`]: "staging-secret-value",
        [`${P}SECURITY__API_KEYS`]: JSON.stringify([
          { id: "k", tenant: "t", scope: "read", key_hash: "not-a-digest-secret-value" },
        ]),
      }),
    ).join("\n");
    expect(problems).not.toContain("secret-value");
    expect(problems).not.toContain("a-very-secret-salt");
  });
});
