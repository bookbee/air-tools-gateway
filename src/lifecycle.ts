/**
 * Graceful shutdown.
 *
 * On SIGTERM (or SIGINT):
 *   1. `draining` turns on, so `/v1/ready` answers 503 and a load balancer stops routing here.
 *   2. `app.close()` stops accepting connections and waits for in-flight requests; requests
 *      already on a kept-alive connection are still served normally (not Fastify's 503).
 *   3. The stores close only once every tracked action (propose, execute) has finished, so an
 *      execute that is running stores its answer before Redis goes away.
 *   4. If that takes longer than `drainTimeoutMs`, the process exits anyway (code 1). An
 *      execute cut off there was never stored, so a retry with the same Idempotency-Key is
 *      safe: the backend reference makes a repeated cancel a no-op.
 * A second signal exits at once.
 */
import type { FastifyBaseLogger } from "fastify";

export class Lifecycle {
  #draining = false;
  #inFlight = 0;
  #idle: (() => void)[] = [];

  get draining(): boolean {
    return this.#draining;
  }

  /** Actions currently running (propose, execute). */
  get inFlight(): number {
    return this.#inFlight;
  }

  startDraining(): void {
    this.#draining = true;
  }

  /** Run an action that must finish before the stores close. */
  async track<T>(fn: () => Promise<T>): Promise<T> {
    this.#inFlight += 1;
    try {
      return await fn();
    } finally {
      this.#inFlight -= 1;
      if (this.#inFlight === 0) for (const resolve of this.#idle.splice(0)) resolve();
    }
  }

  /** Resolves once no tracked action is running. */
  idle(): Promise<void> {
    if (this.#inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idle.push(resolve));
  }
}

export interface Closable {
  readonly lifecycle: Lifecycle;
  readonly log: FastifyBaseLogger;
  close(): Promise<unknown>;
}

export interface ShutdownOptions {
  readonly drainTimeoutMs: number;
  /** process.exit, replaced in tests. */
  readonly exit: (code: number) => void;
}

/**
 * Drain and close `app`; resolves with the exit code it passed to `exit`. Exported for tests:
 * `installShutdown` is the process wiring.
 */
export async function shutdown(
  app: Closable,
  signal: string,
  options: ShutdownOptions,
): Promise<number> {
  app.lifecycle.startDraining();
  app.log.info(
    { signal, in_flight_actions: app.lifecycle.inFlight, drain_timeout_ms: options.drainTimeoutMs },
    "shutdown.requested",
  );
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), options.drainTimeoutMs);
    timer.unref();
  });
  const closed = app.close().then(
    () => "closed" as const,
    () => "failed" as const,
  );
  const outcome = await Promise.race([closed, timedOut]);
  clearTimeout(timer);
  const code = outcome === "closed" ? 0 : 1;
  if (outcome === "timeout") {
    app.log.warn({ in_flight_actions: app.lifecycle.inFlight }, "shutdown.forced");
  } else if (outcome === "failed") {
    app.log.error("shutdown.close_failed");
  } else {
    app.log.info("shutdown.complete");
  }
  options.exit(code);
  return code;
}

export function installShutdown(app: Closable, options: ShutdownOptions): void {
  let started = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (started) {
        app.log.warn({ signal }, "shutdown.second_signal");
        options.exit(1);
        return;
      }
      started = true;
      void shutdown(app, signal, options);
    });
  }
}
