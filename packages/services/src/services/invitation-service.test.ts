/**
 * Tests for {@link InvitationService} + {@link InvitationRepo}, run entirely
 * against the in-memory {@link TestLayer} — NO live database, NO Autumn HTTP, NO
 * outbound email.
 *
 * Mirrors the lifecycle the Convex `invite.test.ts` covered (accept happy path,
 * email mismatch -> reject, expired/revoked -> reject, seat ceiling at limit)
 * and adds the invite/list/revoke/preview paths. Each test swaps fixtures into
 * the same Test Layer and asserts OUTCOMES (the returned value or typed error
 * `_tag`), per docs/effect-conventions.md.
 */

import type { Membership } from "@gtmgrid/cloud";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import { TestLayer, type TestLayerFixtures } from "../layers.js";
import type {
  InMemoryUser,
  Invitation,
} from "../repositories/invitation-repo.js";
import type { InviteEmailArgs } from "./invite-email.js";
import { InvitationService } from "./invitation-service.js";

const WS_ID = "11111111-1111-1111-1111-111111111111";
const OWNER = "user_owner";
const INVITEE = "user_invitee";
const STRANGER = "user_stranger";

const OWNER_EMAIL = "owner@acme.com";
const INVITEE_EMAIL = "invitee@acme.com";
const LIVE_TOKEN = "tok_live_0123456789abcdef";
const HOUR = 60 * 60 * 1000;

const users: readonly InMemoryUser[] = [
  { id: OWNER, name: "Olive Owner", email: OWNER_EMAIL },
  { id: INVITEE, name: "Ivan Invitee", email: INVITEE_EMAIL },
  { id: STRANGER, name: "Stan Stranger", email: "stranger@acme.com" },
];

const workspaces = [{ id: WS_ID, name: "Acme", ownerId: OWNER }];

const ownerMembership: Membership = {
  workspaceId: WS_ID,
  userId: OWNER,
  role: "owner",
};

/** A live pending invite to INVITEE_EMAIL. */
const liveInvite = (over: Partial<Invitation> = {}): Invitation => ({
  id: "inv_1",
  workspaceId: WS_ID,
  email: INVITEE_EMAIL,
  role: "member",
  token: LIVE_TOKEN,
  status: "pending",
  invitedBy: OWNER,
  createdAt: Date.now() - HOUR,
  expiresAt: Date.now() + HOUR,
  acceptedBy: null,
  acceptedAt: null,
  ...over,
});

/** Run an InvitationService program against a Test Layer built from fixtures. */
const run = <A, E>(
  fixtures: TestLayerFixtures,
  body: (svc: InvitationService) => Effect.Effect<A, E, never>,
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const svc = yield* InvitationService;
      return yield* body(svc);
    }).pipe(Effect.provide(TestLayer(fixtures))),
  );

