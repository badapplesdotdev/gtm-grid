/**
 * Workspace invitations — invite by EMAIL, accept into a membership.
 *
 * The legacy `inviteMember` action (convex/workspaces.ts) adds a user by their
 * internal Convex id — unusable as a real product flow. This module replaces it
 * with an email-first flow:
 *
 *   1. An owner/admin calls {@link inviteByEmail}. Gated on Autumn seats: over
 *      the limit returns a checkout URL (adds nobody). Otherwise it creates a
 *      PENDING `invitations` row (token + email) and emails the invitee an accept
 *      link (best-effort: the link is also returned so the UI can show a copyable
 *      fallback even when email isn't configured).
 *   2. The invitee signs in with the SAME email and either clicks the link or
 *      sees the in-app "waiting for you" banner ({@link myPendingInvitations}),
 *      then calls {@link acceptInvitation}. Accepting re-checks seats, inserts the
 *      membership transactionally (the gate is "you hold a valid invite for your
 *      own email", so no prior membership/role is required), tracks one seat, and
 *      marks the invite accepted.
 *
 * Seats are consumed at ACCEPT time (not invite time), and re-enforced inside the
 * insert transaction, so pending invites can never silently overshoot the plan.
 */

import { ConvexError, v } from "convex/values";
import { inviteEmail, sendEmail } from "./email.js";
import { getCurrentUser, requireMember, requireRole } from "./model/auth.js";
import {
  checkInviteSeat,
  enforceSeatCeiling,
  trackSeatUsed,
} from "./model/seats.js";
import { memberRole } from "./schema.js";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";

/** Pending invites are valid for 7 days. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Normalize an email for storage + comparison (trim + lowercase). */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Mint a high-entropy URL-safe accept token (32 random bytes → hex). */
function mintToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the accept link for an invite token. Points at the WEB app that serves
 * the `/invite/<token>` landing page (apps/web): `INVITE_BASE_URL` if set, else
 * `SITE_URL`. `INVITE_BASE_URL` exists because `SITE_URL` doubles as the OAuth
 * redirect origin (the desktop web build, e.g. localhost:5173) which is NOT where
 * the invite landing page lives (apps/web, e.g. localhost:3000 / gtmgrid.dev).
 * With neither set, falls back to the desktop deep-link scheme.
 */
function acceptUrlFor(token: string): string {
  const base = process.env.INVITE_BASE_URL ?? process.env.SITE_URL;
  if (base) return `${base.replace(/\/$/, "")}/invite/${token}`;
  return `gtmgrid://invite/${token}`;
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * The pending invitations for a workspace (settings UI). Reactive so a new
 * invite or a revoke appears live. Authz: any member may view the pending list;
 * revoking requires owner/admin. Returns the token so the inviter can copy the
 * accept link.
 */
export const listInvitations = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    await requireMember(ctx, workspaceId);
    const rows = await ctx.db
      .query("invitations")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    const pending = rows
      .filter((r) => r.status === "pending")
      .sort((a, b) => b.createdAt - a.createdAt);
    return pending.map((r) => ({
      _id: r._id,
      email: r.email,
      role: r.role,
      status: r.status,
      token: r.token,
      acceptUrl: acceptUrlFor(r.token),
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
    }));
  },
});

/**
 * Invitations waiting for the SIGNED-IN user (matched on their email), excluding
 * workspaces they already belong to. Drives the in-app "you've been invited"
 * banner so acceptance needs no link. Returns `[]` when signed out / no email.
 */
export const myPendingInvitations = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (user === null || !user.email) return [];
    const email = normalizeEmail(user.email);

    const rows = await ctx.db
      .query("invitations")
      .withIndex("by_email", (q) => q.eq("email", email))
      .collect();
    const now = Date.now();
    const live = rows.filter(
      (r) => r.status === "pending" && r.expiresAt > now,
    );

    const results = await Promise.all(
      live.map(async (r) => {
        // Skip if the user is already a member of this workspace.
        const member = await ctx.db
          .query("members")
          .withIndex("by_workspace_user", (q) =>
            q.eq("workspaceId", r.workspaceId).eq("userId", user._id),
          )
          .first();
        if (member !== null) return null;
        const ws = await ctx.db.get(r.workspaceId);
        if (ws === null) return null;
        const inviter = ctx.db.normalizeId("users", r.invitedBy);
        const inviterDoc = inviter === null ? null : await ctx.db.get(inviter);
        return {
          _id: r._id,
          token: r.token,
          workspaceId: r.workspaceId,
          workspaceName: ws.name,
          role: r.role,
          invitedByName: inviterDoc?.name ?? inviterDoc?.email ?? null,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
        };
      }),
    );
    return results.filter((r) => r !== null);
  },
});

