import { describe, expect, it } from "vitest";

import { inject } from "../helpers/contract.js";
import { buildTestApp } from "../helpers/app.js";

describe("GET /v1/health", () => {
  it("is ok with no key", async () => {
    const { app } = buildTestApp();
    const res = await inject(app, { method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("X-Request-ID", () => {
  it("echoes the caller's id", async () => {
    const { app } = buildTestApp();
    const res = await inject(app, {
      method: "GET",
      url: "/v1/health",
      headers: { "x-request-id": "turn-123" },
    });
    expect(res.headers["x-request-id"]).toBe("turn-123");
  });

  it.each([
    ["absent", undefined],
    ["too long", "x".repeat(129)],
    ["not printable ASCII", "turn 1\tforged"],
  ])("generates one when the caller's is %s", async (_label, incoming) => {
    const { app } = buildTestApp();
    const res = await inject(app, {
      method: "GET",
      url: "/v1/health",
      headers: incoming === undefined ? {} : { "x-request-id": incoming },
    });
    const id = res.headers["x-request-id"];
    expect(typeof id).toBe("string");
    expect(id).not.toBe(incoming);
    expect(String(id)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("GET /v1/ready", () => {
  it("is ready when every check passes", async () => {
    const { app } = buildTestApp({
      readiness: [{ name: "orders_backend", check: () => Promise.resolve(true) }],
    });
    const res = await inject(app, { method: "GET", url: "/v1/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready", checks: [{ name: "orders_backend", ok: true }] });
  });

  it.each([
    ["returns false", () => Promise.resolve(false)],
    ["throws", () => Promise.reject(new Error("connect ECONNREFUSED http://orders.internal"))],
  ])("is 503 not_ready when a check %s, without leaking why", async (_label, check) => {
    const { app } = buildTestApp({ readiness: [{ name: "orders_backend", check }] });
    const res = await inject(app, { method: "GET", url: "/v1/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: "not_ready",
      checks: [{ name: "orders_backend", ok: false }],
    });
    expect(res.body).not.toContain("orders.internal");
  });
});

describe("GET /metrics", () => {
  it("serves Prometheus text with no key", async () => {
    const { app } = buildTestApp();
    const res = await inject(app, { method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain("air_tools_gateway_requests_total");
    expect(res.body).toContain("air_tools_gateway_request_duration_seconds");
    expect(res.body).toContain("air_tools_gateway_executions_total");
  });
});

describe("unknown endpoint", () => {
  it("is a problem+json 404", async () => {
    const { app } = buildTestApp();
    const res = await inject(app, { method: "GET", url: "/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.json()).toMatchObject({ status: 404, code: "not_found" });
  });
});
