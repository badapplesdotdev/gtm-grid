/**
 * Extension Convex functions (T4).
 *
 * - `listExtensions` (reactive query): a workspace's installed connector
 *   extensions. Members-only.
 * - `saveExtension` (mutation): upsert an extension manifest by
 *   (workspaceId, extensionId) — install or update in place. Members-only.
 *
 * Authz via the T3 `requireMember` guard.
 */

import { v } from "convex/values";
import { requireMember } from "./model/auth.js";
import { mutation, query } from "./_generated/server.js";

/** Reactive list of a workspace's extensions. Members-only. */
export const listExtensions = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    await requireMember(ctx, workspaceId);
    return await ctx.db
      .query("extensions")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
  },
});

/**
 * Install or update an extension manifest. Upserts on
 * (workspaceId, extensionId) so re-saving the same extension updates its
 * manifest rather than creating a duplicate. Members-only.
 */
export const saveExtension = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    extensionId: v.string(),
    name: v.string(),
    category: v.optional(v.union(v.string(), v.null())),
    manifest: v.any(),
  },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.workspaceId);

    const existing = await ctx.db
      .query("extensions")
      .withIndex("by_workspace_extension", (q) =>
        q
          .eq("workspaceId", args.workspaceId)
          .eq("extensionId", args.extensionId),
      )
      .unique();

    const fields = {
      name: args.name,
      category: args.category ?? null,
      manifest: args.manifest,
    };

    if (existing !== null) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("extensions", {
      workspaceId: args.workspaceId,
      extensionId: args.extensionId,
      ...fields,
    });
  },
});
