/**
 * X-API-Key → {keyId, tenant, scope}, then the route's scope check.
 *
 * Every route declares `config.auth`: `"none"` (health, ready, metrics), `"read"` or
 * `"execute"`. A route that forgets is refused with a 500 rather than left open. The check
 * runs `onRequest`, before the body is parsed, so an unauthenticated caller learns nothing
 * about validation.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

import type { KeyRing, Scope } from "../security/apiKeys.js";
import { INTERNAL_PROBLEM, Problem } from "./problems.js";

export type RouteAuth = "none" | Scope;

export const API_KEY_HEADER = "x-api-key";

export function authenticate(keys: KeyRing) {
  return async function authHook(request: FastifyRequest, _reply: FastifyReply) {
    const auth = request.routeOptions.config.auth;
    if (auth === "none") return;
    if (auth !== "read" && auth !== "execute") {
      // A not-found route has no config; let the not-found handler answer it.
      if (request.is404) return;
      request.log.error({ url: request.routeOptions.url }, "route.missing_auth_config");
      throw INTERNAL_PROBLEM;
    }

    const header = request.headers[API_KEY_HEADER];
    const identity = keys.identify(typeof header === "string" ? header : undefined);
    if (identity === null) {
      throw new Problem("unauthorized", "A valid X-API-Key is required.");
    }
    request.identity = identity;
    request.log = request.log.child({ key_id: identity.keyId, tenant: identity.tenant });

    if (identity.scope !== auth) {
      throw new Problem("forbidden", `This endpoint needs a key with the ${auth} scope.`);
    }
  };
}