/**
 * Public preview of an invite token for the accept screen / web landing: the
 * workspace name, invited email, role and inviter. Returns `{ valid: false }`
 * for an unknown / non-pending / expired token (no detail leaked). No auth
 * required — the token IS the capability.
 */
export const getInvitationByToken = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const inv = await ctx.db
      .query("invitations")
      .withIndex("by_token", (q) => q.eq("token", token))
      .first();
    if (inv === null || inv.status !== "pending" || inv.expiresAt <= Date.now()) {
      return { valid: false as const };
    }
    const ws = await ctx.db.get(inv.workspaceId);
    const inviter = ctx.db.normalizeId("users", inv.invitedBy);
    const inviterDoc = inviter === null ? null : await ctx.db.get(inviter);
    return {
      valid: true as const,
      workspaceName: ws?.name ?? "a workspace",
      email: inv.email,
      role: inv.role,
      invitedByName: inviterDoc?.name ?? inviterDoc?.email ?? null,
    };
  },
});

// ─── Invite (owner/admin) ──────────────────────────────────────────────────

/** The result of {@link inviteByEmail}. */
type InviteByEmailResult =
  | { status: "invited"; email: string; acceptUrl: string; emailSent: boolean }
  | { status: "already_member"; email: string }
  | { status: "checkout"; checkoutUrl: string };

/**
 * Invite a user to a workspace by email. ACTION (the seat check + email send are
 * outbound HTTP that mutations can't do). Over the seat limit → returns the
 * Autumn checkout URL and creates no invite. Otherwise upserts a pending invite
 * and emails the accept link (best-effort).
 */
export const inviteByEmail = action({
  args: {
    workspaceId: v.id("workspaces"),
    email: v.string(),
    role: memberRole,
  },
  handler: async (
    ctx,
    { workspaceId, email, role },
  ): Promise<InviteByEmailResult> => {
    const normalized = normalizeEmail(email);
    if (!normalized.includes("@")) {
      throw new ConvexError({
        code: "InvalidEmail",
        message: "Enter a valid email address.",
      });
    }

    // Customer profile for Autumn getOrCreate (name + owner email).
    const customerData = await ctx.runQuery(
      internal.workspaces.workspaceCustomerData,
      { workspaceId },
    );

    // Seat gate. Over the limit → checkout, create nothing.
    const seat = await checkInviteSeat(workspaceId, undefined, customerData);
    if (!seat.allowed) {
      return { status: "checkout", checkoutUrl: seat.checkoutUrl };
    }

    // Create / refresh the pending invite (authz + dedupe live in the mutation).
    const created = await ctx.runMutation(
      internal.invitations.createInvitation,
      { workspaceId, email: normalized, role },
    );
    if (created.status === "already_member") {
      return { status: "already_member", email: normalized };
    }

    // Email the accept link (best-effort: a Resend failure / no key must not
    // fail the invite — the row exists and the link is returned for copying).
    const acceptUrl = acceptUrlFor(created.token);
    let emailSent = false;
    try {
      await sendEmail(
        inviteEmail({
          to: normalized,
          workspaceName: created.workspaceName,
          inviterName: created.inviterName,
          inviterEmail: created.inviterEmail,
          acceptUrl,
        }),
      );
      emailSent = true;
    } catch (e) {
      console.error("[invitations] invite email failed:", e);
    }

    return { status: "invited", email: normalized, acceptUrl, emailSent };
  },
});

