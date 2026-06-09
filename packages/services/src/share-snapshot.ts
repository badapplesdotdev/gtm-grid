/**
 * Table-share SNAPSHOT format — the portable, secret-free serialization of a
 * cloud table that backs the "share a table via URL" feature.
 *
 * A share link freezes a table into one of these snapshots at creation time, so
 * later edits to the source table never change what a recipient sees. The SAME
 * snapshot drives three sinks: the public read-only `/share/<token>` view, the
 * authenticated "clone into my project" path (`ShareService.cloneFromSnapshot`),
 * and the MCP `import_table_from_share` tool that rebuilds the table locally.
 *
 * Design rules:
 *   - SECRET-FREE BY CONSTRUCTION. A snapshot is built from a FIXED allowlist of
 *     column fields (name/type/kind/provider/method/code/params) over the grid
 *     read — which never contains credentials (those live in the separate,
 *     encrypted `credentials` table). `params` carries the `{{Column Name}}`
 *     input templates verbatim; they are safe to share and the recipient brings
 *     their OWN connector credentials.
 *   - POSITION-INDEXED, NOT id-indexed. Cells reference their row/column by ARRAY
 *     INDEX, never by uuid: ids are not portable across workspaces, and a rebuild
 *     assigns fresh ids. `{{Column Name}}` params join by name, which survives a
 *     rebuild as long as column names are preserved.
 *   - Cell `status`/`error` are DROPPED. A clone re-runs function columns with the
 *     recipient's own credentials, so transient run state is meaningless.
 *   - DEPENDENCY-FREE. This module imports nothing, so it is reused verbatim by
 *     `@gtmgrid/services` (Effect/Drizzle) AND the `@gtmgrid/mcp` server (plain
 *     Node, no DB) as the single definition of the format + its validator.
 */

/** Bump when the snapshot shape changes incompatibly. */
export const SHARE_SNAPSHOT_VERSION = 1;

/** Max serialized snapshot size (~5 MB), enforced when a share is created. */
export const SHARE_SNAPSHOT_MAX_BYTES = 5_000_000;

/** Defensive caps enforced by {@link validateSnapshot} on the rebuild side. */
const MAX_COLUMNS = 500;
const MAX_ROWS = 100_000;
const MAX_CELLS = 1_000_000;

/** Column value types — mirrors the cloud `columnType` enum. */
export type SnapshotColumnType = "text" | "number" | "boolean" | "date" | "json";
const COLUMN_TYPES: readonly string[] = [
  "text",
  "number",
  "boolean",
  "date",
  "json",
];

/** Column kinds — mirrors the cloud `columnKind` enum. */
export type SnapshotColumnKind = "manual" | "function";
const COLUMN_KINDS: readonly string[] = ["manual", "function"];

/** One column's portable definition (no ids, no secrets). */
export interface SnapshotColumn {
  readonly name: string;
  readonly type: SnapshotColumnType;
  readonly kind: SnapshotColumnKind;
  /** Connector provider for a function column (e.g. "ai"); null for manual. */
  readonly provider: string | null;
  /** Connector method (e.g. "generate"); null for manual/code columns. */
  readonly method: string | null;
  /** Custom QuickJS body for a code column; null otherwise. */
  readonly code: string | null;
  /** Input mapping ({{Column Name}} templates). Shared verbatim. */
  readonly params: unknown;
}

/** A single non-empty cell, addressed by ROW + COLUMN index. */
export interface SnapshotCell {
  readonly row: number;
  readonly column: number;
  readonly value: unknown;
}

/** The full frozen table snapshot stored against a share token. */
export interface TableShareSnapshot {
  readonly version: number;
  readonly table: { readonly name: string };
  readonly columns: readonly SnapshotColumn[];
  /** Total row count (every cell references a row index < this). */
  readonly rows: number;
  readonly cells: readonly SnapshotCell[];
}

/**
 * The structural shape {@link snapshotFromFullGrid} reads — exactly the cloud
 * `GridService.getTable` `FullGrid` (which satisfies this), declared inline so
 * this module stays import-free.
 */
