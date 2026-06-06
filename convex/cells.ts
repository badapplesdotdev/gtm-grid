/**
 * Cell Convex mutations (T4).
 *
 * - `setCell` — upsert a cell keyed by (rowId, columnId) with COALESCE merge
 *   semantics (engine db.ts:303-327): value/status overwrite only when
 *   provided; error always written; updatedAt always bumped. The merge rule
 *   itself is the unit-tested pure `CellMerge` service (convex/model/grid.ts →
 *   @gtmgrid/cloud); this handler reads the existing cell, merges, and writes.
 * - `setCellStatus` — a status-only convenience over the same merge (used by the
 *   run path to stream running→done), leaving value/error untouched per
 *   COALESCE.
 *
 * Authz: both resolve the owning workspace from the row and call `requireMember`
 * before writing. The (rowId, columnId) pair must belong to the same table.
 */

import { ConvexError, v } from "convex/values";
import { requireMember } from "./model/auth.js";
import { mergeCellPatch } from "./model/grid.js";
import { meterCloudAction } from "./model/meter.js";
import { cellStatus } from "./schema.js";
import type { Id } from "./_generated/dataModel.js";
import { type MutationCtx, mutation } from "./_generated/server.js";

/**
 * Resolve + authorize the (row, column) pair, returning the existing cell (or
 * null). Asserts both belong to the same table so a cell can't be written across
 * tables. Members-only.
 */
async function resolveCell(
  ctx: MutationCtx,
  rowId: Id<"rows">,
  columnId: Id<"columns">,
) {
  const row = await ctx.db.get(rowId);
  const column = await ctx.db.get(columnId);
  if (row === null || column === null) {
    throw new ConvexError({
      code: "NotFoundError",
      message: "Row or column not found.",
    });
  }
  if (row.tableId !== column.tableId) {
    throw new ConvexError({
      code: "InvalidCellError",
      message: "Row and column belong to different tables.",
    });
  }
  await requireMember(ctx, row.workspaceId);

  const existing = await ctx.db
    .query("cells")
    .withIndex("by_row_column", (q) =>
      q.eq("rowId", rowId).eq("columnId", columnId),
    )
    .unique();

  return { row, column, existing };
}

/**
 * Upsert a cell with COALESCE merge. Inserts when no cell exists for
 * (rowId, columnId), updates otherwise — exactly one cell per pair.
 */
export const setCell = mutation({
  args: {
    rowId: v.id("rows"),
    columnId: v.id("columns"),
    value: v.optional(v.any()),
    status: v.optional(cellStatus),
    error: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const { row, existing } = await resolveCell(ctx, args.rowId, args.columnId);

    // Only forward `value` when the caller actually sent it, so the merge's
    // COALESCE (kept when omitted) holds. `"value" in args` distinguishes an
    // explicit `value: undefined`/`null` from omission at the Convex boundary.
    const patch = {
      ...("value" in args ? { value: args.value } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.error !== undefined ? { error: args.error } : {}),
    };
    const merged = await mergeCellPatch(existing, patch, Date.now());

    // Billable CLOUD action: count one toward the workspace's cloud-actions
    // meter (cheap DB increment; flushed to Autumn by the scheduled action).
    // Cloud runs write cells via this mutation, so they are counted here ONCE —
    // the sidecar must NOT also count (no double-count, no Autumn secret on it).
    await meterCloudAction(ctx, row.workspaceId);

    if (existing === null) {
      return await ctx.db.insert("cells", {
        workspaceId: row.workspaceId,
        tableId: row.tableId,
        rowId: args.rowId,
        columnId: args.columnId,
        value: merged.value,
        status: merged.status,
        error: merged.error,
        updatedAt: merged.updatedAt,
      });
    }
    await ctx.db.patch(existing._id, {
      value: merged.value,
      status: merged.status,
      error: merged.error,
      updatedAt: merged.updatedAt,
    });
    return existing._id;
  },
});

/**
 * Set only a cell's status (run lifecycle: running → done/error), preserving its
 * value via COALESCE. A thin specialization of {@link setCell}.
 */
export const setCellStatus = mutation({
  args: {
    rowId: v.id("rows"),
    columnId: v.id("columns"),
    status: cellStatus,
    error: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const { row, existing } = await resolveCell(ctx, args.rowId, args.columnId);

    const merged = await mergeCellPatch(
      existing,
      {
        status: args.status,
        ...(args.error !== undefined ? { error: args.error } : {}),
      },
      Date.now(),
    );

    // Billable CLOUD action: the run path streams running→done via this
    // mutation, so each status write counts ONE toward the cloud-actions meter
    // here (never also in the sidecar — see setCell's note).
    await meterCloudAction(ctx, row.workspaceId);

    if (existing === null) {
      return await ctx.db.insert("cells", {
        workspaceId: row.workspaceId,
        tableId: row.tableId,
        rowId: args.rowId,
        columnId: args.columnId,
        value: merged.value,
        status: merged.status,
        error: merged.error,
        updatedAt: merged.updatedAt,
      });
    }
    await ctx.db.patch(existing._id, {
      status: merged.status,
      error: merged.error,
      updatedAt: merged.updatedAt,
    });
    return existing._id;
  },
});
