/**
 * Contract conformance (handoff §10 test 25).
 *
 * `inject(app, opts)` replaces `app.inject` in every suite. For a route the contract declares,
 * it checks that the status is one the operation lists, the Content-Type matches, and the
 * body validates against the declared schema. Paths outside the contract (test-only routes,
 * /metrics, unknown URLs) are passed through unchecked.
 *
 * The contract is read from contract/openapi.yaml, the copy of the orchestrator's file. It
 * is never edited here.
 */
import { readFileSync } from "node:fs";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { parse } from "yaml";

// ajv-formats is CommonJS with a default export.
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

const CONTRACT_ID = "contract";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export const contract = parse(readFileSync("contract/openapi.yaml", "utf8")) as JsonObject;

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(contract, CONTRACT_ID);

/**
 * Responses the gateway sends that the contract does not list, each tied to a question in
 * docs/enhancements.md §1. They must still be a valid Problem.
 */
const KNOWN_DEVIATIONS: readonly {
  /** Lowercase method, or "*". */
  method: string;
  /** Contract path template, or "*". */
  path: string;
  status: string;
  why: string;
}[] = [
  { method: "post", path: "/v1/actions/{name}/execute", status: "400", why: "C1" },
  { method: "*", path: "*", status: "500", why: "C2" },
];

function asObject(value: Json | undefined, what: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`contract: ${what} is not an object`);
  }
  return value;
}

/** Follow a `#/…` reference inside the contract. */
function deref(value: JsonObject): JsonObject {
  const ref = value.$ref;
  if (typeof ref !== "string") return value;
  let node: Json = contract;
  for (const part of ref.replace(/^#\//, "").split("/")) {
    node = asObject(node, ref)[part.replace(/~1/g, "/").replace(/~0/g, "~")] ?? null;
  }
  return asObject(node, ref);
}

/** Point the schema's `#/…` refs at the contract document, so Ajv resolves them there. */
function rebase(node: Json): Json {
  if (Array.isArray(node)) return node.map(rebase);
  if (node === null || typeof node !== "object") return node;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] =
      key === "$ref" && typeof value === "string" && value.startsWith("#/")
        ? CONTRACT_ID + value
        : rebase(value);
  }
  return out;
}

const templates = Object.keys(asObject(contract.paths, "paths")).map((template) => ({
  template,
  pattern: new RegExp(`^${template.replace(/\{[^}]+\}/g, "[^/]+")}$`),
}));

export function matchPath(url: string): string | null {
  const path = url.split("?")[0] ?? url;
  return templates.find((t) => t.pattern.test(path))?.template ?? null;
}

const compiled = new Map<string, ValidateFunction>();

function validatorFor(key: string, schema: Json): ValidateFunction {
  let fn = compiled.get(key);
  if (fn === undefined) {
    fn = ajv.compile(asObject(rebase(schema), key));
    compiled.set(key, fn);
  }
  return fn;
}

const PROBLEM_SCHEMA: Json = { $ref: "#/components/schemas/Problem" };

export interface Conformance {
  readonly checked: boolean;
  readonly problems: readonly string[];
}

export function checkResponse(
  method: string,
  url: string,
  status: number,
  contentType: string | undefined,
  body: string,
): Conformance {
  const template = matchPath(url);
  if (template === null) return { checked: false, problems: [] };
  const operation = asObject(contract.paths, "paths")[template];
  const op = asObject(operation, template)[method.toLowerCase()];
  if (op === undefined) return { checked: false, problems: [] };

  const where = `${method.toUpperCase()} ${template} ${status}`;
  const responses = asObject(asObject(op, where).responses, `${where} responses`);
  const declared = responses[String(status)];

  let media: string;
  let schema: Json;
  if (declared !== undefined) {
    const response = deref(asObject(declared, where));
    const content = asObject(response.content, `${where} content`);
    const entries = Object.entries(content);
    const entry = entries.find(([type]) => contentType?.startsWith(type)) ?? entries[0];
    if (entry === undefined) return { checked: true, problems: [`${where}: no content declared`] };
    media = entry[0];
    schema = asObject(entry[1], where).schema ?? {};
  } else {
    const deviation = KNOWN_DEVIATIONS.find(
      (d) =>
        (d.method === "*" || d.method === method.toLowerCase()) &&
        (d.path === "*" || d.path === template) &&
        d.status === String(status),
    );
    if (deviation === undefined) {
      return { checked: true, problems: [`${where}: status not declared by the contract`] };
    }
    media = "application/problem+json";
    schema = PROBLEM_SCHEMA;
  }

  const problems: string[] = [];
  if (!contentType?.startsWith(media)) {
    problems.push(`${where}: Content-Type ${String(contentType)}, contract says ${media}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { checked: true, problems: [...problems, `${where}: body is not JSON`] };
  }
  const validate = validatorFor(`${where} ${media}`, schema);
  if (!validate(parsed)) {
    for (const error of validate.errors ?? []) {
      problems.push(`${where}: ${error.instancePath || "/"} ${error.message ?? error.keyword}`);
    }
  }
  return { checked: true, problems };
}

/** Throw if the response breaks the contract. */
export function assertConforms(
  method: string,
  url: string,
  res: Pick<LightMyRequestResponse, "statusCode" | "headers" | "body">,
): void {
  const header = res.headers["content-type"];
  const result = checkResponse(
    method,
    url,
    res.statusCode,
    typeof header === "string" ? header : undefined,
    res.body,
  );
  if (result.problems.length > 0) {
    throw new Error(
      `Response breaks the contract:\n  ${result.problems.join("\n  ")}\nbody: ${res.body}`,
    );
  }
}

/** `app.inject`, plus the contract check. Use it in every suite. */
export async function inject(
  // Structural, so it accepts the app whatever its logger type parameter is.
  app: { inject(opts: InjectOptions): Promise<LightMyRequestResponse> },
  opts: InjectOptions & { method: string; url: string },
): Promise<LightMyRequestResponse> {
  const res = await app.inject(opts);
  assertConforms(opts.method, opts.url, res);
  return res;
}

export function contractSchema(name: string): JsonObject {
  return asObject(
    asObject(asObject(contract.components, "components").schemas, "schemas")[name],
    name,
  );
}

export function compileContractSchema(name: string): ValidateFunction {
  return validatorFor(`schema ${name}`, { $ref: `#/components/schemas/${name}` });
}