/** Pull the typed failure tag out of a failed exit. */
const failureTag = <A, E>(exit: Exit.Exit<A, E>): string | undefined => {
  if (Exit.isSuccess(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure)
    ? (failure.value as { _tag?: string })._tag
    : undefined;
};

describe("InvitationService.inviteByEmail", () => {
  it("creates a pending invite and sends the email for an owner", async () => {
    const emailsSent: InviteEmailArgs[] = [];
    const exit = await run(
      { workspaces, memberships: [ownerMembership], users, currentUserId: OWNER, emailsSent },
      (svc) =>
        svc.inviteByEmail({ workspaceId: WS_ID, email: " Invitee@Acme.com ", role: "member" }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit) && exit.value.status === "invited") {
      expect(exit.value.email).toBe(INVITEE_EMAIL); // normalized
      expect(exit.value.emailSent).toBe(true);
      expect(exit.value.acceptUrl).toContain("/invite/");
    } else {
      throw new Error("expected invited");
    }
    expect(emailsSent).toHaveLength(1);
    expect(emailsSent[0].to).toBe(INVITEE_EMAIL);
    expect(emailsSent[0].workspaceName).toBe("Acme");
  });

  it("rejects a non-owner/admin (member) with InsufficientRoleError", async () => {
    const exit = await run(
      {
        workspaces,
        memberships: [{ workspaceId: WS_ID, userId: INVITEE, role: "member" }],
        users,
        currentUserId: INVITEE,
      },
      (svc) =>
        svc.inviteByEmail({ workspaceId: WS_ID, email: "new@acme.com", role: "member" }),
    );
    expect(failureTag(exit)).toBe("InsufficientRoleError");
  });

  it("returns checkout (creates nothing) when over the seat limit", async () => {
    const emailsSent: InviteEmailArgs[] = [];
    const exit = await run(
      {
        workspaces,
        memberships: [ownerMembership],
        users,
        currentUserId: OWNER,
        emailsSent,
        autumn: { allowed: false, checkoutUrl: "https://billing/upgrade" },
      },
      (svc) =>
        svc.inviteByEmail({ workspaceId: WS_ID, email: "new@acme.com", role: "member" }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual({
        status: "checkout",
        checkoutUrl: "https://billing/upgrade",
      });
    }
    expect(emailsSent).toHaveLength(0);
  });

  it("returns already_member when the email already belongs to a member", async () => {
    const exit = await run(
      {
        workspaces,
        memberships: [
          ownerMembership,
          { workspaceId: WS_ID, userId: INVITEE, role: "member" },
        ],
        users,
        currentUserId: OWNER,
      },
      (svc) =>
        svc.inviteByEmail({ workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual({ status: "already_member", email: INVITEE_EMAIL });
    }
  });

  it("rejects a malformed email with InvalidEmailError", async () => {
    const exit = await run(
      { workspaces, memberships: [ownerMembership], users, currentUserId: OWNER },
      (svc) => svc.inviteByEmail({ workspaceId: WS_ID, email: "not-an-email", role: "member" }),
    );
    expect(failureTag(exit)).toBe("InvalidEmailError");
  });

  it("still succeeds (emailSent false) when delivery fails", async () => {
    const exit = await run(
      {
        workspaces,
        memberships: [ownerMembership],
        users,
        currentUserId: OWNER,
        emailDelivered: false,
      },
      (svc) =>
        svc.inviteByEmail({ workspaceId: WS_ID, email: "new@acme.com", role: "member" }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit) && exit.value.status === "invited") {
      expect(exit.value.emailSent).toBe(false);
    } else {
      throw new Error("expected invited");
    }
  });
});

describe("InvitationService.listInvitations / revokeInvitation", () => {
  it("lists pending invites (with accept URL) for a member", async () => {
    const exit = await run(
      {
        workspaces,
        memberships: [ownerMembership],
        users,
        currentUserId: OWNER,
        invitations: [liveInvite()],
      },
      (svc) => svc.listInvitations(WS_ID),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toHaveLength(1);
      expect(exit.value[0].email).toBe(INVITEE_EMAIL);
      expect(exit.value[0].acceptUrl).toContain(LIVE_TOKEN);
    }
  });

  it("rejects a non-member listing with NotAMemberError", async () => {
    const exit = await run(
      { workspaces, memberships: [ownerMembership], users, currentUserId: STRANGER },
      (svc) => svc.listInvitations(WS_ID),
    );
    expect(failureTag(exit)).toBe("NotAMemberError");
  });

  it("revokes a pending invite (owner) so it stops listing", async () => {
    const fixtures: TestLayerFixtures = {
      workspaces,
      memberships: [ownerMembership],
      users,
      currentUserId: OWNER,
      invitations: [liveInvite()],
    };
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* InvitationService;
        yield* svc.revokeInvitation("inv_1");
        return yield* svc.listInvitations(WS_ID);
      }).pipe(Effect.provide(TestLayer(fixtures))),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toHaveLength(0);
  });

  it("rejects revoke by a non-admin member with InsufficientRoleError", async () => {
    const exit = await run(
      {
        workspaces,
        memberships: [
          ownerMembership,
          { workspaceId: WS_ID, userId: INVITEE, role: "member" },
        ],
        users,
        currentUserId: INVITEE,
        invitations: [liveInvite()],
      },
      (svc) => svc.revokeInvitation("inv_1"),
    );
    expect(failureTag(exit)).toBe("InsufficientRoleError");
  });

  it("fails revoke of an unknown invitation with InvalidInvitationError", async () => {
    const exit = await run(
      { workspaces, memberships: [ownerMembership], users, currentUserId: OWNER },
      (svc) => svc.revokeInvitation("inv_missing"),
    );
    expect(failureTag(exit)).toBe("InvalidInvitationError");
  });
});

describe("InvitationService.getInvitationByToken (public preview)", () => {
  it("returns a valid preview for a live token", async () => {
    const exit = await run(
      { workspaces, users, invitations: [liveInvite()], currentUserId: null },
      (svc) => svc.getInvitationByToken(LIVE_TOKEN),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit) && exit.value.valid) {
      expect(exit.value.workspaceName).toBe("Acme");
      expect(exit.value.email).toBe(INVITEE_EMAIL);
      expect(exit.value.role).toBe("member");
    } else {
      throw new Error("expected valid preview");
    }
  });

  it("returns invalid for an unknown token", async () => {
    const exit = await run(
      { workspaces, users, invitations: [liveInvite()], currentUserId: null },
      (svc) => svc.getInvitationByToken("nope"),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.valid).toBe(false);
  });

  it("returns invalid for an expired token", async () => {
    const exit = await run(
      {
        workspaces,
        users,
        invitations: [liveInvite({ expiresAt: Date.now() - HOUR })],
        currentUserId: null,
      },
      (svc) => svc.getInvitationByToken(LIVE_TOKEN),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.valid).toBe(false);
  });
});

describe("InvitationService.myPendingInvitations", () => {
  it("returns the live invites for the signed-in user's email", async () => {
    const exit = await run(
      {
        workspaces,
        users,
        invitations: [liveInvite()],
        memberships: [ownerMembership],
        currentUserId: INVITEE,
      },
      (svc) => svc.myPendingInvitations(),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toHaveLength(1);
      expect(exit.value[0].workspaceName).toBe("Acme");
      expect(exit.value[0].invitedByName).toBe("Olive Owner");
    }
  });

  it("hides invites for a workspace the user already belongs to", async () => {
    const exit = await run(
      {
        workspaces,
        users,
        invitations: [liveInvite()],
        memberships: [{ workspaceId: WS_ID, userId: INVITEE, role: "member" }],
        currentUserId: INVITEE,
      },
      (svc) => svc.myPendingInvitations(),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toHaveLength(0);
  });

  it("returns [] when signed out", async () => {
    const exit = await run(
      { workspaces, users, invitations: [liveInvite()], currentUserId: null },
      (svc) => svc.myPendingInvitations(),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toHaveLength(0);
  });
});

describe("InvitationService.acceptInvitation", () => {
  it("accepts a live invite for the matching email (happy path) + tracks a seat", async () => {
    const trackCalls: Array<{ customerId: string; value: number }> = [];
    const fixtures: TestLayerFixtures = {
      workspaces,
      users,
      invitations: [liveInvite()],
      memberships: [ownerMembership],
      currentUserId: INVITEE,
      autumn: { allowed: true, balance: 5, trackCalls },
    };
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* InvitationService;
        const result = yield* svc.acceptInvitation(LIVE_TOKEN);
        // The invite is now consumed (no longer pending) — re-listing as owner.
        return result;
      }).pipe(Effect.provide(TestLayer(fixtures))),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual({
        status: "accepted",
        workspaceId: WS_ID,
        // New-membership accept → drives the teammate-joined email (#19).
        newMember: true,
        invitedBy: OWNER,
      });
    }
    expect(trackCalls).toEqual([{ customerId: WS_ID, value: 1 }]);
  });

  it("rejects acceptance when the signed-in email does not match the invite", async () => {
    const exit = await run(
      {
        workspaces,
        users,
        invitations: [liveInvite()],
        memberships: [ownerMembership],
        currentUserId: STRANGER,
      },
      (svc) => svc.acceptInvitation(LIVE_TOKEN),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual({
        status: "wrong_account",
        invitedEmail: INVITEE_EMAIL,
      });
    }
  });

  it("returns invalid for an expired invite", async () => {
    const exit = await run(
      {
        workspaces,
        users,
        invitations: [liveInvite({ expiresAt: Date.now() - HOUR })],
        memberships: [ownerMembership],
        currentUserId: INVITEE,
      },
      (svc) => svc.acceptInvitation(LIVE_TOKEN),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.status).toBe("invalid");
  });

  it("returns invalid for a revoked invite", async () => {
    const exit = await run(
      {
        workspaces,
        users,
        invitations: [liveInvite({ status: "revoked" })],
        memberships: [ownerMembership],
        currentUserId: INVITEE,
      },
      (svc) => svc.acceptInvitation(LIVE_TOKEN),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.status).toBe("invalid");
  });

  it("returns seat_limit (no member added) when the Autumn check denies", async () => {
    const trackCalls: Array<{ customerId: string; value: number }> = [];
    const exit = await run(
      {
        workspaces,
        users,
        invitations: [liveInvite()],
        memberships: [ownerMembership],
        currentUserId: INVITEE,
        autumn: { allowed: false, checkoutUrl: "https://billing/upgrade", trackCalls },
      },
      (svc) => svc.acceptInvitation(LIVE_TOKEN),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual({
        status: "seat_limit",
        checkoutUrl: "https://billing/upgrade",
      });
    }
    expect(trackCalls).toHaveLength(0);
  });

  it("enforces the transactional seat ceiling AT the limit (balance 0)", async () => {
    // Autumn allows but reports 0 free seats -> ceiling = currentCount + 0 =
    // currentCount, so the live count (1 owner) is already AT the ceiling and the
    // transactional insert must fail with SeatLimitExceededError.
    const exit = await run(
      {
        workspaces,
        users,
        invitations: [liveInvite()],
        memberships: [ownerMembership],
        currentUserId: INVITEE,
        autumn: { allowed: true, balance: 0 },
      },
      (svc) => svc.acceptInvitation(LIVE_TOKEN),
    );
    expect(failureTag(exit)).toBe("SeatLimitExceededError");
  });

  it("rejects acceptance when signed out with UnauthenticatedError", async () => {
    const exit = await run(
      {
        workspaces,
        users,
        invitations: [liveInvite()],
        memberships: [ownerMembership],
        currentUserId: null,
      },
      (svc) => svc.acceptInvitation(LIVE_TOKEN),
    );
    expect(failureTag(exit)).toBe("UnauthenticatedError");
  });
});
