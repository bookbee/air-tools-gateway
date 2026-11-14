/**
 * The contract helper itself, and constants in the code that must equal the contract's.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PROBLEM_CODES } from "../../src/http/problems.js";
import { checkResponse, contract, contractSchema, matchPath } from "../helpers/contract.js";

const PROBLEM = "application/problem+json";
const JSON_TYPE = "application/json; charset=utf-8";

describe("the contract copy", () => {
  it("is the version this build targets", () => {
    expect((contract.info as { version: string }).version).toBe("0.1.0");
  });

  const upstream = join(
    homedir(),
    "git/air-orchestrator-service/docs/specs/0012-tools-gateway/contract.openapi.yaml",
  );
  const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  let hasUpstream = false;
  try {
    readFileSync(upstream);
    hasUpstream = true;
  } catch {
    hasUpstream = false;
  }
  it.runIf(hasUpstream)("is byte-identical to the orchestrator's (the authoritative copy)", () => {
    expect(sha("contract/openapi.yaml")).toBe(sha(upstream));
  });
});

describe("code constants equal the contract", () => {
  it("problem codes are the contract's closed set", () => {
    expect([...PROBLEM_CODES].sort()).toEqual(
      [...(contractSchema("ProblemCode").enum as string[])].sort(),
    );
  });
});

describe("matchPath", () => {
  it.each([
    ["/v1/tools/orders.get", "/v1/tools/{name}"],
    ["/v1/actions/orders.cancel/propose", "/v1/actions/{name}/propose"],
    ["/v1/actions/orders.cancel/execute?x=1", "/v1/actions/{name}/execute"],
    ["/v1/health", "/v1/health"],
    ["/metrics", null],
    ["/v1/tools/a/b", null],
  ])("%s → %s", (url, expected) => {
    expect(matchPath(url)).toBe(expected);
  });
});

describe("checkResponse catches what the contract refuses", () => {
  it("accepts a conforming body", () => {
    expect(checkResponse("GET", "/v1/health", 200, JSON_TYPE, '{"status":"ok"}').problems).toEqual(
      [],
    );
  });

  it.each([
    ["wrong value", "GET", "/v1/health", 200, JSON_TYPE, '{"status":"fine"}'],
    ["undeclared status", "GET", "/v1/health", 418, JSON_TYPE, "{}"],
    ["problem without code", "POST", "/v1/tools/orders.get", 404, PROBLEM, '{"type":"x","title":"t","status":404}'],
    ["code outside the closed set", "POST", "/v1/tools/orders.get", 404, PROBLEM, '{"type":"https://a/b","title":"t","status":404,"code":"nope"}'],
    ["problem sent as plain JSON", "POST", "/v1/tools/orders.get", 404, JSON_TYPE, '{"type":"https://a/b","title":"t","status":404,"code":"not_found"}'],
    ["ready without checks", "GET", "/v1/ready", 503, JSON_TYPE, '{"status":"not_ready"}'],
    ["400 on capabilities (not declared)", "GET", "/v1/capabilities", 400, PROBLEM, '{"type":"https://a/b","title":"t","status":400,"code":"invalid_arguments"}'],
  ])("rejects %s", (_label, method, url, status, type, body) => {
    expect(checkResponse(method, url, status, type, body).problems).not.toEqual([]);
  });

  it("allows the recorded deviations, but only as valid problems", () => {
    const problem = '{"type":"https://a/b","title":"t","status":400,"code":"invalid_arguments"}';
    expect(
      checkResponse("POST", "/v1/actions/orders.cancel/execute", 400, PROBLEM, problem).problems,
    ).toEqual([]);
    expect(
      checkResponse("POST", "/v1/tools/orders.get", 500, PROBLEM, problem.replace("400", "500"))
        .problems,
    ).toEqual([]);
    expect(
      checkResponse("POST", "/v1/actions/orders.cancel/execute", 400, PROBLEM, "{}").problems,
    ).not.toEqual([]);
  });

  it("skips paths the contract does not declare", () => {
    expect(checkResponse("GET", "/metrics", 200, "text/plain", "# HELP").checked).toBe(false);
  });
});
