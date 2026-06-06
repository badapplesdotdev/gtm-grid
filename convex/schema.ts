/**
 * Convex schema for GTM Grid's cloud (team / multiplayer) tier.
 *
 * This is the cloud source of truth for paid, collaborative projects ONLY.
 * Local solo projects continue to use the unchanged local SQLite engine
 * (packages/engine/src/db.ts) — nothing here touches that path.
 *
 * The tables below mirror the engine's data model (db.ts SCHEMA, ~lines 18-74;
 * types in packages/engine/src/types.ts) but are scoped to a `workspace` so
 * multiple members can collaborate on shared grids. Every `useQuery` in the
 * desktop app subscribes to these tables for realtime multiplayer.
 *
 * Indexes (by_workspace / by_project / by_table / by_row) back the reactive
 * queries the UI runs — Convex requires an index for efficient filtered reads.
 *
 * NOTE: this file is part of a self-contained `convex/` package with its OWN
 * tsconfig; it is deliberately NOT in the root `tsc -b` graph because Convex's
 * generated `_generated/` types require a deployment login (`npx convex dev`).
 * Keeping it out of the root graph means the root verify gate stays green
 * before codegen runs.
 */

import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Cell status — mirrors `CellStatus` in packages/engine/src/types.ts:
 *   "empty" | "pending" | "running" | "done" | "error"
 * A union of literals so Convex validates the value on write, exactly like the
 * engine's status column.
 */
export const cellStatus = v.union(
  v.literal("empty"),
  v.literal("pending"),
  v.literal("running"),
  v.literal("done"),
  v.literal("error"),
);

/** Column value type — mirrors `ColumnType` in types.ts. */
export const columnType = v.union(
  v.literal("text"),
  v.literal("number"),
  v.literal("boolean"),
  v.literal("date"),
  v.literal("json"),
);

/** Column kind — mirrors `ColumnKind` in types.ts. */
export const columnKind = v.union(v.literal("manual"), v.literal("function"));

/**
 * Member role within a workspace. `owner` created/owns the workspace (billing),
 * `admin` can manage members, `member` can edit grids.
 */
export const memberRole = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("member"),
);

/**
 * Credential scope for cloud projects. `workspace` credentials are the shared
 * team keys (server-side encrypted, see Part A of the plan); `personal` keys
 * belong to a single member. The engine's local-only "local" scope has no
 * cloud equivalent and is intentionally omitted here.
 */
export const credentialScope = v.union(
  v.literal("workspace"),
  v.literal("personal"),
);

