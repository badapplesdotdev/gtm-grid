import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The controller lazily connects via `subscribeToGrid` (the realtime service)
// using a token from `mintRealtimeToken` and the module-level `PARTY_URL`. Mock
// both so the class runs with no network: we assert WHAT it publishes and WHEN.
const subscribeToGrid = vi.fn();
const mintRealtimeToken = vi.fn(async (..._args: unknown[]) => "tok-123");

vi.mock("@gtmgrid/services/realtime", () => ({
  subscribeToGrid: (...args: unknown[]) => subscribeToGrid(...args),
}));
vi.mock("./useCloudGrid", () => ({
  PARTY_URL: "wss://party.example",
  mintRealtimeToken: (...args: unknown[]) => mintRealtimeToken(...args),
}));

import { AgentPresenceController, type AgentPresenceContext } from "./agentPresence";
import type { AgentPresencePatch } from "./agentToolPresence";

const ctx: AgentPresenceContext = {
  workspaceId: "ws1",
  tableId: "t1",
  userId: "u1",
  userName: "Morgan Parry",
};

/** A fake GridSubscription whose calls we can inspect. */
function makeSub() {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updatePresence: vi.fn(async (_presence?: any) => {}),
    unsubscribe: vi.fn(async () => {}),
  };
}

const patch = (over: Partial<AgentPresencePatch> = {}): AgentPresencePatch => ({
  cursor: null,
  editing: null,
  column: null,
  activity: "adding 5 rows",
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  subscribeToGrid.mockReset();
  mintRealtimeToken.mockReset().mockResolvedValue("tok-123");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentPresenceController — throttled publish + lazy connect", () => {
  it("connects once and sends the patch after the throttle window", async () => {
    const sub = makeSub();
    subscribeToGrid.mockReturnValue(sub);
    const c = new AgentPresenceController(ctx);

    c.publish(patch({ activity: "adding 5 rows" }));
    // Nothing happens until the trailing-throttle timer fires.
    expect(subscribeToGrid).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(120);

    expect(mintRealtimeToken).toHaveBeenCalledWith("ws1");
    expect(subscribeToGrid).toHaveBeenCalledTimes(1);
    expect(subscribeToGrid).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "wss://party.example",
        token: "tok-123",
        workspaceId: "ws1",
        tableId: "t1",
      }),
    );
    expect(sub.updatePresence).toHaveBeenCalledTimes(1);
    expect(sub.updatePresence).toHaveBeenCalledWith({
      userId: "u1",
      agent: true,
      name: "Morgan's Agent",
      image: null,
      cursor: null,
      editing: null,
      column: null,
      activity: "adding 5 rows",
    });
  });

  it("coalesces bursts to a single trailing send with the LAST patch", async () => {
    const sub = makeSub();
    subscribeToGrid.mockReturnValue(sub);
    const c = new AgentPresenceController(ctx);

    c.publish(patch({ activity: "first" }));
    c.publish(patch({ activity: "second" }));
    c.publish(patch({ activity: "third" }));

    await vi.advanceTimersByTimeAsync(120);

    expect(sub.updatePresence).toHaveBeenCalledTimes(1);
    expect(sub.updatePresence.mock.calls[0][0]).toMatchObject({ activity: "third" });
    // Only one socket for the whole burst.
    expect(subscribeToGrid).toHaveBeenCalledTimes(1);
  });

  it("reuses the same socket across separate publishes", async () => {
    const sub = makeSub();
    subscribeToGrid.mockReturnValue(sub);
    const c = new AgentPresenceController(ctx);

    c.publish(patch({ activity: "one" }));
    await vi.advanceTimersByTimeAsync(120);
    c.publish(patch({ activity: "two" }));
    await vi.advanceTimersByTimeAsync(120);

    expect(subscribeToGrid).toHaveBeenCalledTimes(1);
    expect(sub.updatePresence).toHaveBeenCalledTimes(2);
  });

  it("maps an empty activity string to a null label", async () => {
    const sub = makeSub();
    subscribeToGrid.mockReturnValue(sub);
    const c = new AgentPresenceController(ctx);

    c.publish(patch({ activity: "" }));
    await vi.advanceTimersByTimeAsync(120);

    expect(sub.updatePresence.mock.calls[0][0]).toMatchObject({ activity: null });
  });

  it("stamps cursor / editing / column from the patch", async () => {
    const sub = makeSub();
    subscribeToGrid.mockReturnValue(sub);
    const c = new AgentPresenceController(ctx);

    const cell = { rowId: "r9", columnId: "c3" };
    c.publish(patch({ cursor: cell, editing: cell, column: "c3", activity: "updating 1 cell" }));
    await vi.advanceTimersByTimeAsync(120);

    expect(sub.updatePresence.mock.calls[0][0]).toMatchObject({
      cursor: cell,
      editing: cell,
      column: "c3",
      activity: "updating 1 cell",
    });
  });

  it("labels the agent '<first name>'s Agent', falling back to 'Agent'", async () => {
    const cases: Array<[string | null, string]> = [
      ["Morgan Parry", "Morgan's Agent"],
      ["Cher", "Cher's Agent"],
      [null, "Agent"],
      ["", "Agent"],
      ["   ", "Agent"],
    ];
    for (const [userName, expected] of cases) {
      const sub = makeSub();
      subscribeToGrid.mockReturnValue(sub);
      const c = new AgentPresenceController({ ...ctx, userName });
      c.publish(patch());
      await vi.advanceTimersByTimeAsync(120);
      expect(sub.updatePresence.mock.calls[0][0]).toMatchObject({ name: expected });
    }
  });
});

