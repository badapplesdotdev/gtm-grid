/**
 * Project Convex functions (T4).
 *
 * - `listProjects` (reactive query): the projects in a workspace, ordered by
 *   creation. The UI's project switcher subscribes to this for realtime.
 * - `createProject` (mutation): create a project in a workspace.
 *
 * Both enforce workspace membership via the T3 `requireMember` guard
 * (convex/model/auth.ts) before touching data.
 */

import { v } from "convex/values";
import { requireMember } from "./model/auth.js";
import { mutation, query } from "./_generated/server.js";

/** Reactive list of a workspace's projects. Members-only. */
export const listProjects = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    await requireMember(ctx, workspaceId);
    return await ctx.db
      .query("projects")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
  },
});

/** Create a project in a workspace. Members-only. */
export const createProject = mutation({
  args: { workspaceId: v.id("workspaces"), name: v.string() },
  handler: async (ctx, { workspaceId, name }) => {
    await requireMember(ctx, workspaceId);
    return await ctx.db.insert("projects", {
      workspaceId,
      name,
      createdAt: Date.now(),
    });
  },
});
