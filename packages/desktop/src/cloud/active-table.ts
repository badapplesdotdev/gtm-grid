/**
 * Resolve the "active table" hint handed to the agent (its preamble's "Active
 * table" section + the `context.tableName` in the chat request).
 *
 * The subtlety this exists to handle: `cloudTableId` is set SYNCHRONOUSLY — by the
 * auto-default-on-open effect or a manual sidebar click — but the *fully loaded*
 * table (with columns) only arrives after a separate paged fetch resolves. If we
 * sourced the hint solely from that paged fetch, a goal sent in the window right
 * after the app opens onto a default table would carry `cloud.tableId` (the MCP's
 * hard default) but NO `tableName`, so the preamble drops its "Active table"
 * section and the agent — not knowing which table it's on — spins up a brand-new
 * one instead of using the table in view.
 *
 * Fix: prefer the fully-loaded paged table (it has columns), but fall back to the
 * name from the already-loaded tables LIST (which is in hand the instant a table is
 * selected). The result is a stable hint the moment `cloudTableId` is set.
 */
export interface ActiveTableHint {
  /** Human-readable table name the agent sees ("operate on this one"). */
  name: string;
  /** Column names, or `[]` until the paged fetch resolves (the agent calls `get_table`). */
  columns: string[];
}

/** Minimal shape of an entry in the loaded tables list (`useCloudTables`). */
export interface ActiveTableListEntry {
  readonly _id: string;
  readonly name: string;
}

/** Minimal shape of the paged active table once its fetch resolves. */
export interface ActiveTablePaged {
  readonly name: string;
  readonly columns: ReadonlyArray<{ readonly name: string }>;
}

export function resolveActiveTable(
  cloudTableId: string | null,
  pagedTable: ActiveTablePaged | null | undefined,
  tablesList: ReadonlyArray<ActiveTableListEntry> | null | undefined,
): ActiveTableHint | null {
  // Prefer the fully-loaded paged table; otherwise borrow the name from the list so
  // the hint is non-null the instant a table is selected (before the paged fetch).
  const name =
    pagedTable?.name ??
    (cloudTableId ? tablesList?.find((t) => t._id === cloudTableId)?.name ?? null : null);
  if (!name) return null;
  return { name, columns: pagedTable?.columns.map((c) => c.name) ?? [] };
}