/**
 * Create or refresh a pending invitation. Internal: only {@link inviteByEmail}
 * calls it, AFTER the seat gate. Enforces owner/admin authz and dedupes:
 *   - the email already belongs to a member → `{ status: "already_member" }`
 *   - a pending invite already exists → refresh its token/role/expiry
 *   - otherwise insert a new pending invite
 */
export const createInvitation = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    email: v.string(),
    role: memberRole,
  },
  handler: async (
    ctx,
    { workspaceId, email, role },
  ): Promise<
    | { status: "already_member" }
    | {
        status: "invited";
        invitationId: Id<"invitations">;
        token: string;
        workspaceName: string;
        inviterName: string | null;
        inviterEmail: string | null;
      }
  > => {
    const inviter = await requireRole(ctx, workspaceId, ["owner", "admin"]);

    // Already a member? Resolve the email → user → membership.
    const existingUser = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .first();
    if (existingUser !== null) {
      const member = await ctx.db
        .query("members")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", workspaceId).eq("userId", existingUser._id),
        )
        .first();
      if (member !== null) return { status: "already_member" };
    }

    const ws = await ctx.db.get(workspaceId);
    const workspaceName = ws?.name ?? "a workspace";
    const inviterDoc = await ctx.db.get(inviter.userId as Id<"users">);
    const inviterName = inviterDoc?.name ?? inviterDoc?.email ?? null;
    const inviterEmail = inviterDoc?.email ?? null;

    const now = Date.now();
    const token = mintToken();
    const expiresAt = now + INVITE_TTL_MS;

    // Refresh an existing pending invite for the same (workspace, email).
    const existing = await ctx.db
      .query("invitations")
      .withIndex("by_workspace_email", (q) =>
        q.eq("workspaceId", workspaceId).eq("email", email),
      )
      .collect();
    const pending = existing.find((i) => i.status === "pending") ?? null;
    if (pending !== null) {
      await ctx.db.patch(pending._id, {
        role,
        token,
        expiresAt,
        invitedBy: inviter.userId,
        createdAt: now,
      });
      return {
        status: "invited",
        invitationId: pending._id,
        token,
        workspaceName,
        inviterName,
        inviterEmail,
      };
    }

    const invitationId = await ctx.db.insert("invitations", {
      workspaceId,
      email,
      role,
      token,
      status: "pending",
      invitedBy: inviter.userId,
      createdAt: now,
      expiresAt,
    });
    return {
      status: "invited",
      invitationId,
      token,
      workspaceName,
      inviterName,
      inviterEmail,
    };
  },
});

/** Revoke a pending invitation (owner/admin). The token stops working. */
export const revokeInvitation = mutation({
  args: { invitationId: v.id("invitations") },
  handler: async (ctx, { invitationId }) => {
    const inv = await ctx.db.get(invitationId);
    if (inv === null) {
      throw new ConvexError({
        code: "NotFound",
        message: "Invitation not found.",
      });
    }
    await requireRole(ctx, inv.workspaceId, ["owner", "admin"]);
    if (inv.status === "pending") {
      await ctx.db.patch(invitationId, { status: "revoked" });
    }
    return null;
  },
});

// ─── Accept (invitee) ──────────────────────────────────────────────────────

/** The result of {@link acceptInvitation}. */
type AcceptResult =
  | { status: "accepted"; workspaceId: Id<"workspaces"> }
  | { status: "wrong_account"; invitedEmail: string }
  | { status: "invalid" }
  | { status: "seat_limit"; checkoutUrl: string };

/**
 * Accept a pending invitation as the SIGNED-IN user. ACTION (seat check is
 * outbound HTTP). Validates the token is live and was issued to the caller's
 * email, re-checks seats, then inserts the membership transactionally and marks
 * the invite accepted. Mismatched email → `wrong_account`; over limit →
 * `seat_limit` (the workspace admin must upgrade).
 */
