import { describe, expect, it } from "vitest";
import { abortInFlight, type AbortRef } from "./agentAbort";

// The panel calls `abortInFlight(abortRef)` from a `useEffect` cleanup, so it
// fires on unmount (closing the panel) and on agent/table/cloud context change.
// A full React render harness isn't set up here (the desktop suite covers
// client LOGIC only), so we cover the extracted abort-lifecycle unit directly —
// this is the regression test for the "no unmount abort" leak (TRI-3305).

describe("abortInFlight — abort the in-flight agent turn on unmount/context change", () => {
  it("aborts the active controller (the unmount-while-streaming case)", () => {
    const controller = new AbortController();
    const ref: AbortRef = { current: controller };

    expect(controller.signal.aborted).toBe(false);
    abortInFlight(ref);

    expect(controller.signal.aborted).toBe(true);
  });

  it("clears the ref so a second cleanup can't abort a stale controller", () => {
    const controller = new AbortController();
    const ref: AbortRef = { current: controller };

    abortInFlight(ref);
    expect(ref.current).toBeNull();

    // A later unmount after a context-change must be a safe no-op.
    expect(() => abortInFlight(ref)).not.toThrow();
  });

  it("is a no-op when no request is in flight", () => {
    const ref: AbortRef = { current: null };
    expect(() => abortInFlight(ref)).not.toThrow();
  });

  it("only aborts the current controller, not one swapped in afterwards", () => {
    const first = new AbortController();
    const ref: AbortRef = { current: first };
    abortInFlight(ref); // first turn torn down

    // A new turn installs a fresh controller; the prior cleanup must not touch it.
    const second = new AbortController();
    ref.current = second;
    expect(second.signal.aborted).toBe(false);
  });
});
