/**
 * Handoff §10 test 5: each contract-rule violation stops startup.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CapabilityRegistry, RegistryError } from "../../src/capabilities/registry.js";
import type { Capability, JsonSchemaObject } from "../../src/capabilities/types.js";
import { SERVICE_VERSION } from "../../src/version.js";
import { contractSchema } from "../helpers/contract.js";
import { buildTestApp } from "../helpers/app.js";
import { manyReadCaps, readCap, writeCap } from "../helpers/capabilities.js";

function problemsOf(caps: readonly Capability[]): string {
  try {
    new CapabilityRegistry(caps);
  } catch (error) {
    if (error instanceof RegistryError) return error.problems.join("\n");
    throw error;
  }
  throw new Error("expected the registry to refuse these definitions");
}

const schema = (s: Record<string, unknown>) => s as unknown as JsonSchemaObject;

describe("CapabilityRegistry accepts valid definitions", () => {
  it("looks a capability up by name and the kind its route serves", () => {
    const registry = new CapabilityRegistry([readCap(), writeCap()]);
    expect(registry.get("test.lookup", "read")?.definition.name).toBe("test.lookup");
    expect(registry.get("test.change", "write")?.definition.name).toBe("test.change");
  });

  it("returns null for an unknown name or the wrong kind", () => {
    const registry = new CapabilityRegistry([readCap(), writeCap()]);
    expect(registry.get("test.nope", "read")).toBeNull();
    expect(registry.get("test.lookup", "write")).toBeNull();
    expect(registry.get("test.change", "read")).toBeNull();
  });

  it("allows exactly 64 capabilities", () => {
    expect(new CapabilityRegistry(manyReadCaps(64)).size).toBe(64);
  });

  it("uses the contract's name pattern and limits", () => {
    const name = contractSchema("CapabilityName");
    expect(name.pattern).toBe("^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$");
    expect(name.maxLength).toBe(64);
  });

  it("reports the package version", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(SERVICE_VERSION).toBe(pkg.version);
  });
});

describe("checkArgs", () => {
  const lookup = () => new CapabilityRegistry([readCap()]).get("test.lookup", "read")!;

  it("applies schema defaults to a copy, never to the caller's object", () => {
    const args = {};
    expect(lookup().checkArgs(args)).toEqual({ ok: true, value: { limit: 5 } });
    expect(args).toEqual({});
  });

  it.each([
    ["out of range", { limit: 500 }, "arguments/limit: failed maximum"],
    ["wrong type, not coerced", { limit: "5" }, "arguments/limit: failed type"],
    ["unknown field", { limit: 1, subject: "cust_999" }, "arguments/subject: unknown field"],
    ["not an object", [1], "arguments: failed type"],
  ])("refuses %s, naming the path but not the value", (_label, args, expected) => {
    const result = lookup().checkArgs(args);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain(expected);
      expect(result.detail).not.toContain("cust_999");
      expect(result.detail).not.toContain("500");
    }
  });
});

describe("each contract-rule violation stops startup", () => {
  it.each<[string, Capability[], string]>([
    ["an upper-case name", [readCap({ name: "Orders.get" })], "name must match"],
    ["a name without a namespace", [readCap({ name: "orders" })], "name must match"],
    ["an empty name segment", [readCap({ name: "orders..get" })], "name must match"],
    [
      "a name over 64 characters",
      [readCap({ name: `orders.${"a".repeat(58)}` })],
      "longer than 64",
    ],
    ["a duplicate name", [readCap(), readCap()], "duplicate name"],
    [
      "a read and a write sharing a name",
      [readCap({ name: "test.x" }), writeCap({ name: "test.x" })],
      "duplicate name",
    ],
    [
      "an open schema",
      [readCap({ inputSchema: schema({ type: "object", properties: {} }) })],
      "additionalProperties: false",
    ],
    [
      "additionalProperties: true",
      [readCap({ inputSchema: schema({ type: "object", additionalProperties: true }) })],
      "additionalProperties: false",
    ],
    [
      "a non-object schema",
      [readCap({ inputSchema: schema({ type: "string", additionalProperties: false }) })],
      'type "object"',
    ],
    [
      "patternProperties",
      [
        readCap({
          inputSchema: schema({
            type: "object",
            additionalProperties: false,
            patternProperties: { "^s": {} },
          }),
        }),
      ],
      "explicitly",
    ],
    [
      "a subject property",
      [
        readCap({
          inputSchema: schema({
            type: "object",
            additionalProperties: false,
            properties: { subject: { type: "string" } },
          }),
        }),
      ],
      '"subject"',
    ],
    [
      "a tenant property",
      [
        writeCap({
          inputSchema: schema({
            type: "object",
            additionalProperties: false,
            properties: { tenant: { type: "string" } },
          }),
        }),
      ],
      '"tenant"',
    ],
    [
      "a required subject",
      [
        readCap({
          inputSchema: schema({
            type: "object",
            additionalProperties: false,
            required: ["subject"],
          }),
        }),
      ],
      '"subject"',
    ],
    [
      "a schema that does not compile",
      [
        readCap({
          inputSchema: schema({
            type: "object",
            additionalProperties: false,
            properties: { a: { type: "nope" } },
          }),
        }),
      ],
      "does not compile",
    ],
    [
      "an unknown schema keyword",
      [
        readCap({
          inputSchema: schema({
            type: "object",
            additionalProperties: false,
            properties: { a: { type: "string", fromat: "date" } },
          }),
        }),
      ],
      "does not compile",
    ],
    [
      "a description over 1000 characters",
      [readCap({ description: "x".repeat(1001) })],
      "longer than 1000",
    ],
    ["an empty description", [readCap({ description: "  " })], "must not be empty"],
    ["a write without risk", [writeCap({ risk: undefined as never })], "needs risk"],
    ["a write with an unknown risk", [writeCap({ risk: "extreme" as never })], "needs risk"],
    [
      "a read with risk",
      [{ ...readCap(), risk: "low" } as unknown as Capability],
      "must not declare risk",
    ],
    ["version 0", [readCap({ version: 0 })], "version"],
    ["a zero timeout", [readCap({ timeoutMs: 0 })], "timeoutMs"],
    ["more than 64 capabilities", manyReadCaps(65), "at most 64"],
  ])("%s", (_label, caps, expected) => {
    expect(problemsOf(caps)).toContain(expected);
  });

  it("reports every problem at once, by capability name", () => {
    const text = problemsOf([
      readCap({ name: "test.a", description: "" }),
      writeCap({ name: "test.b", risk: undefined as never }),
    ]);
    expect(text).toContain("test.a: description");
    expect(text).toContain("test.b: a write capability needs risk");
  });

  it("buildApp refuses to build with an invalid definition", () => {
    expect(() => buildTestApp({ capabilities: [readCap({ name: "BAD" })] })).toThrow(RegistryError);
  });
});