export interface SnapshotSourceGrid {
  readonly table: { readonly name: string };
  readonly columns: readonly {
    readonly _id: string;
    readonly name: string;
    readonly type: string;
    readonly kind: string;
    readonly provider: string | null;
    readonly method: string | null;
    readonly code: string | null;
    readonly params: unknown;
  }[];
  readonly rows: readonly { readonly _id: string }[];
  readonly cells: readonly {
    readonly rowId: string;
    readonly columnId: string;
    readonly value: unknown;
    readonly status: string;
    readonly error: string | null;
  }[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asColumnType = (t: string): SnapshotColumnType =>
  COLUMN_TYPES.includes(t) ? (t as SnapshotColumnType) : "text";

const asColumnKind = (k: string): SnapshotColumnKind =>
  k === "function" ? "function" : "manual";

/**
 * Build a secret-free {@link TableShareSnapshot} from a grid read. Cells are
 * re-keyed from (rowId,columnId) to (rowIndex,columnIndex); empty cells (null/
 * undefined value) and any cell whose row/column is unknown are dropped, along
 * with `status`/`error`.
 */
export function snapshotFromFullGrid(
  grid: SnapshotSourceGrid,
): TableShareSnapshot {
  const columnIndex = new Map<string, number>();
  grid.columns.forEach((c, i) => columnIndex.set(c._id, i));
  const rowIndex = new Map<string, number>();
  grid.rows.forEach((r, i) => rowIndex.set(r._id, i));

  const columns: SnapshotColumn[] = grid.columns.map((c) => ({
    name: c.name,
    type: asColumnType(c.type),
    kind: asColumnKind(c.kind),
    provider: c.provider ?? null,
    method: c.method ?? null,
    code: c.code ?? null,
    params: c.params ?? {},
  }));

  const cells: SnapshotCell[] = [];
  for (const cell of grid.cells) {
    if (cell.value === null || cell.value === undefined) continue;
    const row = rowIndex.get(cell.rowId);
    const column = columnIndex.get(cell.columnId);
    if (row === undefined || column === undefined) continue;
    cells.push({ row, column, value: cell.value });
  }

  return {
    version: SHARE_SNAPSHOT_VERSION,
    table: { name: grid.table.name },
    columns,
    rows: grid.rows.length,
    cells,
  };
}

/** Result of {@link validateSnapshot}: a narrowed snapshot or a reason. */
export type SnapshotValidation =
  | { readonly ok: true; readonly value: TableShareSnapshot }
  | { readonly ok: false; readonly error: string };

/** Coerce a nullable-string field, or signal a type error. */
const strOrNull = (
  v: unknown,
): { readonly ok: true; readonly value: string | null } | { readonly ok: false } =>
  v === null || v === undefined
    ? { ok: true, value: null }
    : typeof v === "string"
      ? { ok: true, value: v }
      : { ok: false };

/**
 * Validate + narrow an untrusted value (a stored snapshot, a forged payload, or
 * one fetched over HTTP by the MCP tool) to a {@link TableShareSnapshot}.
 * Enforces the version, the column enums, index bounds on every cell, and the
 * defensive size caps, so a malformed payload can never drive a rebuild. Pure
 * (no Effect, no throw) so the Effect service and the plain-Node MCP tool share
 * one definition.
 */
export function validateSnapshot(input: unknown): SnapshotValidation {
  if (!isRecord(input)) {
    return { ok: false, error: "Snapshot must be an object." };
  }
  if (input.version !== SHARE_SNAPSHOT_VERSION) {
    return {
      ok: false,
      error: `Unsupported snapshot version: ${String(input.version)}.`,
    };
  }
  if (!isRecord(input.table) || typeof input.table.name !== "string") {
    return { ok: false, error: "Snapshot table.name must be a string." };
  }
  if (!Array.isArray(input.columns)) {
    return { ok: false, error: "Snapshot columns must be an array." };
  }
  if (input.columns.length > MAX_COLUMNS) {
    return { ok: false, error: `Too many columns (max ${MAX_COLUMNS}).` };
  }

  const columns: SnapshotColumn[] = [];
  for (const raw of input.columns) {
    if (!isRecord(raw) || typeof raw.name !== "string") {
      return { ok: false, error: "Each column needs a string name." };
    }
    if (typeof raw.type !== "string" || !COLUMN_TYPES.includes(raw.type)) {
      return { ok: false, error: `Invalid column type: ${String(raw.type)}.` };
    }
    if (typeof raw.kind !== "string" || !COLUMN_KINDS.includes(raw.kind)) {
      return { ok: false, error: `Invalid column kind: ${String(raw.kind)}.` };
    }
    const provider = strOrNull(raw.provider);
    const method = strOrNull(raw.method);
    const code = strOrNull(raw.code);
    if (!provider.ok || !method.ok || !code.ok) {
      return {
        ok: false,
        error: "Column provider/method/code must be a string or null.",
      };
    }
    columns.push({
      name: raw.name,
      type: raw.type as SnapshotColumnType,
      kind: raw.kind as SnapshotColumnKind,
      provider: provider.value,
      method: method.value,
      code: code.value,
      params: raw.params ?? {},
    });
  }

  if (
    typeof input.rows !== "number" ||
    !Number.isInteger(input.rows) ||
    input.rows < 0
  ) {
    return { ok: false, error: "Snapshot rows must be a non-negative integer." };
  }
  if (input.rows > MAX_ROWS) {
    return { ok: false, error: `Too many rows (max ${MAX_ROWS}).` };
  }
  if (!Array.isArray(input.cells)) {
    return { ok: false, error: "Snapshot cells must be an array." };
  }
  if (input.cells.length > MAX_CELLS) {
    return { ok: false, error: `Too many cells (max ${MAX_CELLS}).` };
  }

  const rowCount = input.rows;
  const cells: SnapshotCell[] = [];
  for (const raw of input.cells) {
    if (!isRecord(raw)) {
      return { ok: false, error: "Each cell must be an object." };
    }
    const { row, column } = raw;
    if (
      typeof row !== "number" ||
      !Number.isInteger(row) ||
      row < 0 ||
      row >= rowCount
    ) {
      return { ok: false, error: "Cell row index out of bounds." };
    }
    if (
      typeof column !== "number" ||
      !Number.isInteger(column) ||
      column < 0 ||
      column >= columns.length
    ) {
      return { ok: false, error: "Cell column index out of bounds." };
    }
    cells.push({ row, column, value: raw.value });
  }

  return {
    ok: true,
    value: {
      version: SHARE_SNAPSHOT_VERSION,
      table: { name: input.table.name },
      columns,
      rows: rowCount,
      cells,
    },
  };
}

/** Distinct connector providers referenced by a snapshot's function columns. */
export function referencedProviders(
  snapshot: TableShareSnapshot,
): readonly string[] {
  const set = new Set<string>();
  for (const c of snapshot.columns) {
    if (c.kind === "function" && c.provider) set.add(c.provider);
  }
  return [...set];
}
