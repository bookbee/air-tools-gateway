/**
 * X-Request-ID: use the caller's (the orchestrator's turn id) when it is safe to log, else
 * generate one. Fastify binds it to every request log line as `request_id`; `echoRequestId`
 * returns it on the response.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { FastifyReply, FastifyRequest } from "fastify";

export const REQUEST_ID_HEADER = "x-request-id";

/** Contract: at most 128 characters. Printable ASCII only, so it cannot forge log lines. */
const SAFE_REQUEST_ID = /^[\x21-\x7e]{1,128}$/;

export function genRequestId(req: IncomingMessage): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  if (typeof incoming === "string" && SAFE_REQUEST_ID.test(incoming)) return incoming;
  return randomUUID();
}

export async function echoRequestId(request: FastifyRequest, reply: FastifyReply) {
  reply.header("X-Request-ID", request.id);
}
