/**
 * Workspace + membership Convex functions (T4).
 *
 * - `me` (query): the authenticated user, the workspaces they belong to (with
 *   role), and a seat-usage placeholder (member count + a null limit until the
 *   Autumn billing lane, T6, fills it in). Reactive: the UI's account bar
 *   subscribes to this.
 * - `createWorkspace` (mutation): create a workspace and make the creator its
 *   owner member.
 * - `inviteMember` (mutation): add a user to a workspace. THIS is the seam where
 *   T6 inserts the Autumn `seats` `check` before creating the membership — see
 *   the marked block. Authz: only owner/admin may invite.
 *
 * Workspace-scoped reads/writes enforce membership via the T3 `requireMember` /
 * `requireRole` helpers (convex/model/auth.ts).
 */

import { ConvexError, v } from "convex/values";
import {
  getCurrentUser,
  getCurrentUserId,
  requireMember,
  requireRole,
} from "./model/auth.js";
import { checkInviteSeat, trackSeatUsed } from "./model/seats.js";
import { memberRole } from "./schema.js";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import {
  action,
  internalMutation,
  mutation,
  query,
} from "./_generated/server.js";

/**
 * The current user + their workspaces + seat usage. Returns `null` when signed
 * out (the UI renders the local/sign-in state). Seat usage is a placeholder:
 * `used` is the real member count; `limit` is null until Autumn (T6) provides
 * the entitlement. Kept here so the account bar has a stable shape to bind now.
 */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (user === null) return null;

    // Workspaces the user is a member of (authz: never lists foreign ones).
    const memberships = await ctx.db
      .query("members")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    const workspaces = await Promise.all(
      memberships.map(async (m) => {
        const ws = await ctx.db.get(m.workspaceId);
        if (ws === null) return null;
        // Seat usage placeholder: real member count, limit deferred to Autumn.
        const memberCount = (
          await ctx.db
            .query("members")
            .withIndex("by_workspace", (q) =>
              q.eq("workspaceId", ws._id),
            )
            .collect()
        ).length;
        const seatUsage: { used: number; limit: number | null } = {
          used: memberCount,
          limit: null,
        };
        return { _id: ws._id, name: ws.name, role: m.role, seatUsage };
      }),
    );

    return {
      user: { _id: user._id, name: user.name ?? null, email: user.email ?? null },
      workspaces: workspaces.filter((w) => w !== null),
    };
  },
});

/**
 * List the members of a workspace for the settings / seats view (T10).
 *
 * Reactive: the workspace settings panel subscribes to this so an invite (by any
 * member) appears live. Authz: caller must be a member of the workspace
 * ({@link requireMember}) — a user never sees a foreign workspace's roster.
 *
 * Each member is joined to their `users` row for a display name + email. Seat
 * usage mirrors the {@link me} query's placeholder shape (`used` = real member
 * count; `limit` deferred to Autumn/T8c), so the UI shows "seats used / limit"
 * from one source.
 */
export const listMembers = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    // Authz: only a member of this workspace may read its roster.
    await requireMember(ctx, workspaceId);

    const memberRows = await ctx.db
      .query("members")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();

    const members = await Promise.all(
      memberRows.map(async (m) => {
        const user = ctx.db.normalizeId("users", m.userId);
        const userDoc = user === null ? null : await ctx.db.get(user);
        return {
          _id: m._id,
          userId: m.userId,
          role: m.role,
          createdAt: m.createdAt,
          name: userDoc?.name ?? null,
          email: userDoc?.email ?? null,
        };
      }),
    );

    // Stable ordering: oldest member (the owner) first.
    members.sort((a, b) => a.createdAt - b.createdAt);

    const seatUsage: { used: number; limit: number | null } = {
      used: members.length,
      limit: null,
    };

    return { members, seatUsage };
  },
});

/**
 * Create a workspace owned by the caller, inserting the owner membership in the
 * same mutation. Requires authentication.
 */
export const createWorkspace = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const userId = await getCurrentUserId(ctx);
    if (userId === null) {
      throw new ConvexError({
        code: "UnauthenticatedError",
        message: "Sign in to create a workspace.",
      });
    }
    const now = Date.now();
    const workspaceId = await ctx.db.insert("workspaces", {
      name,
      ownerId: userId,
      createdAt: now,
    });
    await ctx.db.insert("members", {
      workspaceId,
      userId,
      role: "owner",
      createdAt: now,
    });
    return workspaceId;
  },
});

/**
 * Insert a workspace membership (the success-path write of {@link inviteMember}).
 *
 * Internal: only the `inviteMember` ACTION calls this, AFTER the Autumn seat
 * gate allows the invite. Still enforces authz (owner/admin) and idempotency
 * itself so the rule lives with the write. Returns `{ alreadyMember }` so the
 * action can skip seat tracking for a no-op re-invite.
 */
export const insertMember = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    userId: v.string(),
    role: memberRole,
  },
  handler: async (ctx, { workspaceId, userId, role }) => {
    // Authz: only owner/admin can invite members.
    await requireRole(ctx, workspaceId, ["owner", "admin"]);

    // Idempotent: don't create a duplicate membership for an existing member.
    const existing = await ctx.db
      .query("members")
      .withIndex("by_workspace_user", (q) =>
        q.eq("workspaceId", workspaceId).eq("userId", userId),
      )
      .unique();
    if (existing !== null) {
      return { memberId: existing._id, alreadyMember: true };
    }

    const memberId = await ctx.db.insert("members", {
      workspaceId,
      userId,
      role,
      createdAt: Date.now(),
    });
    return { memberId, alreadyMember: false };
  },
});

/**
 * The shape returned by {@link inviteMember}: either the new/existing member id
 * (the seat was available and the membership exists) or a checkout URL to open
 * the upgrade modal (over the seat limit — nothing was added).
 */
type InviteResult =
  | { status: "added"; memberId: Id<"members"> }
  | { status: "checkout"; checkoutUrl: string };

/**
 * Invite (add) a user to a workspace, gated on Autumn `seats` (T6).
 *
 * Runs as an ACTION (not a mutation) because the seat check makes an outbound
 * HTTP call to Autumn, which mutations cannot. Flow:
 *   1. {@link checkInviteSeat} — Autumn `check` on the `seats` feature for the
 *      workspace customer.
 *   2a. allowed  → call {@link insertMember} (which re-verifies authz +
 *       idempotency), then Autumn `track` one seat; return the member id.
 *   2b. over limit → return the Autumn `checkout` URL instead of adding anyone.
 *
 * The workspace id is the Autumn customer id. NO connector/table caps exist —
 * `seats` is the only gate.
 */
export const inviteMember = action({
  args: {
    workspaceId: v.id("workspaces"),
    userId: v.string(),
    role: memberRole,
  },
  handler: async (ctx, { workspaceId, userId, role }): Promise<InviteResult> => {
    // 1. Seat gate (Autumn). Over the limit → return checkout, add nobody.
    const seat = await checkInviteSeat(workspaceId);
    if (!seat.allowed) {
      return { status: "checkout", checkoutUrl: seat.checkoutUrl };
    }

    // 2. Allowed: create the membership (authz re-checked inside the mutation).
    const { memberId, alreadyMember } = await ctx.runMutation(
      internal.workspaces.insertMember,
      { workspaceId, userId, role },
    );

    // 3. Count the seat only for a genuinely new member.
    if (!alreadyMember) {
      await trackSeatUsed(workspaceId);
    }
    return { status: "added", memberId };
  },
});
