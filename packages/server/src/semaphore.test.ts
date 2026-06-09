/**
 * Process-wide run limiter tests (M6 / TRI-3282).
 *
 * Proves the load-bearing property: the {@link Semaphore} never lets more than
 * its permit count run at once, and queued callers proceed FIFO as permits free
 * up. This is what bounds the TOTAL number of simultaneous sidecar runs no
 * matter how many runs start at the same time.
 */

import { describe, expect, it } from "vitest";
import { Semaphore } from "./semaphore.js";

/** A deferred promise plus its resolver, for hand-controlled task timing. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("Semaphore", () => {
  it("never exceeds its permit count under more tasks than permits", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: 5 }, () => deferred());

    const tasks = gates.map((gate, i) =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await gate.promise;
        active--;
        return i;
      }),
    );

    // Let the scheduler run: only 2 permits → only 2 tasks may be active.
    await Promise.resolve();
    await Promise.resolve();
    expect(active).toBe(2);

    // Release tasks one at a time; the queue drains without ever exceeding 2.
    for (const gate of gates) {
      gate.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(await Promise.all(tasks)).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    // Back to fully free, nothing queued.
    expect(sem.free).toBe(2);
    expect(sem.waiting).toBe(0);
  });

  it("hands a freed permit to the next FIFO waiter", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    const first = deferred();

    const t1 = sem.run(async () => {
      order.push(1);
      await first.promise;
    });
    // Two more queue behind the single permit.
    const t2 = sem.run(async () => {
      order.push(2);
    });
    const t3 = sem.run(async () => {
      order.push(3);
    });

    await Promise.resolve();
    expect(order).toEqual([1]);
    expect(sem.waiting).toBe(2);

    first.resolve();
    await Promise.all([t1, t2, t3]);
    // FIFO: the queue ran in arrival order.
    expect(order).toEqual([1, 2, 3]);
  });

  it("releases the permit even when the guarded task throws", async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // The permit was returned, so a following task acquires immediately.
    const ran = await sem.run(async () => "ok");
    expect(ran).toBe("ok");
    expect(sem.free).toBe(1);
  });

  it("coerces a non-positive permit count to 1 so it can never deadlock", async () => {
    const sem = new Semaphore(0);
    expect(sem.free).toBe(1);
    expect(await sem.run(async () => 42)).toBe(42);
  });
});
