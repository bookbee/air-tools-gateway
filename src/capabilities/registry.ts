/**
 * The capability registry: validates every definition against the contract's rules, compiles
 * each input schema once, and answers lookups by name and kind.
 *
 * It refuses to start on any violation. The orchestrator silently drops inventory entries that
 * break the rules (spec 0012 REQ-TGW-002), so this is the only place such a mistake becomes
 * visible.
 */
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

import { describeValidation } from "../http/problems.js";
import { SERVICE_NAME, SERVICE_VERSION } from "../version.js";
import type { Capability, CapabilityKind, Risk } from "./types.js";

// ajv-formats is CommonJS with a default export.
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

export const MAX_CAPABILITIES = 64;
export const NAME_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1000;
export const MAX_TIMEOUT_MS = 30_000;
const RESERVED_ARGUMENTS = ["subject", "tenant"] as const;
const RISKS: readonly Risk[] = ["low", "medium", "high"];

export class RegistryError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid capability definitions:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "RegistryError";
  }
}

/** One entry of `GET /v1/capabilities`, exactly the contract's `Capability` fields. */
export interface InventoryEntry {
  readonly name: string;
  readonly kind: CapabilityKind;
  readonly version: number;
  readonly description: string;
  readonly input_schema: object;
  readonly requires_subject: boolean;
  readonly risk?: Risk;
}

export interface Inventory {
  readonly service: typeof SERVICE_NAME;
  readonly version: string;
  readonly capabilities: readonly InventoryEntry[];
}

export type ArgsCheck =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly detail: string };

