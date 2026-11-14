/**
 * A per-key async mutex: two executes of one proposal run one after the other, so it acts at
 * most once. Correct for a single replica only; more replicas need a distributed lock
 * (docs/enhancements.md, "Storage and scale").
 */
export class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
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
