/**
 * Stand-in backends for failure tests: one that never answers, one that fails loudly with the
 * kind of message that must never reach a caller.
 */
import { BackendError, type OrdersBackend } from "../../src/backends/orders.js";

/** Contains a URL, a credential and a raw error: none may appear in a response. */
export const LEAKY_BACKEND_MESSAGE =
  "GET http://orders.internal:9000/v2/orders?api_token=s3cr3t-token returned 500: ECONNRESET";

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

export function hangingBackend(): OrdersBackend {
  return {
    listRecent: never,
    get: never,
    cancel: never,
    ping: () => Promise.resolve(true),
  };
}

export function failingBackend(): OrdersBackend {
  const fail = <T>(): Promise<T> => Promise.reject(new BackendError(LEAKY_BACKEND_MESSAGE));
  return { listRecent: fail, get: fail, cancel: fail, ping: () => Promise.resolve(false) };
}

/** A capability bug, not a backend failure: must become the fixed 500. */
export function buggyBackend(): OrdersBackend {
  const bug = <T>(): Promise<T> => Promise.reject(new TypeError(LEAKY_BACKEND_MESSAGE));
  return { listRecent: bug, get: bug, cancel: bug, ping: () => Promise.resolve(true) };
}
