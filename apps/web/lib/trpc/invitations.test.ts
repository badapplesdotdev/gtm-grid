/**
 * Procedure tests for the `invitations` router via `createCaller`, run OFFLINE
 * against a `TestLayer` context — NO live database, NO Autumn HTTP, NO email.
 *
 * Proves every procedure end-to-end at the tRPC boundary:
 *   - `invite` creates a pending invite for an owner and rejects a non-member
 *     with FORBIDDEN (the `workspaceProcedure` membership gate).
 *   - `list` returns pending invites for a member.
 *   - `revoke` revokes (owner) and surfaces a missing invite as NOT_FOUND.
 *   - `myPending` returns the signed-in user's invites and [] when signed out.
 *   - `getByToken` is PUBLIC — it returns a preview with NO authenticated caller.
 *   - `accept` accepts a matching invite, returns `wrong_account` on a mismatch,
 *     and rejects an unauthenticated caller with UNAUTHORIZED.
 */

import type { InMemoryUser, Invitation, Membership } from "@gtmgrid/services";
import { TestLayer, type TestLayerFixtures } from "@gtmgrid/services";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestContext } from "./context";
import { appRouter } from "./root";
import { createCallerFactory } from "./trpc";

// The accept mutation notifies the inviter out of band via `inngest.send`
// (the teammate-joined email #19). Mock the client so we can spy on WHEN it
// fires without any real queue — the router imports it as `../../inngest/client`
// (resolved from `lib/trpc/routers/`), which is this file's `../inngest/client`.
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock("../inngest/client", () => ({ inngest: { send: sendMock } }));

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue(undefined);
});

const createCaller = createCallerFactory(appRouter);

const WS_ID = "11111111-1111-1111-1111-111111111111";
const OWNER = "user_owner";
const INVITEE = "user_invitee";
const STRANGER = "user_stranger";
const INVITEE_EMAIL = "invitee@acme.com";
const TOKEN = "tok_live_0123456789abcdef";
const HOUR = 60 * 60 * 1000;

const users: readonly InMemoryUser[] = [
  { id: OWNER, name: "Olive Owner", email: "owner@acme.com" },
  { id: INVITEE, name: "Ivan Invitee", email: INVITEE_EMAIL },
  { id: STRANGER, name: "Stan Stranger", email: "stranger@acme.com" },
];
const workspaces = [{ id: WS_ID, name: "Acme", ownerId: OWNER }];
const ownerMembership: Membership = {
  workspaceId: WS_ID,
  userId: OWNER,
  role: "owner",
};
const liveInvite = (over: Partial<Invitation> = {}): Invitation => ({
  id: "inv_1",
  workspaceId: WS_ID,
  email: INVITEE_EMAIL,
  role: "member",
  token: TOKEN,
  status: "pending",
  invitedBy: OWNER,
  createdAt: Date.now() - HOUR,
  expiresAt: Date.now() + HOUR,
  acceptedBy: null,
  acceptedAt: null,
  ...over,
});

const callerFor = (fixtures: TestLayerFixtures) =>
  createCaller(
    createTestContext({
      layer: TestLayer(fixtures),
      userId: fixtures.currentUserId ?? null,
    }),
  );

