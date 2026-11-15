/**
 * The per-proposal lock (handoff §7.3): two executes of one proposal run one after the other,
 * so it acts at most once.
 *
 * Two implementations: `KeyedMutex` here (one process; correct for a single replica) and
 * `RedisLock` in `redis/lock.ts` (shared by replicas). The lock is not the only guard: the
 * proposal's state change is a compare-and-set (`ProposalStore.transition`), and
 * `orders.cancel` passes the proposal id to the backend as an idempotency reference. A lock
 * that expired under a stalled holder therefore still cannot cancel twice.
 */

export interface LockOptions {
  /**
   * The longest the holder can keep it. A distributed lock expires after this, so it must
   * cover the whole critical section (the capability's deadline plus the store calls).
   */
  readonly holdMs: number;
  /** How long to wait for another holder before giving up with `LockTimeoutError`. */
  readonly waitMs: number;
}

export interface ProposalLock {
  run<T>(key: string, options: LockOptions, fn: () => Promise<T>): Promise<T>;
}

/** Another execute of the same proposal held the lock for longer than `waitMs`. */
export class LockTimeoutError extends Error {
  constructor() {
    super("timed out waiting for the proposal lock");
    this.name = "LockTimeoutError";
  }
}

/**
 * In-process mutex. It never times out: every holder is bounded by its capability's deadline,
 * so a waiter is at most one deadline behind.
 */
export class KeyedMutex implements ProposalLock {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, _options: LockOptions, fn: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      // Forget the key once nobody else is queued behind us.
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }

  /** Test support: keys currently held or queued. */
  get size(): number {
    return this.#tails.size;
  }
}
