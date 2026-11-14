/**
 * Test-only capability definitions. Spread an override to break exactly one rule.
 */
import type { ReadCapability, WriteCapability } from "../../src/capabilities/types.js";

export function readCap(overrides: Partial<ReadCapability> = {}): ReadCapability {
  return {
    name: "test.lookup",
    kind: "read",
    version: 1,
    description: "A test lookup. Use for tests only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { limit: { type: "integer", minimum: 1, maximum: 10, default: 5 } },
    },
    requiresSubject: true,
    timeoutMs: 1000,
    run: () => Promise.resolve({ data: {}, truncated: false, asOf: new Date(0) }),
    ...overrides,
  };
}

export function writeCap(overrides: Partial<WriteCapability> = {}): WriteCapability {
  return {
    name: "test.change",
    kind: "write",
    version: 1,
    description: "A test change. Propose first; the customer must confirm.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string", pattern: "^[0-9]{4,12}$" } },
    },
    requiresSubject: true,
    risk: "low",
    timeoutMs: 1000,
    prepare: () => Promise.resolve({ summary: "Change it." }),
    perform: () => Promise.resolve({ result: {} }),
    ...overrides,
  };
}

/** `count` valid, distinct read capabilities. */
export function manyReadCaps(count: number): ReadCapability[] {
  return Array.from({ length: count }, (_, i) => readCap({ name: `test.lookup_${i}` }));
}
