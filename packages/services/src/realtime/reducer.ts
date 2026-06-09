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
 *
 * O(1) cell upserts: the public {@link GridSnapshot} keeps `cells` as a flat
 * array (the cache/`getTable` contract is unchanged), but internally each cells
 * array is paired with a lazily-built INDEX — a `Map` keyed `${rowId}:${columnId}`
 * → cell — cached in a module-level {@link WeakMap}. An upsert therefore does an
 * O(1) keyed lookup (no `findIndex`) and copies ONLY the touched entry, so every
 * untouched cell object keeps its referential identity (which lets the desktop
 * view rebuild only the changed row). The index is carried forward onto the next
 * cells array so a stream of upserts stays O(1) per event.
 */

import type {
  GridChangeEvent,
  GridEventCell,
  GridSnapshot,
} from "./events.js";

/** The (rowId, columnId) key a cell is stored under in the cell index. */
const cellKey = (rowId: string, columnId: string): string =>
  `${rowId}:${columnId}`;

/**
 * Per-cells-array index: `${rowId}:${columnId}` → array position. Keyed by the
 * cells array instance in a `WeakMap` so it is built at most once per array and
 * is garbage collected with it. Lets {@link upsertCell} resolve both existence
 * AND the slot to overwrite in O(1) (no linear `findIndex`), while the public
 * snapshot still exposes a flat `cells` array.
 */
const cellIndexCache = new WeakMap<
  readonly GridEventCell[],
  ReadonlyMap<string, number>
>();

/** Build (or reuse the cached) `${rowId}:${columnId}` → position index. */
const cellIndex = (
  cells: readonly GridEventCell[],
): ReadonlyMap<string, number> => {
  const cached = cellIndexCache.get(cells);
  if (cached !== undefined) return cached;
  const index = new Map<string, number>();
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    index.set(cellKey(c.rowId, c.columnId), i);
  }
  cellIndexCache.set(cells, index);
  return index;
};

/**
 * Replace-or-append a cell by its (rowId, columnId) key in O(1).
 *
 * Looks the key up in the cells array's index (built once, then cached): on a
 * hit it copies the array and overwrites ONLY the matching slot (every other
 * cell object is carried over by reference); on a miss it appends. Either way
 * the result array is paired with an updated index in the cache so the next
 * upsert on the result is O(1) too.
 */
const upsertCell = (
  cells: readonly GridEventCell[],
  next: GridEventCell,
): readonly GridEventCell[] => {
  const key = cellKey(next.rowId, next.columnId);
  const index = cellIndex(cells);
  const slot = index.get(key);

  if (slot === undefined) {
    // Append: clone the index (the source array must keep its OWN intact index)
    // and register the new key→position so the result array stays O(1) too.
    const result = [...cells, next];
    const nextIndex = new Map(index);
    nextIndex.set(key, result.length - 1);
    cellIndexCache.set(result, nextIndex);
    return result;
  }

  if (cells[slot] === next) return cells; // identical reference — no-op
  // In-place replace: the key→position mapping is IDENTICAL between source and
  // result (same length, same positions), so the SAME index applies to both —
  // reuse it by reference (O(1), no Map clone). This is the steady-state path
  // for an enrichment stream (running → done on existing cells).
  const result = cells.slice();
  result[slot] = next;
  cellIndexCache.set(result, index);
  return result;
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
