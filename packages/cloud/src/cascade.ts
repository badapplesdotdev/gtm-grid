/**
 * Pure cascade-delete domain logic for the Convex cloud tier (T4).
 *
 * Convex deletes are per-document (`ctx.db.delete(id)`) with no SQL `ON DELETE
 * CASCADE`, so deleting a table/column/row must explicitly remove its children.
 * The engine relies on SQLite foreign-key cascades; here the same fan-out is
 * computed in code. This module is the single, unit-tested source of truth for
 * WHAT a delete cascades to, keeping the Convex handlers thin (compute plan →
 * delete each id).
 *
 * Cascade rules (mirroring the engine's parent→child ownership):
 *   - deleteTable  → all of the table's columns, rows, and cells.
 *   - deleteColumn → all cells in that column.
 *   - deleteRow    → all cells in that row.
 *
 * The functions take the already-fetched child id lists (the handler does the
 * indexed reads via `by_table` / `by_row` / `by_column`) and return the full,
 * de-duplicated set of document ids to delete, INCLUDING the parent itself, in a
 * safe order (children before parents). Pure — no Convex import — so it stays in
 * the root `tsc -b` graph and is exhaustively unit-tested with the rest of the
 * domain logic.
 */

import { Effect } from "effect";

/**
 * A typed bundle of document ids to delete for a table cascade. The Convex
 * handler fetches these with the schema indexes and passes them in.
 */
export interface TableChildren {
  readonly columnIds: readonly string[];
  readonly rowIds: readonly string[];
  readonly cellIds: readonly string[];
}

/** The ordered, de-duplicated list of ids a cascade will delete. */
export interface DeletePlan {
  /** Document ids to delete, children-first. */
  readonly ids: readonly string[];
}

/** De-duplicate while preserving first-seen order. */
const dedupe = (ids: readonly string[]): string[] => [...new Set(ids)];

/**
 * Computes the document-id delete plan for a cascading delete. Keeps the Convex
 * handlers to "fetch children → run plan → delete each id".
 */
export class CascadePlanner extends Effect.Service<CascadePlanner>()(
  "CascadePlanner",
  {
    sync: () => ({
      /**
       * Plan for deleting a table: its cells, then rows + columns, then the
       * table. Children are deleted before parents so no row/column is orphaned
       * mid-cascade.
       */
      planDeleteTable: (
        tableId: string,
        children: TableChildren,
      ): Effect.Effect<DeletePlan> =>
        Effect.succeed({
          ids: dedupe([
            ...children.cellIds,
            ...children.rowIds,
            ...children.columnIds,
            tableId,
          ]),
        }),

      /**
       * Plan for deleting a column: every cell in that column, then the column.
       */
      planDeleteColumn: (
        columnId: string,
        cellIds: readonly string[],
      ): Effect.Effect<DeletePlan> =>
        Effect.succeed({
          ids: dedupe([...cellIds, columnId]),
        }),

      /**
       * Plan for deleting a row: every cell in that row, then the row.
       */
      planDeleteRow: (
        rowId: string,
        cellIds: readonly string[],
      ): Effect.Effect<DeletePlan> =>
        Effect.succeed({
          ids: dedupe([...cellIds, rowId]),
        }),
    }),
  },
) {}
