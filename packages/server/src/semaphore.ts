/**
 * A tiny async counting semaphore (plain TS — NOT Effect; the sidecar is plain
 * Node) used to bound work PROCESS-WIDE across otherwise-independent callers.
 *
 * The engine's per-run `mapConcurrent` only bounds a SINGLE column run's row
 * fan-out (M6): two simultaneous runs each at concurrency 5 still push 10
 * sandboxed executions through the one sidecar, and an auto-run + a manual run
 * multiply that further. This semaphore is shared at module scope by the run
 * routes so the TOTAL number of in-flight runs through the sidecar is capped
 * regardless of how many runs start at once. Callers `acquire()` a permit before
 * a run and `release()` it after (use {@link Semaphore.run} to pair them safely
 * even on throw); when all permits are taken, further `acquire()`s queue FIFO
 * until one is released.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  /**
   * @param permits The maximum number of concurrent holders. Coerced to an
   *   integer ≥ 1 so a misconfigured 0/negative value can never deadlock the
   *   sidecar (it would block every run forever).
   */
  constructor(permits: number) {
    this.available = Math.max(1, Math.floor(permits));
  }

  /** Permits currently free (for tests / introspection). */
  get free(): number {
    return this.available;
  }

  /** Callers currently queued waiting for a permit (for tests / introspection). */
  get waiting(): number {
    return this.waiters.length;
  }

  /**
   * Acquire one permit, resolving immediately if one is free or queueing FIFO
   * until another holder releases. Always pair with exactly one {@link release}
   * — prefer {@link run}, which guarantees that pairing even on throw.
   */
  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /**
   * Release one permit. If a caller is queued, it is handed the permit directly
   * (the count stays "taken"); otherwise the free count is incremented.
   */
  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.available++;
  }

  /** Run `fn` while holding one permit, releasing it whether `fn` resolves or throws. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
