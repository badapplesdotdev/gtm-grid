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
import { getCurrentUser, getCurrentUserId, requireRole } from "./model/auth.js";
import { memberRole } from "./schema.js";
import { mutation, query } from "./_generated/server.js";

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
 * Invite (add) a user to a workspace with a role. Owner/admin only.
 *
 * SEAM FOR T6 (Autumn seats): before creating the membership, T6 will call the
 * Autumn `seats` `check`; if over the limit it returns a checkout URL instead of
 * inserting. The membership insert below stays the success path. Kept isolated
 * so that lane is a localized change here.
 */
export const inviteMember = mutation({
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
    if (existing !== null) return existing._id;

    // ── T6 Autumn seats check goes HERE (before the insert). ──

    return await ctx.db.insert("members", {
      workspaceId,
      userId,
      role,
      createdAt: Date.now(),
    });
  },
});
