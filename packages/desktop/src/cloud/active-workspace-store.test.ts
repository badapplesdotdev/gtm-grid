/**
 * Tests for the shared active-workspace store (Critical #20).
 *
 * The bug this guards against: `useActiveWorkspace` used to seed a per-hook-
 * instance `useState` from `localStorage`, so each consumer (App, the plan
 * badge, the dropdown) had its OWN copy of the selection. Selecting a workspace
 * in one place did not update the others until a reload. The fix makes the
 * selected id a SINGLE shared module store; every consumer reads it via
 * `useSyncExternalStore`, so one `set` re-renders all of them consistently.
 *
 * These assert the store's observable contract directly (no React rendering,
 * which the node test env does not support): subscribe / getSnapshot / set, plus
 * the default-selection persistence that resolves a real workspace for a freshly
 * signed-in client instead of leaving it on "Local workspace".
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeWorkspaceStore,
  resolveActiveWorkspace,
  type WorkspaceSummary,
} from "./auth";

const ws = (id: string, name: string): WorkspaceSummary => ({
  _id: id as WorkspaceSummary["_id"],
  name,
  role: "owner",
  seatUsage: { used: 1, limit: null },
  plan: { id: null, name: "Free" },
  cloudActions: { used: 0, limit: null },
});

// The store is a singleton; reset its observable value between tests so cases do
// not leak the selected id into one another.
afterEach(() => {
  activeWorkspaceStore.set("__reset__");
});

describe("activeWorkspaceStore — single shared source of truth", () => {
  it("delivers one set to every subscriber, who then read the same snapshot", () => {
    // Two independent consumers (e.g. the plan badge and the dropdown).
    const consumerA = vi.fn();
    const consumerB = vi.fn();
    const unsubA = activeWorkspaceStore.subscribe(consumerA);
    const unsubB = activeWorkspaceStore.subscribe(consumerB);

    // A single selection made in one place...
    activeWorkspaceStore.set("ws-shared");

    // ...notifies BOTH consumers, and both observe the identical value.
    expect(consumerA).toHaveBeenCalledTimes(1);
    expect(consumerB).toHaveBeenCalledTimes(1);
    expect(activeWorkspaceStore.getSnapshot()).toBe("ws-shared");

    unsubA();
    unsubB();
  });

  it("does not notify for a no-op set to the current value", () => {
    activeWorkspaceStore.set("ws-1");
    const listener = vi.fn();
    const unsub = activeWorkspaceStore.subscribe(listener);

    activeWorkspaceStore.set("ws-1"); // same value → no change, no emit
    expect(listener).not.toHaveBeenCalled();

    activeWorkspaceStore.set("ws-2"); // real change → emit
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("stops notifying after a subscriber unsubscribes", () => {
    const listener = vi.fn();
    const unsub = activeWorkspaceStore.subscribe(listener);
    activeWorkspaceStore.set("ws-a");
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    activeWorkspaceStore.set("ws-b");
    expect(listener).toHaveBeenCalledTimes(1); // not called again
  });
});

describe("default-selection persistence (signed in, none selected)", () => {
  it("resolves the first workspace and persists it to the shared store", () => {
    activeWorkspaceStore.set("__reset__");
    const list = [ws("first", "First"), ws("second", "Second")];

    // No selection yet (the freshly-signed-in / second-session case).
    const stored = activeWorkspaceStore.getSnapshot();
    expect(stored).not.toBe(list[0]._id);

    // The hook resolves the default (first workspace) and writes it back so the
    // selection is shared and durable — this is what the effect in
    // `useActiveWorkspace` does after `me` loads.
    const resolved = resolveActiveWorkspace(list, stored);
    expect(resolved).toBe(list[0]);

    const consumer = vi.fn();
    const unsub = activeWorkspaceStore.subscribe(consumer);
    activeWorkspaceStore.set(resolved!._id);

    // The shared store now reflects the defaulted workspace for every consumer.
    expect(activeWorkspaceStore.getSnapshot()).toBe("first");
    expect(consumer).toHaveBeenCalledTimes(1);
    unsub();
  });
});