describe("invitations.invite", () => {
  it("creates a pending invite for an owner", async () => {
    const caller = callerFor({
      workspaces,
      memberships: [ownerMembership],
      users,
      currentUserId: OWNER,
    });
    const res = await caller.invitations.invite({
      workspaceId: WS_ID,
      email: "new@acme.com",
      role: "member",
    });
    expect(res.status).toBe("invited");
  });

  it("rejects a non-member with FORBIDDEN", async () => {
    const caller = callerFor({
      workspaces,
      memberships: [ownerMembership],
      users,
      currentUserId: STRANGER,
    });
    await expect(
      caller.invitations.invite({
        workspaceId: WS_ID,
        email: "new@acme.com",
        role: "member",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("invitations.list / revoke", () => {
  it("lists pending invites for a member", async () => {
    const caller = callerFor({
      workspaces,
      memberships: [ownerMembership],
      users,
      currentUserId: OWNER,
      invitations: [liveInvite()],
    });
    const rows = await caller.invitations.list({ workspaceId: WS_ID });
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe(INVITEE_EMAIL);
  });

  it("revokes a pending invite for an owner", async () => {
    const caller = callerFor({
      workspaces,
      memberships: [ownerMembership],
      users,
      currentUserId: OWNER,
      invitations: [liveInvite()],
    });
    await expect(
      caller.invitations.revoke({ invitationId: "inv_1" }),
    ).resolves.toBeNull();
  });

  it("surfaces a missing invitation as NOT_FOUND", async () => {
    const caller = callerFor({
      workspaces,
      memberships: [ownerMembership],
      users,
      currentUserId: OWNER,
    });
    await expect(
      caller.invitations.revoke({ invitationId: "inv_missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("invitations.myPending", () => {
  it("returns the signed-in user's invites", async () => {
    const caller = callerFor({
      workspaces,
      memberships: [ownerMembership],
      users,
      currentUserId: INVITEE,
      invitations: [liveInvite()],
    });
    const rows = await caller.invitations.myPending();
    expect(rows).toHaveLength(1);
    expect(rows[0].workspaceName).toBe("Acme");
  });

  it("rejects an unauthenticated caller with UNAUTHORIZED", async () => {
    const caller = callerFor({
      workspaces,
      users,
      currentUserId: null,
      invitations: [liveInvite()],
    });
    await expect(caller.invitations.myPending()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("invitations.getByToken (PUBLIC)", () => {
  it("returns a preview with NO authenticated caller", async () => {
    const caller = callerFor({
      workspaces,
      users,
      currentUserId: null,
      invitations: [liveInvite()],
    });
    const preview = await caller.invitations.getByToken({ token: TOKEN });
    expect(preview.valid).toBe(true);
    if (preview.valid) {
      expect(preview.workspaceName).toBe("Acme");
      expect(preview.email).toBe(INVITEE_EMAIL);
    }
  });

  it("returns invalid for an unknown token (still no auth required)", async () => {
    const caller = callerFor({
      workspaces,
      users,
      currentUserId: null,
      invitations: [liveInvite()],
    });
    const preview = await caller.invitations.getByToken({ token: "nope" });
    expect(preview.valid).toBe(false);
  });
});

describe("invitations.accept", () => {
  it("accepts a live invite for the matching signed-in email", async () => {
    const caller = callerFor({
      workspaces,
      users,
      memberships: [ownerMembership],
      invitations: [liveInvite()],
      currentUserId: INVITEE,
      autumn: { allowed: true, balance: 5 },
    });
    const res = await caller.invitations.accept({ token: TOKEN });
    expect(res).toEqual({
      status: "accepted",
      workspaceId: WS_ID,
      // New-membership accept → surfaces the fields the teammate-joined email
      // event (#19) is keyed on.
      newMember: true,
      invitedBy: "user_owner",
    });
  });

  it("emits ONE workspace/member.joined event on a fresh accept", async () => {
    const caller = callerFor({
      workspaces,
      users,
      memberships: [ownerMembership],
      invitations: [liveInvite()],
      currentUserId: INVITEE,
      autumn: { allowed: true, balance: 5 },
    });
    await caller.invitations.accept({ token: TOKEN });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith({
      name: "workspace/member.joined",
      data: {
        workspaceId: WS_ID,
        joinedUserId: INVITEE,
        invitedBy: OWNER,
      },
    });
  });

  it("does NOT emit when the caller is ALREADY a member (re-accept stays silent)", async () => {
    const caller = callerFor({
      workspaces,
      users,
      // INVITEE is already in the workspace → acceptInsert returns alreadyMember,
      // so newMember is false and no teammate-joined email should fire.
      memberships: [ownerMembership, { workspaceId: WS_ID, userId: INVITEE, role: "member" }],
      invitations: [liveInvite()],
      currentUserId: INVITEE,
      autumn: { allowed: true, balance: 5 },
    });
    const res = await caller.invitations.accept({ token: TOKEN });
    expect(res).toMatchObject({ status: "accepted", newMember: false });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("returns wrong_account on an email mismatch", async () => {
    const caller = callerFor({
      workspaces,
      users,
      memberships: [ownerMembership],
      invitations: [liveInvite()],
      currentUserId: STRANGER,
    });
    const res = await caller.invitations.accept({ token: TOKEN });
    expect(res).toEqual({
      status: "wrong_account",
      invitedEmail: INVITEE_EMAIL,
    });
    // A non-membership outcome never emails the inviter.
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("still returns accepted when inngest.send REJECTS (Effect.ignore swallows it)", async () => {
    sendMock.mockRejectedValue(new Error("inngest queue down"));
    const caller = callerFor({
      workspaces,
      users,
      memberships: [ownerMembership],
      invitations: [liveInvite()],
      currentUserId: INVITEE,
      autumn: { allowed: true, balance: 5 },
    });
    const res = await caller.invitations.accept({ token: TOKEN });
    // The accept succeeds regardless — a queue hiccup must never fail the join.
    expect(res).toMatchObject({ status: "accepted", newMember: true });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an unauthenticated caller with UNAUTHORIZED", async () => {
    const caller = callerFor({
      workspaces,
      users,
      invitations: [liveInvite()],
      currentUserId: null,
    });
    await expect(
      caller.invitations.accept({ token: TOKEN }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
