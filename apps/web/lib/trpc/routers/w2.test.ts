/**
 * Procedure tests for the W2 `workspaces` + `billing` routers via `createCaller`,
 * run OFFLINE against a `TestLayer` context (no live DB, no Autumn SDK).
 *
 * Proves the AC end-to-end at the procedure level:
 *   - `workspaces.me` returns the exact desktop `useMe` shape for a signed-in
 *     caller and `null` when signed out.
 *   - `workspaces.listMembers` returns the roster for a member and FORBIDs a
 *     non-member.
 *   - `workspaces.createWorkspace` creates a workspace + owner membership.
 *   - `billing.checkout` returns the Autumn URL for an owner, FORBIDs a member,
 *     and maps an unknown plan to BAD_REQUEST.
 */

import type { Membership } from "@gtmgrid/services";
import { TestLayer, type TestLayerFixtures } from "@gtmgrid/services";
import type { MemberWithUser, Workspace, WorkspaceUser } from "@gtmgrid/services";
import { describe, expect, it } from "vitest";
import { createTestContext } from "../context";
import { appRouter } from "../root";
import { createCallerFactory } from "../trpc";

const createCaller = createCallerFactory(appRouter);

const WS_ID = "11111111-1111-1111-1111-111111111111";

const callerFor = (fixtures: TestLayerFixtures) =>
  createCaller(
    createTestContext({
      layer: TestLayer(fixtures),
      userId: fixtures.currentUserId ?? null,
    }),
  );

const users: readonly WorkspaceUser[] = [
  { id: "user_owner", name: "Olive", email: "olive@example.com", image: null },
];
const workspaces: readonly Workspace[] = [
  {
    id: WS_ID,
    name: "Alpha",
    ownerId: "user_owner",
    cloudActionsUsed: 7,
    cloudActionsLimit: 2000,
    currentPlanId: "team",
  },
];
const members: readonly MemberWithUser[] = [
  {
    id: "m1",
    workspaceId: WS_ID,
    userId: "user_owner",
    role: "owner",
    createdAt: 1,
    name: "Olive",
    email: "olive@example.com",
    image: null,
  },
];
const ownerMembership: readonly Membership[] = [
  { workspaceId: WS_ID, userId: "user_owner", role: "owner" },
];

describe("workspaces.me", () => {
  it("returns the desktop useMe shape for a signed-in caller", async () => {
    const caller = callerFor({
      users,
      workspaces,
      members,
      memberships: ownerMembership,
      currentUserId: "user_owner",
    });
    const me = await caller.workspaces.me();
    expect(me).toEqual({
      user: {
        _id: "user_owner",
        name: "Olive",
        email: "olive@example.com",
        image: null,
      },
      workspaces: [
        {
          _id: WS_ID,
          name: "Alpha",
          role: "owner",
          seatUsage: { used: 1, limit: null },
          cloudActions: { used: 7, limit: 2000 },
          plan: { id: "team", name: "Team", trialEndsAt: null },
          selfHost: false,
        },
      ],
    });
  });

  it("returns null when signed out (mirrors the Convex `me`)", async () => {
    const caller = callerFor({ currentUserId: null });
    await expect(caller.workspaces.me()).resolves.toBeNull();
  });
});

