/**
 * Presence-store tests — the publish discipline that keeps the socket quiet:
 * no publish before identity + publisher, cursor moves throttled, identity and
 * editing flushed immediately, and a clean teardown.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GridPresenceState } from "@gtmgrid/services/realtime";
import { createTrailingThrottle, gridPresenceStore } from "./presenceStore.js";

describe("createTrailingThrottle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces a burst into one trailing call", () => {
    const fn = vi.fn();
    const t = createTrailingThrottle(100, fn);
    t.schedule();
    t.schedule();
    t.schedule();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("flush fires a pending call immediately; cancel drops it", () => {
    const fn = vi.fn();
    const t = createTrailingThrottle(100, fn);
    t.schedule();
    t.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    t.schedule();
    t.cancel();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("gridPresenceStore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    gridPresenceStore.clear();
    gridPresenceStore.setPublisher(null);
    vi.useRealTimers();
  });

  it("does not publish before both identity and publisher exist", () => {
    const published: GridPresenceState[] = [];
    // No publisher yet: identity update buffers but cannot publish.
    gridPresenceStore.updateLocal({ userId: "u1", name: "Ada" });
    gridPresenceStore.setPublisher((s) => published.push(s));
    // Registering the publisher flushes the buffered identity immediately.
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ userId: "u1", name: "Ada" });
  });

  it("throttles cursor moves but flushes editing immediately", () => {
    const published: GridPresenceState[] = [];
    gridPresenceStore.setPublisher((s) => published.push(s));
    gridPresenceStore.updateLocal({ userId: "u1" });
    published.length = 0;

    gridPresenceStore.updateLocal({ cursor: { rowId: "r1", columnId: "c1" } });
    gridPresenceStore.updateLocal({ cursor: { rowId: "r1", columnId: "c2" } });
    expect(published).toHaveLength(0); // throttled
    vi.advanceTimersByTime(120);
    expect(published).toHaveLength(1);
    expect(published[0].cursor).toEqual({ rowId: "r1", columnId: "c2" });

    published.length = 0;
    gridPresenceStore.updateLocal({ editing: { rowId: "r1", columnId: "c2" } });
    expect(published).toHaveLength(1); // immediate
    expect(published[0].editing).toEqual({ rowId: "r1", columnId: "c2" });
  });

  it("notifies roster subscribers and clear() resets to empty", () => {
    const seen: number[] = [];
    const unsub = gridPresenceStore.subscribe(() =>
      seen.push(gridPresenceStore.getSnapshot().length),
    );
    gridPresenceStore.setRoster([{ userId: "u1" }, { userId: "u2" }]);
    expect(gridPresenceStore.getSnapshot()).toHaveLength(2);
    gridPresenceStore.clear();
    expect(gridPresenceStore.getSnapshot()).toHaveLength(0);
    expect(seen).toEqual([2, 0]);
    unsub();
  });
});
