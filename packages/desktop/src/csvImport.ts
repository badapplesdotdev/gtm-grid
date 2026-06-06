/**
 * CSV import orchestrator (writer-agnostic).
 *
 * Given the reviewed columns + body rows from the import UI, this drives the
 * actual creation against a {@link ImportWriter}: create the table, create each
 * column (capturing the returned column id), then push the rows in chunks as
 * `{ columnId: value }` maps. The two writers (local sidecar / cloud Convex) plug
 * the same interface in, so this logic is shared and unit-tested with an
 * in-memory writer — no UI, no network.
 *
 * Rows are pre-projected to the included columns in order (so `rows[r][c]` lines
 * up with `columns[c]`). Empty values are skipped so the cell stays empty.
 */

import type { CsvColumnType } from "@gtmgrid/cloud";

/** A reviewed column to create (included columns only, in display order). */
export interface ImportColumn {
  readonly name: string;
  readonly type: CsvColumnType;
}

/** The reviewed import payload produced by the modal's review stage. */
export interface ImportTableInput {
  readonly name: string;
  readonly columns: readonly ImportColumn[];
  /** Body rows; each is values for `columns` in the same order. */
  readonly rows: readonly string[][];
}

/**
 * The backend seam. Local and cloud each implement this over their own APIs.
 * `addRowsChunk` receives `{ columnId: value }` maps and must create one row per
 * map with its cells. Returns nothing; throws to abort the import.
 */
export interface ImportWriter {
  createTable(name: string): Promise<string>;
  addColumn(
    tableId: string,
    col: { name: string; type: CsvColumnType },
  ): Promise<string>;
  addRowsChunk(
    tableId: string,
    rows: Array<Record<string, unknown>>,
  ): Promise<void>;
}

export interface ImportProgress {
  readonly phase: "columns" | "rows";
  readonly done: number;
  readonly total: number;
}

export interface ImportResult {
  readonly tableId: string;
  readonly rowCount: number;
  readonly columnCount: number;
}

export const DEFAULT_CHUNK_SIZE = 500;

/** Treat blank-ish values as empty so the cell is left unset. */
const isEmpty = (v: unknown): boolean =>
  v === "" || v === null || v === undefined;

/**
 * Run the import. Creates the table + columns, then writes rows in chunks,
 * reporting progress. Resolves with the new table id and counts; rejects (and
 * stops) if any writer call throws — e.g. the cloud writer's quota guard.
 */
export async function importTable(
  input: ImportTableInput,
  writer: ImportWriter,
  opts: {
    chunkSize?: number;
    onProgress?: (p: ImportProgress) => void;
  } = {},
): Promise<ImportResult> {
  const chunkSize = Math.max(1, opts.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const onProgress = opts.onProgress ?? (() => {});

  const tableId = await writer.createTable(input.name);

  // Create columns, capturing each id to key cells by column id (not header).
  const columnIds: string[] = [];
  for (let c = 0; c < input.columns.length; c++) {
    const col = input.columns[c];
    const id = await writer.addColumn(tableId, { name: col.name, type: col.type });
    columnIds.push(id);
    onProgress({ phase: "columns", done: c + 1, total: input.columns.length });
  }

  // Build `{ columnId: value }` maps for every body row (skip empty cells).
  const rowMaps: Array<Record<string, unknown>> = input.rows.map((row) => {
    const map: Record<string, unknown> = {};
    for (let c = 0; c < columnIds.length; c++) {
      const value = row[c];
      if (!isEmpty(value)) map[columnIds[c]] = value;
    }
    return map;
  });

  // Push in chunks so a big import stays within mutation/request limits.
  let written = 0;
  for (let i = 0; i < rowMaps.length; i += chunkSize) {
    const chunk = rowMaps.slice(i, i + chunkSize);
    await writer.addRowsChunk(tableId, chunk);
    written += chunk.length;
    onProgress({ phase: "rows", done: written, total: rowMaps.length });
  }

  return {
    tableId,
    rowCount: rowMaps.length,
    columnCount: input.columns.length,
  };
}
