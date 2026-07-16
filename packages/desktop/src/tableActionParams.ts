// Pure param assembly for the cross-table column editors (table.push /
// table.lookup in ColumnEditPanel). Kept out of the component so the exact
// "what gets saved" contract — empty mappings dropped, engine defaults omitted,
// unknown agent-set keys preserved — is unit-testable without rendering.
//
// Both builders start from a copy of the column's ORIGINAL params (like the
// panel's other buildPatch branches) so keys the editor doesn't know about
// survive a human edit of an agent-authored column.

/** The push editor's working state (see TablePushForm in ColumnEditPanel). */
export interface TablePushDraft {
  /** Target table id (preferred) or exact name. */
  targetTable: string;
  mode: "upsert" | "append";
  /** Target column NAME to dedupe on (upsert only). */
  keyColumn: string;
  /** The dedupe probe, usually a "{{Column}}" template (upsert only). */
  keyValue: string;
  autoRunTarget: boolean;
}

/** Assemble `table.push` params from the editor draft over the original params.
 *  Push is webhook-style: the WHOLE row is delivered and the TARGET table's
 *  push-connection mapping decides which fields fill which columns — so there
 *  is no sender-side `mapping`/`createMissingColumns` anymore (legacy keys are
 *  scrubbed from the original params on save). */
export function buildTablePushParams(
  base: Record<string, unknown>,
  d: TablePushDraft,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  // v1 leftovers — sender-side mapping moved to the target's push connection.
  delete out.mapping;
  delete out.createMissingColumns;

  out.targetTable = d.targetTable.trim();
  out.mode = d.mode;

  if (d.mode === "upsert") {
    if (d.keyColumn.trim()) out.keyColumn = d.keyColumn.trim();
    else delete out.keyColumn;
    if (d.keyValue.trim()) out.keyValue = d.keyValue;
    else delete out.keyValue;
  } else {
    // Append never dedupes — a stale key pair must not survive the mode switch.
    delete out.keyColumn;
    delete out.keyValue;
  }

  if (d.autoRunTarget) out.autoRunTarget = true;
  else delete out.autoRunTarget;

  return out;
}

/** The lookup editor's working state (see TableLookupForm in ColumnEditPanel). */
export interface TableLookupDraft {
  /** Target table id (preferred) or exact name. */
  targetTable: string;
  /** Target column NAME to match against. */
  matchColumn: string;
  /** The probe value, usually a "{{Column}}" template. */
  matchValue: string;
  /** Selected target column names to return; empty = all columns. */
  returnColumns: string[];
  /** Every target column name (when the schema is known) — selecting all of
   *  them is the same as "all", so the param is omitted. */
  allColumnNames: string[];
  multiple: "first" | "all" | "count";
  caseInsensitive: boolean;
  notFound: "null" | "error";
}

/** Assemble `table.lookup` params from the editor draft over the original
 *  params. Engine defaults (first / case-sensitive / null-on-miss / all
 *  columns) are OMITTED so the stored config stays minimal. */
export function buildTableLookupParams(
  base: Record<string, unknown>,
  d: TableLookupDraft,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  out.targetTable = d.targetTable.trim();
  out.matchColumn = d.matchColumn.trim();
  out.matchValue = d.matchValue;

  const sel = d.returnColumns.filter((n) => n.trim() !== "");
  const coversAll =
    d.allColumnNames.length > 0 && d.allColumnNames.every((n) => sel.includes(n));
  if (sel.length === 0 || coversAll) delete out.return;
  else out.return = sel;

  if (d.multiple === "first") delete out.multiple;
  else out.multiple = d.multiple;
  if (d.caseInsensitive) out.caseInsensitive = true;
  else delete out.caseInsensitive;
  if (d.notFound === "error") out.notFound = "error";
  else delete out.notFound;

  return out;
}
