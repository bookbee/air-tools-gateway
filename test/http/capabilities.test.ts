/**
 * Handoff §10 test 6: /v1/capabilities equals the registry, and every entry validates against
 * the contract's Capability schema.
 */
import { describe, expect, it } from "vitest";

import { buildTestApp, KEYS } from "../helpers/app.js";
import { readCap, writeCap } from "../helpers/capabilities.js";
import { compileContractSchema, inject } from "../helpers/contract.js";

const capabilities = [readCap(), writeCap()];

function get(key?: string) {
  return {
    method: "GET",
    url: "/v1/capabilities",
    headers: key === undefined ? {} : { "x-api-key": key },
  };
}

describe("GET /v1/capabilities", () => {
  it("equals the registry's inventory", async () => {
    const { app } = buildTestApp({ capabilities });
    const res = await inject(app, get(KEYS.brightcartRead));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(app.registry.inventory);
    expect(res.json()).toEqual({
      service: "air-tools-gateway",
      version: "0.1.0",
      capabilities: [
        {
          name: "test.lookup",
          kind: "read",
          version: 1,
          description: "A test lookup. Use for tests only.",
          input_schema: readCap().inputSchema,
          requires_subject: true,
        },
        {
          name: "test.change",
          kind: "write",
          version: 1,
          description: "A test change. Propose first; the customer must confirm.",
          input_schema: writeCap().inputSchema,
          requires_subject: true,
          risk: "low",
        },
      ],
    });
  });

  it("every entry validates against the contract's Capability schema", async () => {
    const { app } = buildTestApp({ capabilities });
    const res = await inject(app, get(KEYS.brightcartRead));
    const validate = compileContractSchema("Capability");
    for (const entry of res.json<{ capabilities: unknown[] }>().capabilities) {
      expect(validate(entry), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("never exposes handlers or internal settings", async () => {
    const { app } = buildTestApp({ capabilities });
    const res = await inject(app, get(KEYS.brightcartRead));
    expect(res.body).not.toMatch(/timeout|prepare|perform|"run"/i);
  });

  it("serves an empty inventory when nothing is registered", async () => {
    const { app } = buildTestApp({ capabilities: [] });
    const res = await inject(app, get(KEYS.othershopRead));
    expect(res.json()).toMatchObject({ capabilities: [] });
  });

  it.each([
    ["no key", undefined, 401],
    ["an execute key", KEYS.brightcartExec, 403],
  ])("refuses %s", async (_label, key, status) => {
    const { app } = buildTestApp({ capabilities });
    const res = await inject(app, get(key));
    expect(res.statusCode).toBe(status);
  });
});
