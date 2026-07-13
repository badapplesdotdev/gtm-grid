/**
 * Test-only in-memory {@link GridStoreShape} double.
 *
 * The engine is always cloud-store-backed: it reads/writes grid data through an
 * injected {@link GridStoreShape}, never a concrete `Db`. For unit tests that
 * exercise `runColumn` / `dispatch` we want a cheap synchronous store with no
 * SQLite file and no network — this fake implements the full `GridStoreShape`
 * interface over plain `Map`s, so the same engine run path drives it exactly as
 * it would the real cloud store.
 *
 * Construct one with {@link makeMemoryStore}, then seed it with `addColumn` /
 * `addRow` / `setCellSync` / `addCredential` helpers before building the engine.
 */

import { Effect } from "effect";
import {
  GridStoreError,
  type CellPatch,
  type GridStoreShape,
} from "./store.js";
import type { Cell, CellStatus, Column, Credential, Row } from "./types.js";

/** A seedable in-memory grid store plus a few sync helpers for tests. */
export interface MemoryStore extends GridStoreShape {
  /** Add a column (returns it). Ordered by insertion within a table. */
  addColumn: (col: Partial<Column> & { id: string; table_id: string; name: string }) => Column;
  /** Add a row (returns it). Ordered by insertion within a table. */
  addRow: (row: { id: string; table_id: string }) => Row;
  /** Set a cell synchronously (test seeding — bypasses the Effect channel). */
  setCellSync: (rowId: string, columnId: string, patch: CellPatch) => void;
  /** Register a decrypted credential for a provider. */
  addCredential: (provider: string, cred: Credential) => void;
  /** Read a cell synchronously (assertions). */
  readCell: (rowId: string, columnId: string) => Cell | undefined;
}

const cellKey = (rowId: string, columnId: string): string => `${rowId}:${columnId}`;

/** Build an in-memory {@link GridStoreShape} for tests. */
export function makeMemoryStore(): MemoryStore {
  const columns = new Map<string, Column>();
  const columnOrder: string[] = [];
  const rows = new Map<string, Row>();
  const rowOrder: string[] = [];
  const cells = new Map<string, Cell>();
  const creds = new Map<string, Credential>();

  const ok = <A>(value: A): Effect.Effect<A, GridStoreError> => Effect.succeed(value);

  const addColumn: MemoryStore["addColumn"] = (input) => {
    const col: Column = {
      id: input.id,
      table_id: input.table_id,
      name: input.name,
      type: input.type ?? "text",
      kind: input.kind ?? "manual",
      provider: input.provider ?? null,
      method: input.method ?? null,
      code: input.code ?? null,
      params: input.params ?? {},
      condition: input.condition ?? null,
      position: input.position ?? columnOrder.length,
      created_at: input.created_at ?? Date.now(),
    };
    columns.set(col.id, col);
    columnOrder.push(col.id);
    return col;
  };

  const addRow: MemoryStore["addRow"] = (input) => {
    const row: Row = {
      id: input.id,
      table_id: input.table_id,
      position: rowOrder.length,
      created_at: Date.now(),
    };
    rows.set(row.id, row);
    rowOrder.push(row.id);
    return row;
  };

  const setCellSync: MemoryStore["setCellSync"] = (rowId, columnId, patch) => {
    const prev = cells.get(cellKey(rowId, columnId));
    const next: Cell = {
      row_id: rowId,
      column_id: columnId,
      value: patch.value !== undefined ? patch.value : (prev?.value ?? null),
      status: (patch.status ?? prev?.status ?? "empty") as CellStatus,
      error: patch.error !== undefined ? patch.error : (prev?.error ?? null),
      updated_at: Date.now(),
      ran_at: patch.ranAt !== undefined ? patch.ranAt : (prev?.ran_at ?? null),
      run_ms: patch.runMs !== undefined ? patch.runMs : (prev?.run_ms ?? null),
      raw: patch.raw !== undefined ? patch.raw : prev?.raw,
    };
    cells.set(cellKey(rowId, columnId), next);
  };

  return {
    getColumn: (columnId) => ok(columns.get(columnId)),
    listColumns: (tableId) =>
      ok(columnOrder.map((id) => columns.get(id)!).filter((c) => c.table_id === tableId)),
    listRows: (tableId) =>
      ok(rowOrder.map((id) => rows.get(id)!).filter((r) => r.table_id === tableId)),
    rowCells: (rowId) => {
      const out = new Map<string, Cell>();
      for (const cell of cells.values()) {
        if (cell.row_id === rowId) out.set(cell.column_id, cell);
      }
      return ok(out);
    },
    getCell: (rowId, columnId) => ok(cells.get(cellKey(rowId, columnId))),
    setCell: (rowId, columnId, patch) => {
      setCellSync(rowId, columnId, patch);
      return ok(undefined);
    },
    getCredential: (provider) => ok(creds.get(provider)),

    addColumn,
    addRow,
    setCellSync,
    addCredential: (provider, cred) => {
      creds.set(provider, cred);
    },
    readCell: (rowId, columnId) => cells.get(cellKey(rowId, columnId)),
  };
}
