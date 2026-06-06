/**
 * Table / column / row Convex functions (T4).
 *
 * Reactive query:
 *   - `getTable` — the table plus its columns, rows, and ALL cells (keyed by
 *     (rowId, columnId)). One subscription drives the whole grid view for
 *     realtime multiplayer.
 *
 * Mutations:
 *   - `createTable`, `addColumn`, `addRow` — structural inserts (next position
 *     computed from siblings).
 *   - `deleteTable`, `deleteColumn`, `deleteRow` — cascading deletes via the
 *     unit-tested `CascadePlanner` (convex/model/grid.ts).
 *
 * Authz: every handler resolves the owning workspace from the parent doc and
 * calls the T3 `requireMember` guard before reading/writing. A missing parent or
 * a parent in a workspace the caller can't access fails authz (no leakage).
 */

import { ConvexError, v } from "convex/values";
import { requireMember } from "./model/auth.js";
import {
  deleteColumnCascade,
  deleteRowCascade,
  deleteTableCascade,
} from "./model/grid.js";
import { meterCloudAction, meterCloudActions } from "./model/meter.js";
import { columnKind, columnType } from "./schema.js";
import type { Id } from "./_generated/dataModel.js";
import { mutation, type QueryCtx, query } from "./_generated/server.js";

/** Load a doc by id or fail with a typed NotFound the client can read. */
async function getOrThrow<T extends "projects" | "tables" | "columns" | "rows">(
  ctx: QueryCtx,
  table: T,
  id: Id<T>,
) {
  const doc = await ctx.db.get(id);
  if (doc === null) {
    throw new ConvexError({
      code: "NotFoundError",
      message: `${table} ${id} not found.`,
    });
  }
  return doc;
}

/**
 * Reactive list of a project's tables (ordered by position, then creation).
 * Members-only — the project's workspace gates access. Drives the cloud-project
 * table list in the sidebar; the per-table grid loads via {@link getTable}.
 */
export const listTables = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const project = await getOrThrow(ctx, "projects", projectId);
    await requireMember(ctx, project.workspaceId);
    const tables = await ctx.db
      .query("tables")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    return [...tables].sort(
      (a, b) => a.position - b.position || a.createdAt - b.createdAt,
    );
  },
});

/**
 * The full grid for a table: the table, its columns + rows (ordered by
 * position), and every cell. Members-only.
 */
export const getTable = query({
  args: { tableId: v.id("tables") },
  handler: async (ctx, { tableId }) => {
    const table = await getOrThrow(ctx, "tables", tableId);
    await requireMember(ctx, table.workspaceId);

    const [columns, rows, cells] = await Promise.all([
      ctx.db
        .query("columns")
        .withIndex("by_table", (q) => q.eq("tableId", tableId))
        .collect(),
      ctx.db
        .query("rows")
        .withIndex("by_table", (q) => q.eq("tableId", tableId))
        .collect(),
      ctx.db
        .query("cells")
        .withIndex("by_table", (q) => q.eq("tableId", tableId))
        .collect(),
    ]);

    const byPosition = <T extends { position: number; createdAt: number }>(
      a: T,
      b: T,
    ) => a.position - b.position || a.createdAt - b.createdAt;

    return {
      table,
      columns: [...columns].sort(byPosition),
      rows: [...rows].sort(byPosition),
      cells,
    };
  },
});

/** Next `position` for a new sibling = max(existing) + 1 (0 when empty). */
const nextPosition = (siblings: readonly { position: number }[]): number =>
  siblings.reduce((max, s) => Math.max(max, s.position + 1), 0);

/** Create a table in a project. Members-only. */
export const createTable = mutation({
  args: { projectId: v.id("projects"), name: v.string() },
  handler: async (ctx, { projectId, name }) => {
    const project = await getOrThrow(ctx, "projects", projectId);
    await requireMember(ctx, project.workspaceId);

    const siblings = await ctx.db
      .query("tables")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();

    // Billable CLOUD action (cloud-actions meter; LOCAL is never metered).
    await meterCloudAction(ctx, project.workspaceId);

    return await ctx.db.insert("tables", {
      workspaceId: project.workspaceId,
      projectId,
      name,
      position: nextPosition(siblings),
      createdAt: Date.now(),
    });
  },
});

/** Add a column to a table. Members-only. */
export const addColumn = mutation({
  args: {
    tableId: v.id("tables"),
    name: v.string(),
    type: columnType,
    kind: columnKind,
    provider: v.optional(v.union(v.string(), v.null())),
    method: v.optional(v.union(v.string(), v.null())),
    code: v.optional(v.union(v.string(), v.null())),
    params: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const table = await getOrThrow(ctx, "tables", args.tableId);
    await requireMember(ctx, table.workspaceId);

    const siblings = await ctx.db
      .query("columns")
      .withIndex("by_table", (q) => q.eq("tableId", args.tableId))
      .collect();

    // Billable CLOUD action (cloud-actions meter; LOCAL is never metered).
    await meterCloudAction(ctx, table.workspaceId);

    return await ctx.db.insert("columns", {
      workspaceId: table.workspaceId,
      tableId: args.tableId,
      name: args.name,
      type: args.type,
      kind: args.kind,
      provider: args.provider ?? null,
      method: args.method ?? null,
      code: args.code ?? null,
      params: args.params ?? {},
      position: nextPosition(siblings),
      createdAt: Date.now(),
    });
  },
});

