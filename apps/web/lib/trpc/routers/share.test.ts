/**
 * `share` router procedure tests via `createCaller`, OFFLINE against a
 * `TestLayer` context (no live DB). Focuses on the two behaviours the review
 * flagged as untested:
 *   - `getByToken` is PUBLIC and gates correctly: a valid token returns the
 *     frozen snapshot; an unknown / disabled / EXPIRED token returns
 *     `{ valid:false }` and leaks no detail.
 *   - `revoke` is member-gated (member ok, non-member FORBIDDEN, anonymous
 *     UNAUTHORIZED) and actually disables the link.
 */

import type { Membership, TableShare } from "@gtmgrid/services";
import { TestLayer, type TestLayerFixtures } from "@gtmgrid/services";
import { describe, expect, it } from "vitest";
import { createTestContext } from "../context";
import { appRouter } from "../root";
import { createCallerFactory } from "../trpc";

const createCaller = createCallerFactory(appRouter);

const WS = "ws-1";
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