export const acceptInvitation = action({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<AcceptResult> => {
    const me = await ctx.runQuery(internal.invitations.currentUserForAccept, {});
    if (me === null) {
      throw new ConvexError({
        code: "UnauthenticatedError",
        message: "Sign in to accept an invitation.",
      });
    }
    if (!me.email) {
      return { status: "invalid" };
    }
    const myEmail = normalizeEmail(me.email);

    const inv = await ctx.runQuery(internal.invitations.invitationByToken, {
      token,
    });
    if (inv === null || inv.status !== "pending" || inv.expiresAt <= Date.now()) {
      return { status: "invalid" };
    }
    if (inv.email !== myEmail) {
      return { status: "wrong_account", invitedEmail: inv.email };
    }

    // Seat gate at accept time.
    const customerData = await ctx.runQuery(
      internal.workspaces.workspaceCustomerData,
      { workspaceId: inv.workspaceId },
    );
    const seat = await checkInviteSeat(
      inv.workspaceId,
      undefined,
      customerData,
    );
    if (!seat.allowed) {
      return { status: "seat_limit", checkoutUrl: seat.checkoutUrl };
    }
    const currentCount = await ctx.runQuery(internal.workspaces.countMembers, {
      workspaceId: inv.workspaceId,
    });
    const seatCeiling =
      seat.balance === null ? null : currentCount + seat.balance;

    const result = await ctx.runMutation(
      internal.invitations.acceptInvitationInsert,
      {
        invitationId: inv._id,
        userId: me.userId,
        email: myEmail,
        seatCeiling,
      },
    );

    if (!result.alreadyMember) {
      await trackSeatUsed(inv.workspaceId);
    }
    return { status: "accepted", workspaceId: result.workspaceId };
  },
});

/** The signed-in user's id + email, for the accept action. Internal. */
export const currentUserForAccept = internalQuery({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ userId: string; email: string | null } | null> => {
    const user = await getCurrentUser(ctx);
    if (user === null) return null;
    return { userId: user._id, email: user.email ?? null };
  },
});

/** Load an invitation by token (internal read for the accept action). */
export const invitationByToken = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<Doc<"invitations"> | null> => {
    return await ctx.db
      .query("invitations")
      .withIndex("by_token", (q) => q.eq("token", token))
      .first();
  },
});

/**
 * Insert the membership for an accepted invite and mark it accepted, in one
 * transaction. Internal: only the {@link acceptInvitation} action calls it. The
 * authz gate is the VALID PENDING INVITE for the caller's own email (re-checked
 * here) — no prior membership/role is required, unlike `insertMember`. The seat
 * ceiling is re-enforced against the live member count inside this transaction.
 */
export const acceptInvitationInsert = internalMutation({
  args: {
    invitationId: v.id("invitations"),
    userId: v.string(),
    email: v.string(),
    seatCeiling: v.union(v.number(), v.null()),
  },
  handler: async (
    ctx,
    { invitationId, userId, email, seatCeiling },
  ): Promise<{ alreadyMember: boolean; workspaceId: Id<"workspaces"> }> => {
    const inv = await ctx.db.get(invitationId);
    if (inv === null) {
      throw new ConvexError({ code: "NotFound", message: "Invitation gone." });
    }
    const { workspaceId } = inv;

    // Re-validate inside the transaction (defends against a revoke/expiry/email
    // change racing the action's read).
    if (
      inv.status !== "pending" ||
      inv.expiresAt <= Date.now() ||
      inv.email !== email
    ) {
      // If THIS user already accepted it, treat as success (idempotent).
      if (inv.status === "accepted" && inv.acceptedBy === userId) {
        return { alreadyMember: true, workspaceId };
      }
      throw new ConvexError({
        code: "InvalidInvitation",
        message: "This invitation is no longer valid.",
      });
    }

    // Live members in this transaction (range read → seat guard is atomic).
    const members = await ctx.db
      .query("members")
      .withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    const existing = members.find((m) => m.userId === userId) ?? null;
    if (existing !== null) {
      await ctx.db.patch(invitationId, {
        status: "accepted",
        acceptedBy: userId,
        acceptedAt: Date.now(),
      });
      return { alreadyMember: true, workspaceId };
    }

    await enforceSeatCeiling(members.length, seatCeiling);

    await ctx.db.insert("members", {
      workspaceId,
      userId,
      role: inv.role,
      createdAt: Date.now(),
    });
    await ctx.db.patch(invitationId, {
      status: "accepted",
      acceptedBy: userId,
      acceptedAt: Date.now(),
    });
    return { alreadyMember: false, workspaceId };
  },
});
