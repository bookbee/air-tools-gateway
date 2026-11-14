/**
 * RFC 9457 problem details with a closed-set `code` (contract rule 10).
 *
 * Every error leaves the service through `sendProblem`. `detail` is written here or by a
 * capability, never copied from a backend, a stack or a library message, so it cannot carry
 * a URL, a credential or a value the caller sent.
 */
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

export const PROBLEM_CODES = [
  "invalid_arguments",
  "unauthorized",
  "forbidden",
  "unknown_capability",
  "not_found",
  "invalid_state",
  "not_permitted",
  "limit_exceeded",
  "proposal_expired",
  "already_executed",
  "rate_limited",
  "upstream_error",
  "upstream_timeout",
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

export const PROBLEM_CONTENT_TYPE = "application/problem+json";
const TYPE_BASE = "https://air.local/problems/";

const DEFAULTS: Record<ProblemCode, { status: number; title: string }> = {
  invalid_arguments: { status: 400, title: "Invalid arguments" },
  unauthorized: { status: 401, title: "Unauthorized" },
  forbidden: { status: 403, title: "Forbidden" },
  unknown_capability: { status: 404, title: "Unknown capability" },
  not_found: { status: 404, title: "Not found" },
  invalid_state: { status: 422, title: "Not possible in the current state" },
  not_permitted: { status: 422, title: "Not permitted" },
  limit_exceeded: { status: 422, title: "Limit exceeded" },
  proposal_expired: { status: 409, title: "Proposal expired" },
  already_executed: { status: 409, title: "Already executed" },
  rate_limited: { status: 429, title: "Rate limited" },
  upstream_error: { status: 502, title: "Upstream error" },
  upstream_timeout: { status: 504, title: "Upstream timeout" },
};

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  code: ProblemCode;
  detail?: string;
}

export class Problem extends Error {
  readonly status: number;
  readonly title: string;

  constructor(
    readonly code: ProblemCode,
    readonly detail?: string,
    overrides: { status?: number; title?: string } = {},
  ) {
    super(code);
    this.name = "Problem";
    this.status = overrides.status ?? DEFAULTS[code].status;
    this.title = overrides.title ?? DEFAULTS[code].title;
  }

  toBody(): ProblemBody {
    const body: ProblemBody = {
      type: TYPE_BASE + this.code,
      title: this.title,
      status: this.status,
      code: this.code,
    };
    if (this.detail !== undefined) body.detail = this.detail;
    return body;
  }
}

/**
 * The contract has no internal-error code (docs/enhancements.md C2). An unexpected error is a
 * fixed 500 carrying `upstream_error`, with nothing about the cause.
 */
export const INTERNAL_PROBLEM = new Problem("upstream_error", "An unexpected error occurred.", {
  status: 500,
  title: "Internal error",
});

export function isProblemCode(value: unknown): value is ProblemCode {
  return typeof value === "string" && (PROBLEM_CODES as readonly string[]).includes(value);
}

export function sendProblem(request: FastifyRequest, reply: FastifyReply, problem: Problem) {
  request.problemCode = problem.code;
  return reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem.toBody());
}

interface ValidationIssue {
  keyword: string;
  instancePath: string;
  params: Record<string, unknown>;
}

/** Field paths only: never the value, never Ajv's message text. */
export function describeValidation(issues: readonly ValidationIssue[], root: string): string {
  const parts = issues.map((issue) => {
    const base = root + issue.instancePath;
    if (issue.keyword === "additionalProperties") {
      return `${base}/${String(issue.params.additionalProperty)}: unknown field`;
    }
    if (issue.keyword === "required") {
      return `${base}/${String(issue.params.missingProperty)}: required`;
    }
    return `${base}: failed ${issue.keyword}`;
  });
  return [...new Set(parts)].slice(0, 10).join("; ");
}

/** Map anything thrown in a route or hook to a problem. */
export function toProblem(error: FastifyError | Error): Problem | null {
  if (error instanceof Problem) return error;
  const fe = error as FastifyError;
  if (Array.isArray(fe.validation)) {
    const root = fe.validationContext ?? "body";
    return new Problem("invalid_arguments", describeValidation(fe.validation, root));
  }
  if (typeof fe.code === "string" && fe.code.startsWith("FST_ERR_CTP_")) {
    // Unsupported media type, empty or malformed JSON, body too large.
    return new Problem("invalid_arguments", "The body must be a JSON object (application/json).");
  }
  return null;
}
