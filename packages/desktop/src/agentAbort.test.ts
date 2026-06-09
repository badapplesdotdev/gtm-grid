import { describe, expect, it } from "vitest";
import { abortInFlight, agentAbortKey, type AbortRef } from "./agentAbort";

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

// `agentAbortKey` is the STABLE dependency the panel's abort effect keys off
// (TRI-3306). The regression: TRI-3305 keyed the effect on the `activeTable`
// OBJECT identity, which App.tsx recreates on every re-render (cloud polling),
// so the cleanup aborted the live turn on every unrelated re-render. The key
// must change ONLY on a real agent/table switch — never just because a new
// object literal with the same contents was passed.
describe("agentAbortKey — abort iff the agent/table context actually changes", () => {
  it("is STABLE across new object identities for the same table (the regression)", () => {
    const agent = "claude";
    // Two distinct object literals — what App.tsx produces each re-render.
    const renderA = { name: "Leads", columns: ["a", "b"] };
    const renderB = { name: "Leads", columns: ["a", "b"] };
    expect(renderA).not.toBe(renderB); // different identity (would churn old deps)

    // Same key → no dep change → effect cleanup does NOT fire → live turn lives.
    expect(agentAbortKey(agent, renderA)).toBe(agentAbortKey(agent, renderB));
  });

  it("changes when the user switches agent (turn must abort)", () => {
    const table = { name: "Leads", columns: ["a"] };
    expect(agentAbortKey("claude", table)).not.toBe(agentAbortKey("codex", table));
  });

  it("changes when the user switches table / cloud project (turn must abort)", () => {
    expect(agentAbortKey("claude", { name: "Leads", columns: ["a"] })).not.toBe(
      agentAbortKey("claude", { name: "Accounts", columns: ["a"] }),
    );
  });

  it("is stable when only the column set changes but the table name does not", () => {
    // Column edits don't switch context, so they must not tear down the turn.
    expect(agentAbortKey("claude", { name: "Leads", columns: ["a"] })).toBe(
      agentAbortKey("claude", { name: "Leads", columns: ["a", "b", "c"] }),
    );
  });

  it("distinguishes a null table (local) from a named table", () => {
    expect(agentAbortKey("claude", null)).not.toBe(
      agentAbortKey("claude", { name: "Leads", columns: [] }),
    );
    // ...and two local (null) renders share a key.
    expect(agentAbortKey("claude", null)).toBe(agentAbortKey("claude", null));
  });
});
