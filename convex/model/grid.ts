/**
 * Convex ↔ Effect bridge for the grid data domain logic (T4).
 *
 * The merge/cascade business rules live as PURE Effect services in
 * `@gtmgrid/cloud` (packages/cloud/src/cells.ts, cascade.ts) so they are
 * exhaustively unit-tested with Effect test Layers and no Convex codegen. This
 * file is the seam that runs those services from inside Convex mutation
 * handlers via `Effect.runPromise`, plus the indexed child-fetch + cascade
 * executor the delete handlers reuse.
 *
 * Mirrors the pattern in convex/model/auth.ts (the requireMember bridge): pure
 * rules in `@gtmgrid/cloud`, ctx wiring here.
 */

import {
  CascadePlanner,
  type CellFields,
  CellMerge,
  type CellPatch,
  type DeletePlan,
} from "@gtmgrid/cloud";
import { Effect } from "effect";
import type { DataModel, Doc, Id } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server.js";

/** A document id for any table in the cloud schema. */
type AnyId = Id<keyof DataModel & string>;

/**
 * Delete the documents in a {@link DeletePlan}, in the planner's children-first
 * ORDER — the planner is the single source of truth for both WHAT and the order,
 * so handlers no longer re-implement the delete sequence. `byId` maps each
 * planned id string back to the strongly-typed document `Id` fetched from the
 * schema indexes, so no string is cast across the Convex boundary; an id absent
 * from the map (should never happen — the plan is built FROM these ids) is
 * skipped defensively.
 */
async function executePlan(
  ctx: MutationCtx,
  plan: DeletePlan,
  byId: ReadonlyMap<string, AnyId>,
): Promise<void> {
  for (const id of plan.ids) {
    const typed = byId.get(id);
    if (typed !== undefined) await ctx.db.delete(typed);
  }
}

/**
 * Run the COALESCE cell merge (engine db.ts:303-327 semantics) for a `setCell`.
 * `existing` is the current cell doc (or null for a new cell); returns the
 * fields to persist.
 */
export function mergeCellPatch(
  existing: Doc<"cells"> | null,
  patch: CellPatch,
  updatedAt: number,
): Promise<CellFields> {
  const base: CellFields | null = existing
    ? {
        value: existing.value,
        status: existing.status,
        error: existing.error,
        updatedAt: existing.updatedAt,
      }
    : null;
  return Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* CellMerge;
      return yield* svc.mergeCellPatch(base, patch, updatedAt);
    }).pipe(Effect.provide(CellMerge.Default)),
  );
}

/**
 * Cascade-delete a table: its cells, rows, and columns, then the table itself.
 *
 * The PURE `CascadePlanner` (unit-tested in @gtmgrid/cloud) decides the WHAT and
 * the children-first ORDER; this function fetches the typed child docs via the
 * schema indexes, asserts the plan covers exactly those ids, and deletes the
 * strongly-typed `Id`s directly (no string casts crossing the Convex boundary).
 */
export async function deleteTableCascade(
  ctx: MutationCtx,
  tableId: Id<"tables">,
): Promise<void> {
  const columns = await ctx.db
    .query("columns")
    .withIndex("by_table", (q) => q.eq("tableId", tableId))
    .collect();
  const rows = await ctx.db
    .query("rows")
    .withIndex("by_table", (q) => q.eq("tableId", tableId))
    .collect();
  const cells = await ctx.db
    .query("cells")
    .withIndex("by_table", (q) => q.eq("tableId", tableId))
    .collect();

  // Run the planner: it is the SINGLE source of truth for both WHAT cascades
  // and the children-first ORDER. The handler executes its output verbatim
  // rather than re-deriving the sequence.
  const plan = await Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* CascadePlanner;
      return yield* svc.planDeleteTable(tableId, {
        columnIds: columns.map((c) => c._id),
        rowIds: rows.map((r) => r._id),
        cellIds: cells.map((c) => c._id),
      });
    }).pipe(Effect.provide(CascadePlanner.Default)),
  );

  const byId = new Map<string, AnyId>([
    ...cells.map((c) => [c._id, c._id] as const),
    ...rows.map((r) => [r._id, r._id] as const),
    ...columns.map((c) => [c._id, c._id] as const),
    [tableId, tableId],
  ]);
  await executePlan(ctx, plan, byId);
}

/** Cascade-delete a single column: every cell in that column, then the column. */
export async function deleteColumnCascade(
  ctx: MutationCtx,
  column: Doc<"columns">,
): Promise<void> {
  // No by_column index on cells; read the table's cells (by_table) and filter
  // to this column.
  const cells = (
    await ctx.db
      .query("cells")
      .withIndex("by_table", (q) => q.eq("tableId", column.tableId))
      .collect()
  ).filter((c) => c.columnId === column._id);

  const plan = await Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* CascadePlanner;
      return yield* svc.planDeleteColumn(
        column._id,
        cells.map((c) => c._id),
      );
    }).pipe(Effect.provide(CascadePlanner.Default)),
  );

  const byId = new Map<string, AnyId>([
    ...cells.map((c) => [c._id, c._id] as const),
    [column._id, column._id],
  ]);
  await executePlan(ctx, plan, byId);
}

/** Cascade-delete a single row: every cell in that row, then the row. */
export async function deleteRowCascade(
  ctx: MutationCtx,
  rowId: Id<"rows">,
): Promise<void> {
  const cells = await ctx.db
    .query("cells")
    .withIndex("by_row", (q) => q.eq("rowId", rowId))
    .collect();

  const plan = await Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* CascadePlanner;
      return yield* svc.planDeleteRow(
        rowId,
        cells.map((c) => c._id),
      );
    }).pipe(Effect.provide(CascadePlanner.Default)),
  );

  const byId = new Map<string, AnyId>([
    ...cells.map((c) => [c._id, c._id] as const),
    [rowId, rowId],
  ]);
  await executePlan(ctx, plan, byId);
}