describe("workspaces.listMembers", () => {
  it("returns the roster for a member", async () => {
    const caller = callerFor({
      users,
      workspaces,
      members,
      memberships: ownerMembership,
      currentUserId: "user_owner",
    });
    const result = await caller.workspaces.listMembers({ workspaceId: WS_ID });
    expect(result.members).toHaveLength(1);
    expect(result.seatUsage).toEqual({ used: 1, limit: null });
  });

  it("FORBIDs a non-member", async () => {
    const caller = callerFor({
      users,
      workspaces,
      members,
      memberships: ownerMembership,
      currentUserId: "user_stranger",
    });
    await expect(
      caller.workspaces.listMembers({ workspaceId: WS_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("workspaces.createWorkspace", () => {
  it("creates a workspace and its owner membership", async () => {
    const caller = callerFor({ currentUserId: "user_new" });
    const id = await caller.workspaces.createWorkspace({ name: "Fresh" });
    expect(typeof id).toBe("string");
    // The creator can immediately list the roster (membership exists).
    const roster = await caller.workspaces.listMembers({ workspaceId: id });
    expect(roster.members[0]).toMatchObject({
      userId: "user_new",
      role: "owner",
    });
  });

  it("rejects an unauthenticated caller with UNAUTHORIZED", async () => {
    const caller = callerFor({ currentUserId: null });
    await expect(
      caller.workspaces.createWorkspace({ name: "Nope" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("billing.checkout", () => {
  it("returns the Autumn URL for an owner on a valid plan", async () => {
    const caller = callerFor({
      users,
      workspaces,
      members,
      memberships: ownerMembership,
      currentUserId: "user_owner",
      autumn: { checkoutUrl: "https://billing.example.com/up/1" },
    });
    const result = await caller.billing.checkout({
      workspaceId: WS_ID,
      planId: "team",
    });
    expect(result).toEqual({ checkoutUrl: "https://billing.example.com/up/1" });
  });

  it("FORBIDs a non-owner/admin", async () => {
    const caller = callerFor({
      users,
      workspaces,
      members: [
        {
          id: "m_mem",
          workspaceId: WS_ID,
          userId: "user_member",
          role: "member",
          createdAt: 1,
          name: null,
          email: null,
          image: null,
        },
      ],
      memberships: [
        { workspaceId: WS_ID, userId: "user_member", role: "member" },
      ],
      currentUserId: "user_member",
    });
    await expect(
      caller.billing.checkout({ workspaceId: WS_ID, planId: "team" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("maps an unknown plan to BAD_REQUEST", async () => {
    const caller = callerFor({
      users,
      workspaces,
      members,
      memberships: ownerMembership,
      currentUserId: "user_owner",
    });
    await expect(
      caller.billing.checkout({ workspaceId: WS_ID, planId: "forged" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("billing.syncPlan", () => {
  it("returns the live Autumn plan for a member", async () => {
    const caller = callerFor({
      users,
      workspaces,
      members,
      memberships: ownerMembership,
      currentUserId: "user_owner",
      autumn: { activePlanIds: ["business"] },
    });
    const result = await caller.billing.syncPlan({ workspaceId: WS_ID });
    expect(result).toEqual({ id: "business", name: "Business", trialEndsAt: null });
  });

  it("resolves to Free when Autumn has no active paid plan", async () => {
    const caller = callerFor({
      users,
      workspaces,
      members,
      memberships: ownerMembership,
      currentUserId: "user_owner",
      autumn: { activePlanIds: ["free"] },
    });
    const result = await caller.billing.syncPlan({ workspaceId: WS_ID });
    expect(result).toEqual({ id: null, name: "Free", trialEndsAt: null });
  });

  it("rejects a non-member with FORBIDDEN", async () => {
    const caller = callerFor({
      users,
      workspaces,
      members: [],
      memberships: [],
      currentUserId: "user_stranger",
      autumn: { activePlanIds: ["team"] },
    });
    await expect(
      caller.billing.syncPlan({ workspaceId: WS_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("billing.previewSeatChange", () => {
  it("previews the bill for current members + 1 seat", async () => {
    const caller = callerFor({
      users,
      workspaces,
      members, // one member
      memberships: ownerMembership,
      currentUserId: "user_owner",
      autumn: { perSeatPrice: 20 },
    });
    const result = await caller.billing.previewSeatChange({ workspaceId: WS_ID });
    // 1 existing member + 1 new seat = 2 × $20 = $40.
    expect(result).toEqual({ seats: 2, total: 40, currency: "usd" });
  });

  it("rejects a non-member with FORBIDDEN", async () => {
    const caller = callerFor({
      users,
      workspaces,
      members: [],
      memberships: [],
      currentUserId: "user_stranger",
      autumn: { perSeatPrice: 20 },
    });
    await expect(
      caller.billing.previewSeatChange({ workspaceId: WS_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
