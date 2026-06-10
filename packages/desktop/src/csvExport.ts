/**
 * CSV export (pure, writer-agnostic).
 *
 * Turns a {@link FullTable} into an RFC-4180 CSV string. The export only emits
 * "mapped" scalar values — a cell exports its text only when it holds a plain
 * done value that ISN'T an object/array. Anything the grid collapses to a pill
 * (JSON objects, arrays / multiple items), plus errors and empty/pending cells,
 * exports as a BLANK field. So the CSV mirrors exactly the flat, single-value
 * data the user mapped into each column; structured cells are intentionally
 * left empty rather than dumped as raw JSON.
 *
 * The string-building is pure (unit-tested with plain table fixtures). Only
 * {@link downloadCsv} touches the DOM.
 */

import type { Cell, FullTable } from "./api";

/**
 * The value a single cell contributes to the CSV. Empty string unless the cell
 * is a `done` scalar (string/number/boolean). Objects/arrays — i.e. a JSON blob
 * or multiple items — and any non-`done` cell export blank.
 */
export function cellToCsvValue(cell: Cell | undefined): string {
  if (!cell || cell.status !== "done") return "";
  const v = cell.value;
  if (v === null || v === undefined) return "";
  // Objects and arrays are the "JSON inside / multiple items" case → blank.
  if (typeof v === "object") return "";
  return String(v);
}

/**
 * RFC-4180 field escaping: wrap in double quotes (doubling any embedded quote)
 * when the value contains a comma, quote, CR or LF; otherwise return as-is.
 */
export function escapeCsvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Serialize the whole table to CSV: a header row of column names followed by
 * one row per table row, every column included (in display order) with mapped
 * scalars only. Rows are joined with CRLF per RFC-4180.
 */
export function tableToCsv(table: FullTable): string {
  const cols = table.columns;
  const header = cols.map((c) => escapeCsvField(c.name)).join(",");
  const body = table.rows.map((row) =>
    cols.map((c) => escapeCsvField(cellToCsvValue(row.cells[c.id]))).join(","),
  );
  return [header, ...body].join("\r\n");
}

/** A filesystem-safe `.csv` filename derived from the table name. */
export function csvFilename(tableName: string): string {
  const base =
    tableName
      .trim()
      .replace(/[^\w.-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "table";
  return `${base}.csv`;
}

/**
 * Trigger a browser download of the CSV. Prepends a UTF-8 BOM so Excel opens
 * non-ASCII content with the right encoding. Works in the Tauri webview.
 */
export function downloadCsv(filename: string, csv: string): void {
  const BOM = String.fromCharCode(0xfeff);
  const blob = new Blob([BOM + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
