/**
 * `InvitationService` — the workspace-invitation domain service.
 *
 * The Postgres/tRPC port of `convex/invitations.ts`, collapsing the Convex
 * action/mutation splits (`inviteByEmail`+`createInvitation`,
 * `acceptInvitation`+`acceptInvitationInsert`+`currentUserForAccept`) into single
 * service methods. It composes:
 *
 *   - {@link InvitationRepo} — the Effect <-> Drizzle adapter (data + the
 *     transactional accept-insert).
 *   - {@link MembershipService} (@gtmgrid/cloud) — the reused authz core for the
 *     owner/admin gate on invite/revoke.
 *   - {@link SeatsService} (@gtmgrid/cloud) — the Autumn seat check, INJECTED as a
 *     port (its {@link AutumnClient} dependency is the seam swapped for a fake in
 *     tests), used to seat-gate invites AND derive the accept-time ceiling.
 *   - {@link Identity} (@gtmgrid/cloud) — the signed-in caller, for the
 *     email-match accept gate + `myPendingInvitations`.
 *   - {@link InviteEmailPort} — the `@gtmgrid/email` `inviteEmail` send seam,
 *     injected so tests assert the email without sending one.
 *
 * Seats are consumed at ACCEPT time and re-enforced inside the repo's accept
 * transaction, so pending invites can never silently overshoot the plan — the
 * exact discipline of the Convex original.
 */

import {
  type AutumnError,
  Identity,
  type InsufficientRoleError,
  MembershipService,
  type MemberRepoError,
  type MemberRole,
  type NoCheckoutUrlError,
  type NotAMemberError,
  type SeatLimitExceededError,
  SeatsService,
  UnauthenticatedError,
} from "@gtmgrid/cloud";
import { Data, Effect, Option } from "effect";
import {
  InvalidInvitationError,
  InvitationRepo,
  type InvitationRepoError,
} from "../repositories/invitation-repo.js";
import { InviteEmailPort } from "./invite-email.js";

/** Pending invites are valid for 7 days. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Normalize an email for storage + comparison (trim + lowercase). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Mint a high-entropy URL-safe accept token (32 random bytes -> hex) via Web
 * Crypto. Ported verbatim from `mintToken` (convex/invitations.ts:52);
 * `globalThis.crypto` is available in both the Edge/Node Next runtime and tests.
 */
export function mintToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the accept link for a token. `INVITE_BASE_URL` if set, else `SITE_URL`;
 * with neither, the desktop deep-link scheme. Ported from `acceptUrlFor`
 * (convex/invitations.ts:66).
 */
export function acceptUrlFor(token: string): string {
  const base = process.env.INVITE_BASE_URL ?? process.env.SITE_URL;
  if (base) return `${base.replace(/\/$/, "")}/invite/${token}`;
  return `gtmgrid://invite/${token}`;
}

/**
 * Raised when an invite asks for a role invitations cannot grant — today that is
 * `owner`, because ownership is single-holder and moves only by transferring it
 * to an existing member ({@link WorkspaceService.updateMemberRole}).
 */
export class InvalidInviteRoleError extends Data.TaggedError(
  "InvalidInviteRoleError",
)<{
  readonly message: string;
  readonly role: MemberRole;
}> {}

/** Raised when `inviteByEmail` is given a syntactically invalid email. */
export class InvalidEmailError extends Data.TaggedError("InvalidEmailError")<{
  readonly message: string;
}> {}

/** The result of {@link InvitationService.inviteByEmail}. */
export type InviteByEmailResult =
  | { status: "invited"; email: string; acceptUrl: string; emailSent: boolean }
  | { status: "already_member"; email: string }
  | { status: "checkout"; checkoutUrl: string };

