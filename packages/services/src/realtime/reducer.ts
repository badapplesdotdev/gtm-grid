/**
 * The PURE grid cache-patch reducer — the heart of the live-reactivity
 * replacement for Convex `useQuery`.
 *
 * {@link applyGridEvent} takes the current `getTable`-shaped {@link GridSnapshot}
 * and ONE inbound {@link GridChangeEvent} and returns the next snapshot, applying
 * the change immutably (a new object/array is returned; the input is never
 * mutated). It is the SAME logic Convex ran server-side for `getTable`
 * reactivity, but driven by broadcast events instead of a re-query.
 *
 * Pure: no Supabase, no Effect, no DOM, no clock. This makes it trivially unit
 * testable (one assertion per event type) and lets W4 call it from a react-query
 * cache updater without any side effects.
 *
 * Idempotency / ordering: each handler is written so a duplicate or out-of-order
 * delivery converges — an upsert replaces by key, an insert de-dupes by id, a
 * delete is a no-op when the target is already gone. Broadcast is at-least-once
 * and unordered, so this matters for correctness under reconnect/resubscribe.
 */

import type {
  GridChangeEvent,
  GridEventCell,
  GridSnapshot,
} from "./events.js";

/** Replace-or-append a cell by its (rowId, columnId) key. */
const upsertCell = (
  cells: readonly GridEventCell[],
  next: GridEventCell,
): readonly GridEventCell[] => {
  const idx = cells.findIndex(
    (c) => c.rowId === next.rowId && c.columnId === next.columnId,
  );
  if (idx === -1) return [...cells, next];
  const copy = cells.slice();
  copy[idx] = next;
  return copy;
};

/**
 * Apply one grid change event to a snapshot, returning the next snapshot.
 *
 * A `null` snapshot (table not loaded / already deleted) is passed through
 * unchanged for every event EXCEPT it cannot be revived — a client must hold a
 * loaded snapshot before live patches apply. A `table.delete` collapses the
 * snapshot to `null`.
 */
export const applyGridEvent = (
  snapshot: GridSnapshot | null,
  event: GridChangeEvent,
): GridSnapshot | null => {
  if (snapshot === null) return null;

  switch (event.type) {
    case "cell.upsert":
      return { ...snapshot, cells: upsertCell(snapshot.cells, event.cell) };

    case "row.insert": {
      // De-dupe the row by id (at-least-once delivery), then merge any cells
      // that arrived with it (bulk import) via the same keyed upsert.
      const rows = snapshot.rows.some((r) => r._id === event.row._id)
        ? snapshot.rows
        : [...snapshot.rows, event.row];
      let cells = snapshot.cells;
      for (const c of event.cells) cells = upsertCell(cells, c);
      return { ...snapshot, rows, cells };
    }

    case "row.delete":
      return {
        ...snapshot,
        rows: snapshot.rows.filter((r) => r._id !== event.rowId),
        // Cascade: drop the deleted row's cells (mirrors the FK ON DELETE).
        cells: snapshot.cells.filter((c) => c.rowId !== event.rowId),
      };

    case "column.insert": {
      const columns = snapshot.columns.some((c) => c._id === event.column._id)
        ? snapshot.columns
        : [...snapshot.columns, event.column];
      return { ...snapshot, columns };
    }

    case "column.delete":
      return {
        ...snapshot,
        columns: snapshot.columns.filter((c) => c._id !== event.columnId),
        // Cascade: drop the deleted column's cells (mirrors the FK ON DELETE).
        cells: snapshot.cells.filter((c) => c.columnId !== event.columnId),
      };

    case "table.insert":
      // A sibling table was created — a `getTable` snapshot for THIS table is
      // unaffected (the list view, not the grid, reacts to this event).
      return snapshot;

    case "table.delete":
      // The viewed table is gone — collapse to the "no longer exists" sentinel.
      return event.tableId === snapshot.table._id ? null : snapshot;
  }
};
