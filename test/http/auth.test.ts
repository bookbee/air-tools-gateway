/**
 * Handoff §10 tests 1–4, against stand-in routes that declare each scope. The real
 * capability routes reuse the same hook, and their own suites repeat the scope checks.
 */
import { setImmediate } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { inject } from "../helpers/contract.js";
import { buildTestApp, KEYS, RAW_KEYS } from "../helpers/app.js";

function appWithScopedRoutes() {
  const harness = buildTestApp();
  const { app } = harness;
  app.post("/test/read", { config: { auth: "read" } }, async (request) => ({
    tenant: request.identity?.tenant,
  }));
  app.post("/test/execute", { config: { auth: "execute" } }, async () => ({ ok: true }));
  app.post("/test/unconfigured", async () => ({ ok: true }));
  app.post(
    "/test/schema",
    {
      config: { auth: "read" },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["arguments"],
          properties: { arguments: { type: "object" } },
        },
      },
    },
    async () => ({ ok: true }),
  );
  app.post("/test/boom", { config: { auth: "read" } }, async () => {
    throw new Error("GET http://orders.internal:9000/v2/orders?token=s3cr3t failed: ECONNRESET");
  });
  return harness;
}

const post = (url: string, key?: string, payload: unknown = {}) => ({
  method: "POST" as const,
  url,
  headers: key === undefined ? {} : { "x-api-key": key },
  payload: payload as Record<string, unknown>,
});

describe("authentication and scope", () => {
  it.each([
    ["missing", undefined],
    ["unknown", "airtg_not_a_real_key"],
  ])("a %s key gets 401 unauthorized", async (_label, key) => {
    const { app } = appWithScopedRoutes();
    const res = await inject(app, post("/test/read", key));
    expect(res.statusCode).toBe(401);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.json()).toMatchObject({
      type: "https://air.local/problems/unauthorized",
      status: 401,
      code: "unauthorized",
    });
  });

  it("a read key on an execute endpoint gets 403 forbidden", async () => {
    const { app } = appWithScopedRoutes();
    const res = await inject(app, post("/test/execute", KEYS.brightcartRead));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "forbidden" });
  });

  it("an execute key on a read endpoint gets 403 forbidden", async () => {
    const { app } = appWithScopedRoutes();
    const res = await inject(app, post("/test/read", KEYS.brightcartExec));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "forbidden" });
  });

  it("the tenant comes from the key", async () => {
    const { app } = appWithScopedRoutes();
    const a = await inject(app, post("/test/read", KEYS.brightcartRead));
    const b = await inject(app, post("/test/read", KEYS.othershopRead));
    expect(a.json()).toEqual({ tenant: "brightcart" });
    expect(b.json()).toEqual({ tenant: "othershop" });
  });

  it("a route without an auth declaration is refused, not left open", async () => {
    const { app } = appWithScopedRoutes();
    const res = await inject(app, post("/test/unconfigured", KEYS.brightcartRead));
    expect(res.statusCode).toBe(500);
  });

  it("checks the key before validating the body", async () => {
    const { app } = appWithScopedRoutes();
    const res = await inject(app, post("/test/schema", undefined, { junk: true }));
    expect(res.statusCode).toBe(401);
  });

  it("a raw key never appears in any log line", async () => {
    const { app, logs } = appWithScopedRoutes();
    for (const key of RAW_KEYS) {
      await inject(app, post("/test/read", key));
      await inject(app, post("/test/execute", key));
      await inject(app, post("/test/boom", key));
      await inject(app, post("/test/schema", key, { arguments: {}, extra: key }));
    }
    await setImmediate();
    expect(logs.lines.length).toBeGreaterThan(0);
    for (const key of RAW_KEYS) expect(logs.text()).not.toContain(key);
  });

  it("log lines after authentication carry request_id, key_id and tenant", async () => {
    const { app, logs } = appWithScopedRoutes();
    await inject(app, {
      ...post("/test/read", KEYS.brightcartRead),
      headers: { "x-api-key": KEYS.brightcartRead, "x-request-id": "turn-9" },
    });
    await setImmediate();
    const done = logs.records().find((r) => r.msg === "request.completed");
    expect(done).toMatchObject({
      request_id: "turn-9",
      key_id: "brightcart-read",
      tenant: "brightcart",
      status: 200,
      outcome: "ok",
    });
  });
});

describe("error handling", () => {
  it("an unexpected error is a fixed 500 that leaks nothing, with the stack logged", async () => {
    const { app, logs } = appWithScopedRoutes();
    const res = await inject(app, post("/test/boom", KEYS.brightcartRead));
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      type: "https://air.local/problems/upstream_error",
      title: "Internal error",
      status: 500,
      code: "upstream_error",
      detail: "An unexpected error occurred.",
    });
    expect(res.body).not.toMatch(/orders\.internal|s3cr3t|ECONNRESET|at /);
    await setImmediate();
    const logged = logs.records().find((r) => r.msg === "request.unhandled_error");
    expect(JSON.stringify(logged)).toContain("ECONNRESET");
  });

  it("an unknown body field is 400 invalid_arguments naming the path, not the value", async () => {
    const { app } = appWithScopedRoutes();
    const res = await inject(
      app,
      post("/test/schema", KEYS.brightcartRead, { arguments: {}, tenant: "othershop-value" }),
    );
    expect(res.statusCode).toBe(400);
    const body = res.json<{ code: string; detail: string }>();
    expect(body.code).toBe("invalid_arguments");
    expect(body.detail).toContain("body/tenant: unknown field");
    expect(body.detail).not.toContain("othershop-value");
  });

  it.each([
    ["malformed JSON", "{not json", "application/json"],
    ["not JSON", "arguments=1", "text/plain"],
  ])("a %s body is 400 invalid_arguments", async (_label, payload, type) => {
    const { app } = appWithScopedRoutes();
    const res = await inject(app, {
      method: "POST",
      url: "/test/schema",
      headers: { "x-api-key": KEYS.brightcartRead, "content-type": type },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_arguments" });
  });
});