describe("AgentPresenceController — endTurn / dispose lifecycle", () => {
  it("clears presence BEFORE unsubscribing on endTurn", async () => {
    const sub = makeSub();
    subscribeToGrid.mockReturnValue(sub);
    const c = new AgentPresenceController(ctx);

    c.publish(patch({ cursor: { rowId: "r", columnId: "c" }, activity: "working" }));
    await vi.advanceTimersByTimeAsync(120);
    sub.updatePresence.mockClear();

    await c.endTurn();

    // The clear is sent first (cursor/editing/column null, activity null), THEN close.
    expect(sub.updatePresence).toHaveBeenCalledTimes(1);
    expect(sub.updatePresence).toHaveBeenCalledWith({
      userId: "u1",
      agent: true,
      name: "Morgan's Agent",
      image: null,
      cursor: null,
      editing: null,
      column: null,
      activity: null,
    });
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    const clearOrder = sub.updatePresence.mock.invocationCallOrder[0];
    const closeOrder = sub.unsubscribe.mock.invocationCallOrder[0];
    expect(clearOrder).toBeLessThan(closeOrder);
  });

  it("cancels a pending throttled send when the turn ends first", async () => {
    const sub = makeSub();
    subscribeToGrid.mockReturnValue(sub);
    const c = new AgentPresenceController(ctx);

    // Connect once so endTurn has a socket to clear/close.
    c.publish(patch({ activity: "one" }));
    await vi.advanceTimersByTimeAsync(120);
    sub.updatePresence.mockClear();

    // Queue another send, but end the turn before the timer fires.
    c.publish(patch({ activity: "queued-but-dropped" }));
    await c.endTurn();
    await vi.advanceTimersByTimeAsync(200);

    // Only the endTurn clear was sent — the queued patch never went out.
    const labels = sub.updatePresence.mock.calls.map((c) => c[0].activity);
    expect(labels).toEqual([null]);
  });

  it("endTurn is a no-op (no throw) when never connected", async () => {
    subscribeToGrid.mockReturnValue(makeSub());
    const c = new AgentPresenceController(ctx);
    await expect(c.endTurn()).resolves.toBeUndefined();
    expect(subscribeToGrid).not.toHaveBeenCalled();
  });

  it("ignores publishes after dispose", async () => {
    const sub = makeSub();
    subscribeToGrid.mockReturnValue(sub);
    const c = new AgentPresenceController(ctx);

    c.dispose();
    c.publish(patch());
    await vi.advanceTimersByTimeAsync(200);

    expect(subscribeToGrid).not.toHaveBeenCalled();
  });

  it("swallows a token-mint failure without sending (best-effort presence)", async () => {
    mintRealtimeToken.mockRejectedValue(new Error("mint failed"));
    const c = new AgentPresenceController(ctx);

    c.publish(patch());
    await vi.advanceTimersByTimeAsync(120);

    expect(subscribeToGrid).not.toHaveBeenCalled();
  });
});