export interface RegisteredCapability<C extends Capability = Capability> {
  readonly definition: C;
  /** Validate (and apply defaults to a copy of) the request's `arguments`. */
  checkArgs(args: unknown): ArgsCheck;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** The contract's rules for one definition. Returns problems, not throws, so all are reported. */
function check(cap: Capability, label: string): string[] {
  const problems: string[] = [];
  const c = cap as unknown as Record<string, unknown>;

  if (typeof c.name !== "string" || !NAME_PATTERN.test(c.name)) {
    problems.push(`${label}: name must match ${NAME_PATTERN.source}`);
  } else if (c.name.length > MAX_NAME_LENGTH) {
    problems.push(`${label}: name is longer than ${MAX_NAME_LENGTH} characters`);
  }
  if (c.kind !== "read" && c.kind !== "write") {
    problems.push(`${label}: kind must be read or write`);
  }
  if (!Number.isInteger(c.version) || (c.version as number) < 1) {
    problems.push(`${label}: version must be an integer ≥ 1`);
  }
  if (typeof c.description !== "string" || c.description.trim().length === 0) {
    problems.push(`${label}: description must not be empty`);
  } else if (c.description.length > MAX_DESCRIPTION_LENGTH) {
    problems.push(`${label}: description is longer than ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  if (typeof c.requiresSubject !== "boolean") {
    problems.push(`${label}: requiresSubject must be a boolean`);
  }
  if (
    !Number.isInteger(c.timeoutMs) ||
    (c.timeoutMs as number) < 1 ||
    (c.timeoutMs as number) > MAX_TIMEOUT_MS
  ) {
    problems.push(`${label}: timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  }

  if (c.kind === "write") {
    if (!RISKS.includes(c.risk as Risk)) {
      problems.push(`${label}: a write capability needs risk low, medium or high`);
    }
    if (typeof c.prepare !== "function" || typeof c.perform !== "function") {
      problems.push(`${label}: a write capability needs prepare() and perform()`);
    }
  } else if (c.kind === "read") {
    if ("risk" in c) problems.push(`${label}: a read capability must not declare risk`);
    if (typeof c.run !== "function") problems.push(`${label}: a read capability needs run()`);
  }

  const schema = c.inputSchema;
  if (!isPlainObject(schema)) {
    problems.push(`${label}: inputSchema must be an object`);
    return problems;
  }
  if (schema.type !== "object") {
    problems.push(`${label}: inputSchema must have type "object"`);
  }
  if (schema.additionalProperties !== false) {
    problems.push(`${label}: inputSchema must set additionalProperties: false`);
  }
  const properties = isPlainObject(schema.properties) ? Object.keys(schema.properties) : [];
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
  for (const reserved of RESERVED_ARGUMENTS) {
    if (properties.includes(reserved) || required.includes(reserved)) {
      problems.push(
        `${label}: inputSchema must not declare "${reserved}" (identity travels in the envelope)`,
      );
    }
  }
  if ("patternProperties" in schema || "$ref" in schema || "$dynamicRef" in schema) {
    problems.push(`${label}: inputSchema must list its properties explicitly`);
  }
  return problems;
}

/** Deepest nesting `arguments` may have. Far above any declared input schema. */
const MAX_ARGUMENT_DEPTH = 32;

/** Whether a JSON value nests deeper than `limit`. Iterative, so it cannot itself overflow. */
function exceedsDepth(root: unknown, limit: number): boolean {
  let level: unknown[] = [root];
  for (let depth = 0; level.length > 0; depth += 1) {
    if (depth > limit) return true;
    const next: unknown[] = [];
    for (const value of level) {
      if (typeof value !== "object" || value === null) continue;
      for (const child of Object.values(value)) {
        if (typeof child === "object" && child !== null) next.push(child);
      }
    }
    level = next;
  }
  return false;
}

export class CapabilityRegistry {
  readonly #byName: ReadonlyMap<string, RegisteredCapability>;
  readonly inventory: Inventory;

  constructor(capabilities: readonly Capability[]) {
    const problems: string[] = [];
    if (capabilities.length > MAX_CAPABILITIES) {
      problems.push(
        `${capabilities.length} capabilities defined; the contract allows at most ${MAX_CAPABILITIES}`,
      );
    }

    // Strict: an unknown keyword or a malformed schema is a definition error, not ignored.
    const ajv = new Ajv2020({
      strict: true,
      allErrors: true,
      useDefaults: true,
      coerceTypes: false,
      removeAdditional: false,
    });
    addFormats(ajv);

    const byName = new Map<string, RegisteredCapability>();
    capabilities.forEach((cap, index) => {
      const label = typeof cap.name === "string" && cap.name ? cap.name : `capability #${index}`;
      const found = check(cap, label);
      if (byName.has(cap.name)) found.push(`${label}: duplicate name`);
      if (found.length > 0) {
        problems.push(...found);
        return;
      }
      let validate: ValidateFunction;
      try {
        validate = ajv.compile(cap.inputSchema);
      } catch (error) {
        problems.push(`${label}: inputSchema does not compile: ${(error as Error).message}`);
        return;
      }
      byName.set(cap.name, {
        definition: cap,
        checkArgs(args: unknown): ArgsCheck {
          // No capability takes nested arguments this deep, and cloning or
          // validating a body nested thousands of levels overflows the stack:
          // a 500 for what is the caller's malformed input.
          if (exceedsDepth(args, MAX_ARGUMENT_DEPTH)) {
            return { ok: false, detail: "arguments: nested too deeply" };
          }
          // Defaults are written into a copy, never into the caller's body.
          const value: unknown = isPlainObject(args) ? structuredClone(args) : args;
          if (validate(value)) return { ok: true, value: value as Record<string, unknown> };
          return { ok: false, detail: describeValidation(validate.errors ?? [], "arguments") };
        },
      });
    });

    if (problems.length > 0) throw new RegistryError(problems);
    this.#byName = byName;
    this.inventory = deepFreeze({
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      capabilities: [...byName.values()].map(({ definition: d }) => ({
        name: d.name,
        kind: d.kind,
        version: d.version,
        description: d.description,
        input_schema: structuredClone(d.inputSchema),
        requires_subject: d.requiresSubject,
        ...(d.kind === "write" ? { risk: d.risk } : {}),
      })),
    });
  }

  /** The capability served at this route kind, or null (unknown name or wrong kind). */
  get<K extends CapabilityKind>(
    name: string,
    kind: K,
  ): RegisteredCapability<Extract<Capability, { kind: K }>> | null {
    const entry = this.#byName.get(name);
    if (entry === undefined || entry.definition.kind !== kind) return null;
    return entry as RegisteredCapability<Extract<Capability, { kind: K }>>;
  }

  get size(): number {
    return this.#byName.size;
  }
}