export default defineSchema({
  /**
   * Convex Auth tables (T3): `users`, `authSessions`, `authAccounts`,
   * `authRefreshTokens`, `authVerificationCodes`, `authVerifiers`,
   * `authRateLimits`. Spreading `authTables` registers them so the password
   * (and scaffolded OAuth) provider can persist users + sessions. The
   * authenticated user id (`Id<"users">`) is what `members.userId` /
   * `workspaces.ownerId` reference (stored as a string for index flexibility).
   */
  ...authTables,

  /** Top-level account unit. Billing and membership scope to a workspace. */
  workspaces: defineTable({
    name: v.string(),
    /** Convex Auth user id of the creator/owner (set by T3). */
    ownerId: v.string(),
    createdAt: v.number(),
    /**
     * Pending CLOUD-actions meter (C26). Billable CLOUD mutations (cell writes,
     * structural inserts/deletes) increment this by 1 — a cheap DB write, since
     * Convex mutations CANNOT make the outbound HTTP a direct Autumn `track`
     * would need. A scheduled internal ACTION (convex/usage.ts, driven by
     * convex/crons.ts) batch-flushes pending counts to Autumn and resets this to
     * 0 ONLY on a successful track (fail-closed: kept on error for retry).
     *
     * HARD RULE: this counts CLOUD operations ONLY. LOCAL projects run on the
     * user machine (sidecar + local SQLite) and never call a Convex mutation, so
     * they can never increment this — local is unlimited and unmetered on EVERY
     * tier. Optional/undefined is treated as 0.
     */
    cloudActionsPending: v.optional(v.number()),
    /**
     * Last-known CLOUD-actions usage Autumn reported, snapshotted by the flush
     * ACTION so the `me` query can surface `cloudActions { used, limit }` with NO
     * outbound HTTP. `used` is consumed units this period; `limit` is the plan
     * cap (free = 2000) or `null` for an unlimited plan. Undefined until the
     * first flush.
     */
    cloudActionsUsed: v.optional(v.number()),
    cloudActionsLimit: v.optional(v.union(v.number(), v.null())),
    /**
     * The workspace's current PAID plan id (C27): "team" | "business" |
     * "unlimited", or `null` for the free tier. Cached by the scheduled flush
     * ACTION (convex/usage.ts), which reads it from Autumn alongside the
     * cloud-actions usage so the `me` query can surface the plan name (Free /
     * Team / Business / Unlimited) with NO outbound HTTP. Undefined until the
     * first flush — treated as free/null by the query.
     */
    currentPlanId: v.optional(v.union(v.string(), v.null())),
  })
    .index("by_owner", ["ownerId"])
    .index("by_pending", ["cloudActionsPending"]),

  /**
   * Workspace membership: a user belongs to a workspace with a role.
   * by_workspace lists a workspace's members; by_user lists a user's
   * workspaces (authz: a user only sees workspaces they belong to);
   * by_workspace_user enforces a single membership row per (user, workspace).
   */
  members: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.string(),
    role: memberRole,
    createdAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_user", ["userId"])
    .index("by_workspace_user", ["workspaceId", "userId"]),

  /** A cloud project (a collection of tables) scoped to one workspace. */
  projects: defineTable({
    workspaceId: v.id("workspaces"),
    name: v.string(),
    createdAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  /** A grid/table within a project. Mirrors engine `tables`. */
  tables: defineTable({
    workspaceId: v.id("workspaces"),
    projectId: v.id("projects"),
    name: v.string(),
    position: v.number(),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_workspace", ["workspaceId"]),

  /** A column within a table. Mirrors engine `columns`. */
  columns: defineTable({
    workspaceId: v.id("workspaces"),
    tableId: v.id("tables"),
    name: v.string(),
    type: columnType,
    kind: columnKind,
    /** Connector provider for a function column, e.g. "ai" or "apollo". */
    provider: v.union(v.string(), v.null()),
    /** Connector method, e.g. "generate" or "enrichPerson". */
    method: v.union(v.string(), v.null()),
    /** JS body executed in the QuickJS sandbox for function columns. */
    code: v.union(v.string(), v.null()),
    /** Input mapping; templated with {{Column Name}} against the row. */
    params: v.any(),
    position: v.number(),
    createdAt: v.number(),
  })
    .index("by_table", ["tableId"])
    .index("by_workspace", ["workspaceId"]),

  /** A row within a table. Mirrors engine `rows`. */
  rows: defineTable({
    workspaceId: v.id("workspaces"),
    tableId: v.id("tables"),
    position: v.number(),
    createdAt: v.number(),
  })
    .index("by_table", ["tableId"])
    .index("by_workspace", ["workspaceId"]),

  /**
   * A cell keyed by (rowId, columnId). Mirrors the engine cell shape:
   *   { value, status, error, updatedAt }
   * `value` is `v.any()` because cells hold arbitrary JSON (the engine stores
   * the JSON-stringified value; here Convex stores the structured value).
   * by_row backs the reactive "all cells for a row" query; by_row_column
   * uniquely addresses a single cell for `setCell` upserts.
   */
  cells: defineTable({
    workspaceId: v.id("workspaces"),
    tableId: v.id("tables"),
    rowId: v.id("rows"),
    columnId: v.id("columns"),
    value: v.any(),
    status: cellStatus,
    error: v.union(v.string(), v.null()),
    updatedAt: v.union(v.number(), v.null()),
  })
    .index("by_row", ["rowId"])
    .index("by_row_column", ["rowId", "columnId"])
    .index("by_table", ["tableId"])
    .index("by_workspace", ["workspaceId"]),

  /** Uploaded JSON-manifest connector extensions, shared per workspace. */
  extensions: defineTable({
    workspaceId: v.id("workspaces"),
    /** Stable extension id from the manifest (e.g. "apollo"). */
    extensionId: v.string(),
    name: v.string(),
    category: v.union(v.string(), v.null()),
    manifest: v.any(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_extension", ["workspaceId", "extensionId"]),

  /**
   * Shared connector credentials, encrypted at rest under a workspace-scoped
   * key (envelope encryption handled by the credential service in T7).
   * Plaintext secrets are NEVER stored here.
   */
  credentials: defineTable({
    workspaceId: v.id("workspaces"),
    /** The connector/extension these secrets authenticate, e.g. "ai:openai". */
    extensionId: v.string(),
    scope: credentialScope,
    /**
     * Owning member for a `personal`-scope row (the Convex Auth user id who saved
     * it); `null` for shared `workspace`-scope rows. Binding personal keys to an
     * owner stops two members colliding on (workspace, extension, scope) and
     * stops one member reading/rotating another's personal key. Nullable so the
     * field is set only on personal rows.
     */
    ownerUserId: v.union(v.string(), v.null()),
    name: v.string(),
    /** Ciphertext of the secret map (envelope-encrypted). Never plaintext. */
    secretsEnc: v.string(),
    createdAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_extension", ["workspaceId", "extensionId"])
    .index("by_workspace_extension_owner", [
      "workspaceId",
      "extensionId",
      "scope",
      "ownerUserId",
    ]),
});
