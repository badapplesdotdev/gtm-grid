/**
 * `share` router procedure tests via `createCaller`, OFFLINE against a
 * `TestLayer` context (no live DB). Focuses on the two behaviours the review
 * flagged as untested:
 *   - `getByToken` is PUBLIC and gates correctly: a valid token returns the
 *     frozen snapshot; an unknown / disabled / EXPIRED token returns
 *     `{ valid:false }` and leaks no detail.
 *   - `revoke` is member-gated (member ok, non-member FORBIDDEN, anonymous
 *     UNAUTHORIZED) and actually disables the link.
 *   - `create` enforces the snapshot size cap (`ShareTooLargeError` →
 *     BAD_REQUEST) and mints a link for a normal table.
 */

import type { Membership, TableShare } from "@gtmgrid/services";
import { TestLayer, type TestLayerFixtures } from "@gtmgrid/services";
import { describe, expect, it } from "vitest";
import { createTestContext } from "../context";
import { appRouter } from "../root";
import { createCallerFactory } from "../trpc";

const createCaller = createCallerFactory(appRouter);

const WS = "ws-1";
const PROJECT = "proj-1";
const TABLE = "table-1";
const COL = "col-1";
const ROW = "row-1";
const MEMBER = "member";
const OUTSIDER = "outsider";

const validSnapshot = { version: 1, table: { name: "Companies" }, columns: [], rows: 0, cells: [] };

const share = (over: Partial<TableShare>): TableShare => ({
  id: "share-1", workspaceId: WS, tableId: "table-1", token: "live", name: "Companies",
  snapshot: validSnapshot, snapshotVersion: 1, enabled: true, expiresAt: null,
  createdBy: MEMBER, createdAt: 1, revokedAt: null, ...over,
});

const memberships: readonly Membership[] = [{ workspaceId: WS, userId: MEMBER, role: "member" }];

// `userId` wires BOTH the protectedProcedure auth check (ctx.userId) and the
// runtime Identity the service authz reads (TestLayer's currentUserId).
const caller = (fixtures: TestLayerFixtures, userId: string | null) =>
  createCaller(createTestContext({ layer: TestLayer({ ...fixtures, currentUserId: userId }), userId }));

describe("share.getByToken (public token resolution)", () => {
  const shares: TableShare[] = [
    share({ id: "s-live", token: "live", enabled: true }),
    share({ id: "s-off", token: "off", enabled: false }),
    share({ id: "s-expired", token: "expired", enabled: true, expiresAt: 1 }), // epoch 1ms → long past
  ];

  it("returns the snapshot for a live token", async () => {
    const result = await caller({ shares }, null).share.getByToken({ token: "live" });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.snapshot.table.name).toBe("Companies");
  });

  it("returns { valid:false } for unknown, disabled, and expired tokens", async () => {
    const c = caller({ shares }, null);
    expect(await c.share.getByToken({ token: "missing" })).toEqual({ valid: false });
    expect(await c.share.getByToken({ token: "off" })).toEqual({ valid: false });
    expect(await c.share.getByToken({ token: "expired" })).toEqual({ valid: false });
  });
});

describe("share.revoke (member-gated)", () => {
  it("lets a member revoke and disables the link immediately", async () => {
    const shares: TableShare[] = [share({ id: "s-1", token: "live", enabled: true })];
    const c = caller({ shares, memberships }, MEMBER);
    await c.share.revoke({ shareId: "s-1" });
    // After revoke the token no longer resolves (the link is disabled).
    expect(await c.share.getByToken({ token: "live" })).toEqual({ valid: false });
  });

  it("rejects a non-member with FORBIDDEN", async () => {
    const shares: TableShare[] = [share({ id: "s-1" })];
    await expect(
      caller({ shares, memberships }, OUTSIDER).share.revoke({ shareId: "s-1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects an unauthenticated caller with UNAUTHORIZED", async () => {
    const shares: TableShare[] = [share({ id: "s-1" })];
    await expect(
      caller({ shares, memberships }, null).share.revoke({ shareId: "s-1" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("share.create (snapshot size cap)", () => {
  // A grid fixture whose single cell holds `cellValue`, so the built snapshot's
  // size is driven by that value. `getTable` gates on membership + a cloud plan,
  // so both are seeded.
  const gridFixtures = (cellValue: string): TestLayerFixtures => ({
    workspaces: [{ id: WS, name: "WS", ownerId: MEMBER, currentPlanId: "team" }],
    memberships,
    gridProjects: [{ id: PROJECT, workspaceId: WS, name: "P", createdAt: 1 }],
    gridTables: [{ id: TABLE, workspaceId: WS, projectId: PROJECT, name: "Companies", position: 0, createdAt: 1, dedupeColumn: null, dedupeKeep: null, folderId: null, favorite: false }],
    gridColumns: [{ id: COL, workspaceId: WS, tableId: TABLE, name: "Data", type: "text", kind: "manual", provider: null, method: null, code: null, params: {}, condition: null, position: 0, createdAt: 1 }],
    gridRows: [{ id: ROW, workspaceId: WS, tableId: TABLE, position: 0, createdAt: 1 }],
    gridCells: [{ id: "cell-1", workspaceId: WS, tableId: TABLE, rowId: ROW, columnId: COL, value: cellValue, status: "done", error: null, updatedAt: 1 }],
  });

  it("rejects a table whose snapshot exceeds the size cap with BAD_REQUEST", async () => {
    // One cell just over the 5 MB snapshot cap.
    const huge = "x".repeat(5_000_001);
    await expect(
      caller(gridFixtures(huge), MEMBER).share.create({ tableId: TABLE }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("mints a share link for a normal-sized table", async () => {
    const result = await caller(gridFixtures("Acme"), MEMBER).share.create({ tableId: TABLE });
    expect(result.token).toBeTruthy();
    expect(result.shareUrl).toContain(result.token);
  });
});