/** A pending invitation as shown in the workspace settings list. */
export interface PendingInvitationView {
  readonly id: string;
  readonly email: string;
  readonly role: MemberRole;
  readonly status: "pending";
  readonly token: string;
  readonly acceptUrl: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** An invitation waiting for the signed-in user (the in-app banner). */
export interface MyPendingInvitationView {
  readonly id: string;
  readonly token: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly role: MemberRole;
  readonly invitedByName: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** The public preview of a token for the accept screen / web landing. */
export type InvitationPreview =
  | { valid: false }
  | {
      valid: true;
      workspaceName: string;
      email: string;
      role: MemberRole;
      invitedByName: string | null;
    };

/** The result of {@link InvitationService.acceptInvitation}. */
export type AcceptResult =
  | {
      status: "accepted";
      workspaceId: string;
      /** True when this accept INSERTED a membership (vs. already a member). */
      newMember: boolean;
      /** Better Auth user id of the inviter (drives the teammate-joined email). */
      invitedBy: string;
    }
  | { status: "wrong_account"; invitedEmail: string }
  | { status: "invalid" }
  | { status: "seat_limit"; checkoutUrl: string };

/**
 * Workspace-invitation domain service. Composes the invitation repo + the reused
 * authz / seats / identity / email seams into the full invite -> accept flow.
 */
export class InvitationService extends Effect.Service<InvitationService>()(
  "InvitationService",
  {
    effect: Effect.gen(function* () {
      const repo = yield* InvitationRepo;
      const membership = yield* MembershipService;
      const seats = yield* SeatsService;
      const identity = yield* Identity;
      const email = yield* InviteEmailPort;

      /**
       * Invite a user to a workspace by email (owner/admin only). Over the seat
       * limit -> returns the Autumn checkout URL and creates no invite. Existing
       * member -> `already_member`. Otherwise upserts a pending invite and emails
       * the accept link (best-effort). Collapses the Convex action + mutation.
       */
      const inviteByEmail = (params: {
        readonly workspaceId: string;
        readonly email: string;
        readonly role: MemberRole;
      }): Effect.Effect<
        InviteByEmailResult,
        | UnauthenticatedError
        | NotAMemberError
        | InsufficientRoleError
        | MemberRepoError
        | InvitationRepoError
        | InvalidEmailError
        | InvalidInviteRoleError
        | AutumnError
        | NoCheckoutUrlError
      > =>
        Effect.gen(function* () {
          // An invite may only grant a role the inviter is entitled to hand out,
          // or the invite becomes a way around the owner-only rule on
          // `WorkspaceService.updateMemberRole`: an admin would mint fellow
          // admins by invitation, and anyone could mint a SECOND owner —
          // ownership is single-holder and moves only by transfer, so no invite
          // ever carries it.
          const inviter = yield* membership.requireRole(
            params.workspaceId,
            params.role === "member" ? ["owner", "admin"] : ["owner"],
          );
          if (params.role === "owner") {
            return yield* Effect.fail(
              new InvalidInviteRoleError({
                message:
                  "Ownership can't be granted by invitation. Invite them as an " +
                  "admin, then make them the owner once they've joined.",
                role: params.role,
              }),
            );
          }
          const normalized = normalizeEmail(params.email);
          if (!normalized.includes("@")) {
            return yield* Effect.fail(
              new InvalidEmailError({
                message: "Enter a valid email address.",
              }),
            );
          }

          // Seat gate (Autumn). Over the limit -> checkout, create nothing.
          const customerData = yield* repo.workspaceCustomerData(
            params.workspaceId,
          );
          const seat = yield* seats.checkInvite(
            params.workspaceId,
            undefined,
            customerData,
          );
          if (!seat.allowed) {
            return { status: "checkout", checkoutUrl: seat.checkoutUrl };
          }

          // Already a member of this workspace (resolved by email)?
          const isMember = yield* repo.emailIsMember(
            params.workspaceId,
            normalized,
          );
          if (isMember) {
            return { status: "already_member", email: normalized };
          }

          const now = Date.now();
          const created = yield* repo.upsertPending({
            workspaceId: params.workspaceId,
            email: normalized,
            role: params.role,
            token: mintToken(),
            invitedBy: inviter.userId,
            createdAt: now,
            expiresAt: now + INVITE_TTL_MS,
          });

          const acceptUrl = acceptUrlFor(created.token);
          const workspaceName =
            customerData.name ??
            (yield* repo.workspaceName(params.workspaceId)) ??
            "a workspace";
          const inviterInfo = yield* repo.userInfo(inviter.userId);
          // Best-effort send: a delivery failure must NOT fail the invite (the
          // row exists and the link is returned for copying).
          const emailSent = yield* email.send({
            to: normalized,
            workspaceName,
            inviterName: inviterInfo.name,
            inviterEmail: inviterInfo.email,
            acceptUrl,
          });

          return { status: "invited", email: normalized, acceptUrl, emailSent };
        });

      /**
       * Pending invitations for a workspace (any member may view). Returns the
       * token + accept URL so the inviter can copy the link.
       */
      const listInvitations = (
        workspaceId: string,
      ): Effect.Effect<
        readonly PendingInvitationView[],
        | UnauthenticatedError
        | NotAMemberError
        | MemberRepoError
        | InvitationRepoError
      > =>
        Effect.gen(function* () {
          yield* membership.requireMember(workspaceId);
          const rows = yield* repo.listPendingByWorkspace(workspaceId);
          return rows.map((r) => ({
            id: r.id,
            email: r.email,
            role: r.role,
            status: "pending" as const,
            token: r.token,
            acceptUrl: acceptUrlFor(r.token),
            createdAt: r.createdAt,
            expiresAt: r.expiresAt,
          }));
        });

      /** Revoke a pending invitation (owner/admin). The token stops working. */
      const revokeInvitation = (
        invitationId: string,
      ): Effect.Effect<
        void,
        | UnauthenticatedError
        | NotAMemberError
        | InsufficientRoleError
        | MemberRepoError
        | InvitationRepoError
        | InvalidInvitationError
      > =>
        Effect.gen(function* () {
          const inv = yield* repo.findById(invitationId);
          if (inv._tag === "None") {
            return yield* Effect.fail(
              new InvalidInvitationError({ message: "Invitation not found." }),
            );
          }
          yield* membership.requireRole(inv.value.workspaceId, [
            "owner",
            "admin",
          ]);
          yield* repo.revoke(invitationId);
        });

      /**
       * Invitations waiting for the SIGNED-IN user (matched on their email),
       * excluding workspaces they already belong to. Returns `[]` when signed
       * out / no email — drives the in-app "you've been invited" banner.
       */
      const myPendingInvitations = (): Effect.Effect<
        readonly MyPendingInvitationView[],
        InvitationRepoError
      > =>
        Effect.gen(function* () {
          const maybeUserId = yield* identity.currentUserId;
          if (Option.isNone(maybeUserId)) return [];
          const userId = maybeUserId.value;
          const self = yield* repo.userInfo(userId);
          if (self.email === null) return [];
          const myEmail = normalizeEmail(self.email);

          const now = Date.now();
          const rows = (yield* repo.listPendingByEmail(myEmail)).filter(
            (r) => r.expiresAt > now,
          );

          const results: MyPendingInvitationView[] = [];
          for (const r of rows) {
            const member = yield* repo.findMembership(r.workspaceId, userId);
            if (Option.isSome(member)) continue;
            const wsName = yield* repo.workspaceName(r.workspaceId);
            if (wsName === null) continue;
            const inviter = yield* repo.userInfo(r.invitedBy);
            results.push({
              id: r.id,
              token: r.token,
              workspaceId: r.workspaceId,
              workspaceName: wsName,
              role: r.role,
              invitedByName: inviter.name ?? inviter.email,
              createdAt: r.createdAt,
              expiresAt: r.expiresAt,
            });
          }
          return results;
        });

      /**
       * Public preview of an invite token (no auth — the token is the
       * capability). Returns `{ valid: false }` for an unknown / non-pending /
       * expired token (no detail leaked).
       */
      const getInvitationByToken = (
        token: string,
      ): Effect.Effect<InvitationPreview, InvitationRepoError> =>
        Effect.gen(function* () {
          const maybe = yield* repo.findByToken(token);
          if (Option.isNone(maybe)) return { valid: false };
          const inv = maybe.value;
          if (inv.status !== "pending" || inv.expiresAt <= Date.now()) {
            return { valid: false };
          }
          const wsName = yield* repo.workspaceName(inv.workspaceId);
          const inviter = yield* repo.userInfo(inv.invitedBy);
          return {
            valid: true,
            workspaceName: wsName ?? "a workspace",
            email: inv.email,
            role: inv.role,
            invitedByName: inviter.name ?? inviter.email,
          };
        });

      /**
       * Accept a pending invitation as the SIGNED-IN user. Validates the token is
       * live and was issued to the caller's email, re-checks seats, then inserts
       * the membership transactionally (the repo re-enforces the ceiling) and
       * marks the invite accepted. Mismatched email -> `wrong_account`; over the
       * limit -> `seat_limit`. Collapses the Convex action + insert mutation.
       */
      const acceptInvitation = (
        token: string,
      ): Effect.Effect<
        AcceptResult,
        | UnauthenticatedError
        | InvitationRepoError
        | InvalidInvitationError
        | AutumnError
        | NoCheckoutUrlError
        | SeatLimitExceededError
      > =>
        Effect.gen(function* () {
          const maybeUserId = yield* identity.currentUserId;
          if (Option.isNone(maybeUserId)) {
            return yield* Effect.fail(
              new UnauthenticatedError({
                message: "Sign in to accept an invitation.",
              }),
            );
          }
          const userId = maybeUserId.value;
          const self = yield* repo.userInfo(userId);
          if (self.email === null) return { status: "invalid" };
          const myEmail = normalizeEmail(self.email);

          const maybeInv = yield* repo.findByToken(token);
          if (Option.isNone(maybeInv)) return { status: "invalid" };
          const inv = maybeInv.value;
          if (inv.status !== "pending" || inv.expiresAt <= Date.now()) {
            return { status: "invalid" };
          }
          if (inv.email !== myEmail) {
            return { status: "wrong_account", invitedEmail: inv.email };
          }

          // Seat gate at accept time -> absolute ceiling the tx re-checks.
          const customerData = yield* repo.workspaceCustomerData(
            inv.workspaceId,
          );
          const seat = yield* seats.checkInvite(
            inv.workspaceId,
            undefined,
            customerData,
          );
          if (!seat.allowed) {
            return { status: "seat_limit", checkoutUrl: seat.checkoutUrl };
          }

          // Turn the free-seat balance into an absolute member CEILING the repo
          // transaction re-verifies against the live count (closing the
          // check-then-insert race). `null` balance = unlimited.
          const currentCount = yield* repo.countMembers(inv.workspaceId);
          const seatCeiling =
            seat.balance === null ? null : currentCount + seat.balance;

          const result = yield* repo.acceptInsert({
            invitationId: inv.id,
            userId,
            email: myEmail,
            seatCeiling,
            now: Date.now(),
          });

          // Count one seat only when a NEW membership was actually inserted.
          if (!result.alreadyMember) {
            yield* seats.trackSeatUsed(inv.workspaceId);
          }
          return {
            status: "accepted",
            workspaceId: result.workspaceId,
            newMember: !result.alreadyMember,
            invitedBy: inv.invitedBy,
          };
        });

      return {
        inviteByEmail,
        listInvitations,
        revokeInvitation,
        myPendingInvitations,
        getInvitationByToken,
        acceptInvitation,
      } as const;
    }),
    dependencies: [],
  },
) {}
