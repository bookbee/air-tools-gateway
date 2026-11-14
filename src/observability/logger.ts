/**
 * Structured JSON logs (pino). Request-scoped lines carry `request_id` (bound by Fastify) and,
 * after authentication, `key_id` and `tenant`.
 *
 * Nothing logs request headers or bodies. Redaction is a second line of defence in case a
 * future change does.
 */
import { createHash } from "node:crypto";

import { pino, type DestinationStream, type Logger } from "pino";

import type { Config } from "../config.js";

export type { Logger };

const REDACT = [
  "req.headers['x-api-key']",
  "req.headers.authorization",
  "headers['x-api-key']",
  "headers.authorization",
  "*.apiKey",
  "*.api_key",
  "*.rawKey",
];

export function createLogger(config: Config["log"], destination?: DestinationStream): Logger {
  return pino(
    {
      level: config.level,
      base: { service: "air-tools-gateway" },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACT, censor: "[redacted]" },
    },
    destination,
  );
}

/** A subject is logged only as a short digest prefix (handoff §9). */
export function subjectTag(subject: string | null): string | null {
  if (subject === null) return null;
  return createHash("sha256").update(subject, "utf8").digest("hex").slice(0, 12);
}
