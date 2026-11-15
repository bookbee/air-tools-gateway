/**
 * The shared store (Redis) failed or timed out. Its message is fixed: the underlying error
 * can name hosts, so only its code is kept, for the log. Routes answer `502 upstream_error`,
 * which execute never stores, so a retry with the same Idempotency-Key is safe.
 */
export class StoreError extends Error {
  constructor(readonly code: string) {
    super("store unavailable");
    this.name = "StoreError";
  }
}

/** Run a store call, turning any failure into a `StoreError` that carries only a code. */
export async function guarded<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new StoreError(
      typeof code === "string" ? code : error instanceof Error ? error.name : "unknown",
    );
  }
}