/** Add a row to a table. Members-only. */
export const addRow = mutation({
  args: { tableId: v.id("tables") },
  handler: async (ctx, { tableId }) => {
    const table = await getOrThrow(ctx, "tables", tableId);
    await requireMember(ctx, table.workspaceId);

    const siblings = await ctx.db
      .query("rows")
      .withIndex("by_table", (q) => q.eq("tableId", tableId))
      .collect();

    // Billable CLOUD action (cloud-actions meter; LOCAL is never metered).
    await meterCloudAction(ctx, table.workspaceId);

    return await ctx.db.insert("rows", {
      workspaceId: table.workspaceId,
      tableId,
      position: nextPosition(siblings),
      createdAt: Date.now(),
    });
  },
});

/**
 * Bulk insert rows + their cells for CSV import. Members-only.
 *
 * Each entry in `rows` is a `{ columnId: value }` map; empty values are skipped
 * (the cell stays empty) and values for columns not in this table are ignored
 * (no cross-table writes). Metered as ONE cloud action per row (not per cell).
 *
 * Atomic quota guard: before inserting anything, a best-effort check against the
 * workspace's CACHED cloud-actions usage (`cloudActionsUsed` + pending) rejects
 * an import that would exceed the plan limit — so a free workspace can't blow its
 * cap mid-import and end up with a half-written table. Unlimited plans (limit
 * null) always pass. The cache can lag a flush, so this is a guard, not exact
 * accounting; the scheduled flush remains the source of truth for billing.
 */
export const addRowsWithCells = mutation({
  args: {
    tableId: v.id("tables"),
    rows: v.array(v.record(v.string(), v.any())),
  },
  handler: async (ctx, { tableId, rows }) => {
    const table = await getOrThrow(ctx, "tables", tableId);
    await requireMember(ctx, table.workspaceId);

    // Atomic quota pre-check against cached usage (free tier has a hard cap).
    const workspace = await ctx.db.get(table.workspaceId);
    const limit = workspace?.cloudActionsLimit;
    if (typeof limit === "number") {
      const used = workspace?.cloudActionsUsed ?? 0;
      const pending = workspace?.cloudActionsPending ?? 0;
      if (used + pending + rows.length > limit) {
        throw new ConvexError({
          code: "CloudActionsLimitError",
          message:
            "This import would exceed your plan's remaining cloud actions. Upgrade your plan or import fewer rows.",
        });
      }
    }

    // Only write cells for columns that actually belong to this table.
    const columns = await ctx.db
      .query("columns")
      .withIndex("by_table", (q) => q.eq("tableId", tableId))
      .collect();
    const validColumnIds = new Set<string>(columns.map((c) => c._id));

    const siblings = await ctx.db
      .query("rows")
      .withIndex("by_table", (q) => q.eq("tableId", tableId))
      .collect();
    let position = nextPosition(siblings);
    const now = Date.now();

    const rowIds: Id<"rows">[] = [];
    for (const cells of rows) {
      const rowId = await ctx.db.insert("rows", {
        workspaceId: table.workspaceId,
        tableId,
        position: position++,
        createdAt: now,
      });
      rowIds.push(rowId);
      for (const [columnId, value] of Object.entries(cells)) {
        if (value === "" || value === null || value === undefined) continue;
        if (!validColumnIds.has(columnId)) continue;
        await ctx.db.insert("cells", {
          workspaceId: table.workspaceId,
          tableId,
          rowId,
          columnId: columnId as Id<"columns">,
          value,
          status: "done",
          error: null,
          updatedAt: now,
        });
      }
    }

    // One billable cloud action per imported row (cells are not metered).
    await meterCloudActions(ctx, table.workspaceId, rows.length);

    return { rowIds };
  },
});

/** Delete a table and all of its columns, rows, and cells. Members-only. */
export const deleteTable = mutation({
  args: { tableId: v.id("tables") },
  handler: async (ctx, { tableId }) => {
    const table = await getOrThrow(ctx, "tables", tableId);
    await requireMember(ctx, table.workspaceId);
    // Billable CLOUD action (cloud-actions meter; LOCAL is never metered).
    await meterCloudAction(ctx, table.workspaceId);
    await deleteTableCascade(ctx, tableId);
  },
});

/** Delete a column and all of its cells. Members-only. */
export const deleteColumn = mutation({
  args: { columnId: v.id("columns") },
  handler: async (ctx, { columnId }) => {
    const column = await getOrThrow(ctx, "columns", columnId);
    await requireMember(ctx, column.workspaceId);
    // Billable CLOUD action (cloud-actions meter; LOCAL is never metered).
    await meterCloudAction(ctx, column.workspaceId);
    await deleteColumnCascade(ctx, column);
  },
});

/** Delete a row and all of its cells. Members-only. */
export const deleteRow = mutation({
  args: { rowId: v.id("rows") },
  handler: async (ctx, { rowId }) => {
    const row = await getOrThrow(ctx, "rows", rowId);
    await requireMember(ctx, row.workspaceId);
    // Billable CLOUD action (cloud-actions meter; LOCAL is never metered).
    await meterCloudAction(ctx, row.workspaceId);
    await deleteRowCascade(ctx, rowId);
  },
});
