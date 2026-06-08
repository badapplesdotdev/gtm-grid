/**
 * `signals` router procedure tests via `createCaller`, OFFLINE against a
 * `TestLayer` context (no live DB, no Trigify HTTP). Verifies the gating
 * contract the desktop "From Social Signals" cloud flow depends on: member
 * success, non-member FORBIDDEN, unauthenticated UNAUTHORIZED, and — the key
 * cloud-correctness check — a lapsed-trial / Free workspace is rejected with
 * FORBIDDEN (the paid feature can't run for free).
 */

import type {
  GridTable,
  Membership,
  SignalBinding,
} from "@gtmgrid/services";
import { TestLayer, type TestLayerFixtures } from "@gtmgrid/services";
import { describe, expect, it } from "vitest";
import { createTestContext } from "../context";
import { appRouter } from "../root";
import { createCallerFactory } from "../trpc";

const createCaller = createCallerFactory(appRouter);

const WS = "ws-1";
const TABLE = "table-1";

const memberships: readonly Membership[] = [
  { workspaceId: WS, userId: "member", role: "member" },
];
const tables: GridTable[] = [
  { id: TABLE, workspaceId: WS, projectId: "p1", name: "T", position: 0, createdAt: 1 },
];
const binding: SignalBinding = {
  id: "sig-1",
  workspaceId: WS,
  tableId: TABLE,
  sourceId: "linkedin-posts",
  label: "LinkedIn Posts",
  kind: "search",
  searchId: "srch-1",
  config: {},
  schedule: "hourly",
  columns: [],
  seen: [],
  lastSyncedAt: null,
  lastError: null,
  rowsPulled: 0,
  enabled: true,
  createdAt: 1,
};

// Default the workspace to a cloud-enabled plan ("team"); override `workspaces`
// to exercise a locked / Free workspace.
const callerFor = (fixtures: TestLayerFixtures) =>
  createCaller(
    createTestContext({
      layer: TestLayer({
        workspaces: [{ id: WS, name: "WS", ownerId: "member", currentPlanId: "team" }],
        ...fixtures,
      }),
      userId: fixtures.currentUserId ?? null,
    }),
  );

describe("signals.sources", () => {
  it("returns the static Trigify source catalog for any authenticated user", async () => {
    const caller = callerFor({ currentUserId: "member" });
    const sources = await caller.signals.sources();
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.some((s) => s.id === "linkedin-posts")).toBe(true);
  });
});

describe("signals.listSignalBindings", () => {
  it("returns a table's bindings for an entitled member", async () => {
    const caller = callerFor({
      memberships,
      tables,
      signalBindings: [{ ...binding }],
      currentUserId: "member",
    });
    const list = await caller.signals.listSignalBindings({ tableId: TABLE });
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("sig-1");
  });

  it("rejects a non-member with FORBIDDEN", async () => {
    const caller = callerFor({
      memberships,
      tables,
      signalBindings: [{ ...binding }],
      currentUserId: "stranger",
    });
    await expect(
      caller.signals.listSignalBindings({ tableId: TABLE }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects an unauthenticated caller with UNAUTHORIZED", async () => {
    const caller = callerFor({ memberships, tables, currentUserId: null });
    await expect(
      caller.signals.listSignalBindings({ tableId: TABLE }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects a lapsed-trial (Free) workspace with FORBIDDEN", async () => {
    const caller = callerFor({
      workspaces: [{ id: WS, name: "WS", ownerId: "member", currentPlanId: null }],
      memberships,
      tables,
      signalBindings: [{ ...binding }],
      currentUserId: "member",
    });
    await expect(
      caller.signals.listSignalBindings({ tableId: TABLE }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("signals.syncSignalBinding / deleteSignalBinding (entitlement gated)", () => {
  it("blocks manual sync on a Free workspace with FORBIDDEN", async () => {
    const caller = callerFor({
      workspaces: [{ id: WS, name: "WS", ownerId: "member", currentPlanId: null }],
      memberships,
      tables,
      signalBindings: [{ ...binding }],
      currentUserId: "member",
    });
    await expect(
      caller.signals.syncSignalBinding({ bindingId: "sig-1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("deletes a binding for an entitled member", async () => {
    const signalBindings: SignalBinding[] = [{ ...binding }];
    const caller = callerFor({
      memberships,
      tables,
      signalBindings,
      currentUserId: "member",
    });
    await caller.signals.deleteSignalBinding({ bindingId: "sig-1" });
    expect(signalBindings).toHaveLength(0);
  });

  it("blocks delete on a Free workspace with FORBIDDEN", async () => {
    const caller = callerFor({
      workspaces: [{ id: WS, name: "WS", ownerId: "member", currentPlanId: null }],
      memberships,
      tables,
      signalBindings: [{ ...binding }],
      currentUserId: "member",
    });
    await expect(
      caller.signals.deleteSignalBinding({ bindingId: "sig-1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
