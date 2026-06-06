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
import {
  checkInviteSeat,
  enforceSeatCeiling,
  trackSeatUsed,
} from "./model/seats.js";
import { memberRole } from "./schema.js";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import {
  action,
  internalMutation,
  internalQuery,
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

    // Batch the per-workspace lookups instead of awaiting them sequentially
    // inside the map (the previous N+1 waterfall): fetch every workspace doc and
    // every workspace's member rows concurrently, keyed by workspace id, then
    // derive the seat-usage count from the already-fetched rows in memory.
    const workspaceIds = memberships.map((m) => m.workspaceId);
    const [workspaceDocs, memberCounts] = await Promise.all([
      Promise.all(workspaceIds.map((id) => ctx.db.get(id))),
      Promise.all(
        workspaceIds.map((id) =>
          ctx.db
            .query("members")
            .withIndex("by_workspace", (q) => q.eq("workspaceId", id))
            .collect()
            .then((rows) => rows.length),
        ),
      ),
    ]);

    const workspaces = memberships
      .map((m, i) => {
        const ws = workspaceDocs[i];
        if (ws === null || ws === undefined) return null;
        // Seat usage: real member count, limit deferred to Autumn.
        const seatUsage: { used: number; limit: number | null } = {
          used: memberCounts[i] ?? 0,
          limit: null,
        };
        // CLOUD-actions usage (C26): the last snapshot the scheduled flush
        // (convex/usage.ts) stored on the workspace, so the account bar can show
        // "cloud actions used / limit" with NO outbound HTTP from this query.
        // `used` is 0 and `limit` is null until the first flush runs. This counts
        // CLOUD operations ONLY — LOCAL projects never increment it (they never
        // call a Convex mutation), so local stays unlimited and unmetered.
        const cloudActions: { used: number; limit: number | null } = {
          used: ws.cloudActionsUsed ?? 0,
          limit: ws.cloudActionsLimit ?? null,
        };
        return {
          _id: ws._id,
          name: ws.name,
          role: m.role,
          seatUsage,
          cloudActions,
        };
      })
      .filter((w) => w !== null);

    return {
      user: { _id: user._id, name: user.name ?? null, email: user.email ?? null },
      workspaces,
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
    /**
     * Absolute seat CEILING the invite action derived from Autumn
     * (members-at-check-time + free balance), or `null` for unlimited. The
     * mutation re-reads the LIVE member count and enforces this inside its own
     * transaction so two concurrent invites cannot both pass and exceed it.
     */
    seatCeiling: v.union(v.number(), v.null()),
  },
  handler: async (ctx, { workspaceId, userId, role, seatCeiling }) => {
    // Authz: only owner/admin can invite members.
    await requireRole(ctx, workspaceId, ["owner", "admin"]);

    // Re-read the live members inside THIS transaction. Convex's optimistic
    // concurrency tracks this read range, so a concurrent invite that inserts a
    // member invalidates it and one of the two mutations re-runs — making the
    // seat check below atomic with the insert (closes the over-seat race).
    const members = await ctx.db
      .query("members")
      .withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId))
      .collect();

    // Idempotent: don't create a duplicate membership for an existing member.
    const existing = members.find((m) => m.userId === userId) ?? null;
    if (existing !== null) {
      return { memberId: existing._id, alreadyMember: true };
    }

    // Transactional seat guard: reject if adding would exceed the ceiling.
    await enforceSeatCeiling(members.length, seatCeiling);

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

    // 2. Derive an ABSOLUTE seat ceiling = members-at-check-time + free balance
    //    (null = unlimited). The mutation re-checks this against the live count
    //    in its own transaction, so the Autumn pre-check + insert are atomic and
    //    concurrent invites can't overshoot the limit.
    const currentCount = await ctx.runQuery(
      internal.workspaces.countMembers,
      { workspaceId },
    );
    const seatCeiling =
      seat.balance === null ? null : currentCount + seat.balance;

    // 3. Create the membership (authz + the transactional seat guard live inside
    //    the mutation). A losing concurrent invite throws SeatLimitExceededError.
    const { memberId, alreadyMember } = await ctx.runMutation(
      internal.workspaces.insertMember,
      { workspaceId, userId, role, seatCeiling },
    );

    // 4. Count the seat only for a genuinely new member.
    if (!alreadyMember) {
      await trackSeatUsed(workspaceId);
    }
    return { status: "added", memberId };
  },
});

/**
 * The live member count for a workspace, read in a single indexed scan.
 * Internal: only the `inviteMember` action calls it, to derive the seat ceiling
 * the membership mutation then re-verifies transactionally. Authz is enforced by
 * the mutation that consumes the ceiling, so this read stays a thin count.
 */
export const countMembers = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }): Promise<number> => {
    const members = await ctx.db
      .query("members")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    return members.length;
  },
});
