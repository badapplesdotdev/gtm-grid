/**
 * CLOUD-actions meter flush (C26).
 *
 * Billable CLOUD mutations only do a cheap DB increment of
 * `workspaces.cloudActionsPending` (they CANNOT make Autumn's outbound HTTP).
 * This module is the other half: a scheduled internal ACTION
 * ({@link flushCloudActions}, driven by convex/crons.ts) that batch-flushes
 * those pending counts to Autumn and snapshots each workspace's live usage so
 * the `me` query (convex/workspaces.ts) can surface `cloudActions { used, limit }`
 * with NO outbound HTTP of its own.
 *
 * Split across the runtimes Convex allows:
 *   - {@link listPendingWorkspaces} (internalQuery) — read workspaces with
 *     pending > 0 (the only ones worth flushing).
 *   - {@link flushCloudActions} (internalAction) — the ONLY place Autumn is
 *     called (HTTP), via the pure {@link CloudActionsService} bridged in
 *     convex/model/usage.ts.
 *   - {@link applyFlushResult} (internalMutation) — atomically decrement the
 *     pending counter by the amount that was successfully tracked and store the
 *     usage snapshot. Decrementing by the tracked amount (rather than blindly
 *     zeroing) preserves any increments that landed DURING the flush.
 *
 * Fail-closed: a workspace whose Autumn track FAILED is left untouched (its
 * pending count is kept for the next flush) — no usage is lost or double-counted.
 *
 * HARD RULE: this is the CLOUD path. LOCAL operations never increment the pending
 * counter, so a local-only workspace has nothing to flush — local is unlimited
 * and unmetered on every tier.
 */

import type { PendingWorkspace } from "@gtmgrid/cloud";
import { v } from "convex/values";
import { flushCloudActions as runFlush } from "./model/usage.js";
import { internal } from "./_generated/api.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server.js";

/**
 * Workspaces with a pending cloud-actions count > 0 — the only ones the flush
 * needs to track. Internal: only the flush action calls it. Uses the
 * `by_pending` index so an idle deployment scans nothing.
 */
export const listPendingWorkspaces = internalQuery({
  args: {},
  handler: async (ctx): Promise<readonly PendingWorkspace[]> => {
    const workspaces = await ctx.db
      .query("workspaces")
      .withIndex("by_pending", (q) => q.gt("cloudActionsPending", 0))
      .collect();
    // Enrich each pending workspace with its (org) name + owner email so the
    // flush can getOrCreate the Autumn customer WITH a profile before track
    // (the free-tier path that previously created the customer profile-less).
    // Mirrors the owner-email pattern in convex/workspaces.ts (me/listMembers).
    return Promise.all(
      workspaces.map(async (ws) => {
        const ownerId = ctx.db.normalizeId("users", ws.ownerId);
        const owner = ownerId === null ? null : await ctx.db.get(ownerId);
        return {
          workspaceId: ws._id,
          pending: ws.cloudActionsPending ?? 0,
          name: ws.name,
          ownerEmail: owner?.email ?? null,
        };
      }),
    );
  },
});

/**
 * Apply a SUCCESSFUL flush to one workspace: subtract the tracked amount from
 * the pending counter (preserving any increments that landed during the flush)
 * and store the latest usage snapshot for the `me` query. Internal: only the
 * flush action calls it, and only for `flushed: true` results.
 */
export const applyFlushResult = internalMutation({
  args: {
    // A plain string id (the flush domain works in workspace-id strings); it is
    // re-validated to an `Id<"workspaces">` here via `normalizeId`, avoiding any
    // `as` cast at the action→mutation boundary.
    workspaceId: v.string(),
    tracked: v.number(),
    used: v.number(),
    limit: v.union(v.number(), v.null()),
    // The current PAID plan id Autumn reported in the same flush (C27), or null
    // for the free tier — cached for the `me` query / plan badge.
    planId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { workspaceId, tracked, used, limit, planId }) => {
    const id = ctx.db.normalizeId("workspaces", workspaceId);
    if (id === null) return;
    const ws = await ctx.db.get(id);
    if (ws === null) return;
    const current = ws.cloudActionsPending ?? 0;
    // Never go below 0; concurrent increments during the flush are preserved.
    const remaining = Math.max(0, current - tracked);
    await ctx.db.patch(id, {
      cloudActionsPending: remaining,
      cloudActionsUsed: used,
      cloudActionsLimit: limit,
      currentPlanId: planId,
    });
  },
});

/**
 * Scheduled flush of every workspace's pending cloud-actions to Autumn.
 *
 * Reads pending workspaces, tracks each to Autumn (the only HTTP, via the pure
 * service), and for each SUCCESS decrements its pending counter + stores the
 * usage snapshot. A workspace whose track FAILED is left untouched (kept for the
 * next run — fail-closed). Internal action: invoked by the cron in
 * convex/crons.ts, never by a client.
 */
export const flushCloudActions = internalAction({
  args: {},
  handler: async (ctx): Promise<{ flushed: number; failed: number }> => {
    const pending = await ctx.runQuery(
      internal.usage.listPendingWorkspaces,
      {},
    );
    if (pending.length === 0) {
      return { flushed: 0, failed: 0 };
    }

    const results = await runFlush(pending);

    let flushed = 0;
    let failed = 0;
    for (const result of results) {
      if (result.flushed) {
        await ctx.runMutation(internal.usage.applyFlushResult, {
          workspaceId: result.workspaceId,
          tracked: result.tracked,
          used: result.usage.used,
          limit: result.usage.limit,
          planId: result.planId,
        });
        flushed += 1;
      } else {
        // Fail-closed: keep the pending count for retry on the next flush.
        failed += 1;
      }
    }
    return { flushed, failed };
  },
});
