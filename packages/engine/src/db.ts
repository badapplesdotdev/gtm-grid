// SQLite data layer (better-sqlite3). One .db file per project, mirroring Revcode.

// `better-sqlite3` is a native addon. We import only its TYPES at module scope so
// that merely importing this file (and therefore `@gtmgrid/engine`) does NOT load
// the native `.node` binary — the cloud path never touches SQLite. The runtime
// constructor is lazily `require`d inside the `Db` constructor, the single place
// that actually opens a database.
import type DatabaseT from "better-sqlite3";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { encryptSecrets, decryptSecrets } from "./crypto.js";
import type {
  Cell,
  CellStatus,
  Column,
  ColumnKind,
  ColumnType,
  Credential,
  CredentialScope,
  Folder,
  Row,
  Table,
} from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS tables (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS columns (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  kind TEXT NOT NULL DEFAULT 'manual',
  provider TEXT,
  method TEXT,
  code TEXT,
  params TEXT NOT NULL DEFAULT '{}',
  condition TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rows (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cells (
  row_id TEXT NOT NULL REFERENCES rows(id) ON DELETE CASCADE,
  column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
  value TEXT,
  status TEXT NOT NULL DEFAULT 'empty',
  error TEXT,
  updated_at INTEGER,
  PRIMARY KEY (row_id, column_id)
);

CREATE TABLE IF NOT EXISTS extensions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  manifest TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  extension_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'local',
  name TEXT NOT NULL,
  credentials_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

interface ColumnRow {
  id: string;
  table_id: string;
  name: string;
  type: string;
  kind: string;
  provider: string | null;
  method: string | null;
  code: string | null;
  params: string;
  condition: string | null;
  position: number;
  created_at: number;
}

interface CellRow {
  row_id: string;
  column_id: string;
  value: string | null;
  status: string;
  error: string | null;
  updated_at: number | null;
  ran_at: number | null;
  run_ms: number | null;
  raw: string | null;
}

export class Db {
  readonly raw: DatabaseT.Database;

  constructor(path: string) {
    // Lazy-load the native better-sqlite3 addon here (the only place a database
    // is opened) so importing this module doesn't pull the `.node` binary. A
    // CJS `require` keeps the synchronous constructor synchronous (a dynamic
    // `import()` would force this to become async and ripple through callers).
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3") as typeof DatabaseT;
    this.raw = new Database(path);
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("foreign_keys = ON");
    this.raw.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Lightweight, idempotent migrations for project .db files created before a column was
   * added. SQLite has no `ADD COLUMN IF NOT EXISTS`, so we run the ALTER and swallow the
   * "duplicate column name" error when the column already exists.
   */
  private migrate(): void {
    for (const sql of [
      "ALTER TABLE columns ADD COLUMN condition TEXT",
      // Per-table deduplication (Clay-style): dedupe_column is the column id to
      // match on (null = off); dedupe_keep is "oldest" | "newest".
      "ALTER TABLE tables ADD COLUMN dedupe_column TEXT",
      "ALTER TABLE tables ADD COLUMN dedupe_keep TEXT",
      // Sidebar folders: which folder a table is filed under (NULL = root).
      "ALTER TABLE tables ADD COLUMN folder_id TEXT",
      // Per-cell run metadata (Clay-style audit trail): when the last run wrote
      // the cell, how long it took, and the raw pre-simplify response (only
      // when it differs from value; size-capped at write time).
      "ALTER TABLE cells ADD COLUMN ran_at INTEGER",
      "ALTER TABLE cells ADD COLUMN run_ms INTEGER",
      "ALTER TABLE cells ADD COLUMN raw TEXT",
    ]) {
      try {
        this.raw.exec(sql);
      } catch (e) {
        if (!/duplicate column name/i.test(e instanceof Error ? e.message : String(e))) throw e;
      }
    }
  }

  close(): void {
    this.raw.close();
  }

  // ---- Tables ----
  createTable(name: string, folderId: string | null = null): Table {
    const t: Table = {
      id: randomUUID(),
      name,
      position: this.nextPos("tables"),
      created_at: Date.now(),
      folder_id: folderId,
    };
    this.raw
      .prepare(`INSERT INTO tables (id, name, position, created_at, folder_id) VALUES (?, ?, ?, ?, ?)`)
      .run(t.id, t.name, t.position, t.created_at, t.folder_id);
    return t;
  }

  listTables(): Table[] {
    return this.raw.prepare(`SELECT * FROM tables ORDER BY position, created_at`).all() as Table[];
  }

  getTable(id: string): Table | undefined {
    return this.raw.prepare(`SELECT * FROM tables WHERE id = ?`).get(id) as Table | undefined;
  }

  /** Resolve a table by id or by exact name (convenience for CLI/MCP callers). */
  resolveTable(idOrName: string): Table | undefined {
    return (
      this.getTable(idOrName) ??
      (this.raw.prepare(`SELECT * FROM tables WHERE name = ?`).get(idOrName) as Table | undefined)
    );
  }

  renameTable(id: string, name: string): void {
    this.raw.prepare(`UPDATE tables SET name = ? WHERE id = ?`).run(name, id);
  }

  /** Delete a table; columns/rows/cells cascade via foreign keys. */
  deleteTable(id: string): void {
    this.raw.prepare(`DELETE FROM tables WHERE id = ?`).run(id);
    this.setFavorite(id, false);
  }

  /**
   * Move a table into a folder (or to the root with `folderId: null`), optionally
   * updating its sort position (callers pass a fractional midpoint to reorder —
   * SQLite's INTEGER affinity stores reals losslessly).
   */
  moveTable(id: string, folderId: string | null, position?: number): void {
    if (position === undefined) {
      this.raw.prepare(`UPDATE tables SET folder_id = ? WHERE id = ?`).run(folderId, id);
    } else {
      this.raw
        .prepare(`UPDATE tables SET folder_id = ?, position = ? WHERE id = ?`)
        .run(folderId, position, id);
    }
  }

  // ---- Folders (sidebar table groups) ----
  createFolder(name: string): Folder {
    const f: Folder = {
      id: randomUUID(),
      name,
      position: this.nextPos("folders"),
      created_at: Date.now(),
    };
    this.raw
      .prepare(`INSERT INTO folders (id, name, position, created_at) VALUES (?, ?, ?, ?)`)
      .run(f.id, f.name, f.position, f.created_at);
    return f;
  }

  listFolders(): Folder[] {
    return this.raw.prepare(`SELECT * FROM folders ORDER BY position, created_at`).all() as Folder[];
  }

  renameFolder(id: string, name: string): void {
    this.raw.prepare(`UPDATE folders SET name = ? WHERE id = ?`).run(name, id);
  }

  /** Delete a folder; its tables are unfiled back to the root, never deleted. */
  deleteFolder(id: string): void {
    this.raw.prepare(`UPDATE tables SET folder_id = NULL WHERE folder_id = ?`).run(id);
    this.raw.prepare(`DELETE FROM folders WHERE id = ?`).run(id);
  }

  // ---- Favorites (pinned tables, stored in meta) ----
  listFavorites(): string[] {
    try {
      return JSON.parse(this.getMeta("favorite_tables") || "[]");
    } catch {
      return [];
    }
  }

  isFavorite(id: string): boolean {
    return this.listFavorites().includes(id);
  }

  setFavorite(id: string, on: boolean): void {
    const set = new Set(this.listFavorites());
    if (on) set.add(id);
    else set.delete(id);
    this.setMeta("favorite_tables", JSON.stringify([...set]));
  }

  // ---- Columns ----
  createColumn(input: {
    tableId: string;
    name: string;
    type?: ColumnType;
    kind?: ColumnKind;
    provider?: string | null;
    method?: string | null;
    code?: string | null;
    params?: Record<string, unknown>;
    condition?: string | null;
  }): Column {
    const col: Column = {
      id: randomUUID(),
      table_id: input.tableId,
      name: input.name,
      type: input.type ?? "text",
      kind: input.kind ?? "manual",
      provider: input.provider ?? null,
      method: input.method ?? null,
      code: input.code ?? null,
      params: input.params ?? {},
      condition: input.condition ?? null,
      position: this.nextPos("columns", "table_id", input.tableId),
      created_at: Date.now(),
    };
    this.raw
      .prepare(
        `INSERT INTO columns (id, table_id, name, type, kind, provider, method, code, params, condition, position, created_at)
         VALUES (@id, @table_id, @name, @type, @kind, @provider, @method, @code, @params, @condition, @position, @created_at)`,
      )
      .run({ ...col, params: JSON.stringify(col.params) });
    return col;
  }

  listColumns(tableId: string): Column[] {
    const rows = this.raw
      .prepare(`SELECT * FROM columns WHERE table_id = ? ORDER BY position, created_at`)
      .all(tableId) as ColumnRow[];
    return rows.map(this.hydrateColumn);
  }

  getColumn(id: string): Column | undefined {
    const r = this.raw.prepare(`SELECT * FROM columns WHERE id = ?`).get(id) as ColumnRow | undefined;
    return r ? this.hydrateColumn(r) : undefined;
  }

  resolveColumn(tableId: string, idOrName: string): Column | undefined {
    const byId = this.getColumn(idOrName);
    if (byId && byId.table_id === tableId) return byId;
    const r = this.raw
      .prepare(`SELECT * FROM columns WHERE table_id = ? AND name = ?`)
      .get(tableId, idOrName) as ColumnRow | undefined;
    return r ? this.hydrateColumn(r) : undefined;
  }

  updateColumn(
    id: string,
    patch: Partial<{
      name: string;
      type: ColumnType;
      kind: ColumnKind;
      provider: string | null;
      method: string | null;
      code: string | null;
      params: Record<string, unknown>;
      condition: string | null;
    }>,
  ): Column | undefined {
    const existing = this.getColumn(id);
    if (!existing) return undefined;
    const next = {
      name: patch.name ?? existing.name,
      type: patch.type ?? existing.type,
      kind: patch.kind ?? existing.kind,
      provider: patch.provider !== undefined ? patch.provider : existing.provider,
      method: patch.method !== undefined ? patch.method : existing.method,
      code: patch.code !== undefined ? patch.code : existing.code,
      params: patch.params ?? existing.params,
      condition: patch.condition !== undefined ? patch.condition : existing.condition,
    };
    this.raw
      .prepare(
        `UPDATE columns SET name=@name, type=@type, kind=@kind, provider=@provider, method=@method, code=@code, params=@params, condition=@condition WHERE id=@id`,
      )
      .run({ id, ...next, params: JSON.stringify(next.params) });
    return this.getColumn(id);
  }

  deleteColumn(id: string): void {
    this.raw.prepare(`DELETE FROM columns WHERE id = ?`).run(id);
  }

  /**
   * Move a column to a new 0-based display index within its table (clamped to the
   * column count). Reindexes the table's columns to a contiguous 0..N-1 order,
   * writing ONLY the columns whose position actually changes, in one transaction.
   * Returns the new column-id order (empty if the column doesn't exist).
   */
  moveColumn(columnId: string, toIndex: number): string[] {
    const col = this.getColumn(columnId);
    if (!col) return [];
    const ordered = this.listColumns(col.table_id);
    const from = ordered.findIndex((c) => c.id === columnId);
    const dest = Math.max(0, Math.min(toIndex, ordered.length - 1));
    const ids = ordered.map((c) => c.id);
    if (from !== -1 && from !== dest) {
      const [moved] = ids.splice(from, 1);
      ids.splice(dest, 0, moved!);
    }
    const stmt = this.raw.prepare(`UPDATE columns SET position = ? WHERE id = ?`);
    this.raw.transaction(() => {
      ids.forEach((id, i) => {
        if (ordered[i]?.id !== id) stmt.run(i, id);
      });
    })();
    return ids;
  }

  private hydrateColumn(r: ColumnRow): Column {
    return {
      ...r,
      type: r.type as ColumnType,
      kind: r.kind as ColumnKind,
      params: JSON.parse(r.params || "{}"),
    };
  }

  // ---- Rows ----
  createRow(tableId: string): Row {
    const row: Row = {
      id: randomUUID(),
      table_id: tableId,
      position: this.nextPos("rows", "table_id", tableId),
      created_at: Date.now(),
    };
    this.raw
      .prepare(`INSERT INTO rows (id, table_id, position, created_at) VALUES (?, ?, ?, ?)`)
      .run(row.id, row.table_id, row.position, row.created_at);
    return row;
  }

  /** Total row count for a table (cheap — no row fetch). */
  countRows(tableId: string): number {
    return (this.raw.prepare(`SELECT COUNT(*) AS n FROM rows WHERE table_id = ?`).get(tableId) as { n: number }).n;
  }

  /**
   * Find rows where every (columnId -> value) in `match` equals the cell value
   * (exact match, with whitespace trim on strings). An empty `match` returns all
   * rows. Bounded by `limit` so a query on a huge table never blows up — this is
   * the agent's "search inside a sheet" primitive (no whole-table pull needed).
   */
  findRows(tableId: string, match: Record<string, unknown>, limit = 100): Row[] {
    const entries = Object.entries(match);
    const cellEq = (a: unknown, b: unknown): boolean => {
      if (typeof a === "string" && typeof b === "string") return a.trim() === b.trim();
      if (typeof a === "string" || typeof b === "string") return String(a ?? "").trim() === String(b ?? "").trim();
      return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    };
    const out: Row[] = [];
    for (const r of this.listRows(tableId)) {
      if (entries.every(([colId, want]) => cellEq(this.getCell(r.id, colId)?.value, want))) {
        out.push(r);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  listRows(tableId: string): Row[] {
    return this.raw
      .prepare(`SELECT * FROM rows WHERE table_id = ? ORDER BY position, created_at`)
      .all(tableId) as Row[];
  }

  deleteRow(rowId: string): void {
    this.raw.prepare(`DELETE FROM rows WHERE id = ?`).run(rowId);
  }

  /**
   * Move a row to a new 0-based display index within its table (clamped).
   * Reindexes to a contiguous order, writing ONLY the rows whose position changes
   * (so moving one row touches just the rows between its old and new slot, not the
   * whole table), in one transaction. Returns the new row-id order (empty if the
   * row doesn't exist).
   */
  moveRow(rowId: string, toIndex: number): string[] {
    const row = this.raw.prepare(`SELECT * FROM rows WHERE id = ?`).get(rowId) as
      | Row
      | undefined;
    if (!row) return [];
    const ordered = this.listRows(row.table_id);
    const from = ordered.findIndex((r) => r.id === rowId);
    const dest = Math.max(0, Math.min(toIndex, ordered.length - 1));
    const ids = ordered.map((r) => r.id);
    if (from !== -1 && from !== dest) {
      const [moved] = ids.splice(from, 1);
      ids.splice(dest, 0, moved!);
    }
    const stmt = this.raw.prepare(`UPDATE rows SET position = ? WHERE id = ?`);
    this.raw.transaction(() => {
      ids.forEach((id, i) => {
        if (ordered[i]?.id !== id) stmt.run(i, id);
      });
    })();
    return ids;
  }

  /** Clear a single cell (back to empty). */
  deleteCell(rowId: string, columnId: string): void {
    this.raw.prepare(`DELETE FROM cells WHERE row_id = ? AND column_id = ?`).run(rowId, columnId);
  }

  // ---- Cells ----
  getCell(rowId: string, columnId: string): Cell | undefined {
    const r = this.raw
      .prepare(`SELECT * FROM cells WHERE row_id = ? AND column_id = ?`)
      .get(rowId, columnId) as CellRow | undefined;
    return r ? this.hydrateCell(r) : undefined;
  }

  setCell(
    rowId: string,
    columnId: string,
    patch: {
      value?: unknown;
      status?: CellStatus;
      error?: string | null;
      ranAt?: number | null;
      runMs?: number | null;
      raw?: unknown;
    },
  ): void {
    const value = patch.value === undefined ? undefined : JSON.stringify(patch.value ?? null);
    // Run metadata is written as a unit: when `ranAt` is present in the patch
    // (the engine's terminal done/error write) ran_at/run_ms/raw are all
    // OVERWRITTEN (raw may overwrite to null — a fresh run clears a stale
    // archive); otherwise (manual edits, status-only writes) all three keep
    // their existing values.
    const setMeta = patch.ranAt !== undefined ? 1 : 0;
    const rawJson = patch.raw === undefined || patch.raw === null ? null : JSON.stringify(patch.raw);
    this.raw
      .prepare(
        `INSERT INTO cells (row_id, column_id, value, status, error, updated_at, ran_at, run_ms, raw)
         VALUES (@row_id, @column_id, @value, @status, @error, @updated_at, @ran_at, @run_ms, @raw)
         ON CONFLICT(row_id, column_id) DO UPDATE SET
           value = COALESCE(@value, cells.value),
           status = COALESCE(@status, cells.status),
           error = @error,
           updated_at = @updated_at,
           ran_at = CASE WHEN @set_meta = 1 THEN @ran_at ELSE cells.ran_at END,
           run_ms = CASE WHEN @set_meta = 1 THEN @run_ms ELSE cells.run_ms END,
           raw    = CASE WHEN @set_meta = 1 THEN @raw    ELSE cells.raw    END`,
      )
      .run({
        row_id: rowId,
        column_id: columnId,
        value: value ?? null,
        status: patch.status ?? null,
        error: patch.error ?? null,
        updated_at: Date.now(),
        ran_at: patch.ranAt ?? null,
        run_ms: patch.runMs ?? null,
        raw: rawJson,
        set_meta: setMeta,
      });
  }

  /** All cells for a row, keyed by column id. */
  rowCells(rowId: string): Map<string, Cell> {
    const rows = this.raw.prepare(`SELECT * FROM cells WHERE row_id = ?`).all(rowId) as CellRow[];
    return new Map(rows.map((r) => [r.column_id, this.hydrateCell(r)]));
  }

  private hydrateCell(r: CellRow): Cell {
    let raw: unknown;
    if (r.raw != null) {
      try {
        raw = JSON.parse(r.raw);
      } catch {
        raw = r.raw; // tolerate a non-JSON archive rather than failing the read
      }
    }
    return {
      row_id: r.row_id,
      column_id: r.column_id,
      value: r.value == null ? null : JSON.parse(r.value),
      status: r.status as CellStatus,
      error: r.error,
      updated_at: r.updated_at,
      ran_at: r.ran_at,
      run_ms: r.run_ms,
      raw,
    };
  }

  // ---- Deduplication (Clay-style: keep a table unique on one column) ----

  /** Current dedup config for a table, or null when off. */
  getTableDedupe(tableId: string): { column: string; keep: "oldest" | "newest" } | null {
    const t = this.getTable(tableId);
    if (!t?.dedupe_column) return null;
    return { column: t.dedupe_column, keep: t.dedupe_keep === "newest" ? "newest" : "oldest" };
  }

  /** Set (or clear, with `null`) the dedup config. */
  setTableDedupe(tableId: string, cfg: { column: string; keep: "oldest" | "newest" } | null): void {
    this.raw
      .prepare(`UPDATE tables SET dedupe_column = ?, dedupe_keep = ? WHERE id = ?`)
      .run(cfg?.column ?? null, cfg?.keep ?? null, tableId);
  }

  /**
   * The exact-match dedup key for a cell value, or null if the row must NOT be
   * deduplicated on it. Mirrors Clay: a blank cell, or a value longer than 200
   * chars, is left alone (never merged away). Exact match — no normalization.
   */
  private dedupeKeyOf(value: unknown): string | null {
    if (value == null) return null;
    const s = (typeof value === "string" ? value : String(value)).trim();
    if (s === "" || s.length > 200) return null;
    return s;
  }

  /**
   * Insert rows (each a `{ columnId: value }` map) into a table, applying the
   * table's dedup config if set. Returns counts. With dedup on:
   *   - keep "oldest": an incoming row whose key already exists is skipped;
   *   - keep "newest": the existing match is deleted and the new row inserted.
   * Runs in ONE transaction. With no dedup config this is a plain bulk insert.
   */
  addRowsDeduped(
    tableId: string,
    rows: Array<Record<string, unknown>>,
  ): { added: number; skipped: number; replaced: number; rowIds: string[] } {
    const cfg = this.getTableDedupe(tableId);
    const rowIds: string[] = [];
    let added = 0;
    let skipped = 0;
    let replaced = 0;

    const insertCells = (cells: Record<string, unknown>): string => {
      const row = this.createRow(tableId);
      for (const [colId, value] of Object.entries(cells)) {
        if (value === "" || value === null || value === undefined) continue;
        this.setCell(row.id, colId, { value, status: "done" });
      }
      return row.id;
    };

    const tx = this.raw.transaction((batch: Array<Record<string, unknown>>) => {
      // Build the surviving-key index from existing rows (only when deduping).
      const index = new Map<string, string>(); // key -> rowId
      if (cfg) {
        for (const r of this.listRows(tableId)) {
          const key = this.dedupeKeyOf(this.getCell(r.id, cfg.column)?.value);
          if (key !== null && !index.has(key)) index.set(key, r.id);
        }
      }
      for (const cells of batch) {
        if (cfg) {
          const key = this.dedupeKeyOf(cells[cfg.column]);
          if (key !== null && index.has(key)) {
            if (cfg.keep === "oldest") {
              skipped++;
              continue; // drop the incoming duplicate
            }
            this.deleteRow(index.get(key)!); // keep newest: existing match goes
            replaced++;
          }
          const id = insertCells(cells);
          rowIds.push(id);
          if (key !== null) index.set(key, id);
          added++;
        } else {
          rowIds.push(insertCells(cells));
          added++;
        }
      }
    });
    tx(rows);
    return { added, skipped, replaced, rowIds };
  }

  /**
   * One-shot sweep: collapse existing duplicate rows by the table's dedup key,
   * keeping the oldest (first) or newest (last) per group. No-op when dedup is
   * off. Used when dedup is turned on and by the manual "Dedupe" button.
   */
  dedupeTable(tableId: string): { deleted: number } {
    const cfg = this.getTableDedupe(tableId);
    if (!cfg) return { deleted: 0 };
    let deleted = 0;
    const sweep = this.raw.transaction(() => {
      const groups = new Map<string, string[]>(); // key -> rowIds, in table order
      for (const r of this.listRows(tableId)) {
        const key = this.dedupeKeyOf(this.getCell(r.id, cfg.column)?.value);
        if (key === null) continue; // blank / over-long values are never merged
        const arr = groups.get(key) ?? [];
        arr.push(r.id);
        groups.set(key, arr);
      }
      for (const ids of groups.values()) {
        if (ids.length <= 1) continue;
        const keep = cfg.keep === "newest" ? ids.length - 1 : 0;
        ids.forEach((id, i) => {
          if (i !== keep) {
            this.deleteRow(id);
            deleted++;
          }
        });
      }
    });
    sweep();
    return { deleted };
  }

  // ---- Credentials ----
  saveCredential(input: {
    extensionId: string;
    scope?: CredentialScope;
    name: string;
    secrets: Record<string, string>;
  }): Credential {
    const cred: Credential = {
      id: randomUUID(),
      extension_id: input.extensionId,
      scope: input.scope ?? "local",
      name: input.name,
      secrets: input.secrets,
      created_at: Date.now(),
    };
    this.raw
      .prepare(
        `INSERT INTO credentials (id, extension_id, scope, name, credentials_enc, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(cred.id, cred.extension_id, cred.scope, cred.name, encryptSecrets(cred.secrets), cred.created_at);
    return cred;
  }

  /** Distinct scopes that have a stored credential for an extension. */
  credentialScopes(extensionId: string): CredentialScope[] {
    const rows = this.raw
      .prepare(`SELECT DISTINCT scope FROM credentials WHERE extension_id = ?`)
      .all(extensionId) as { scope: string }[];
    return rows.map((r) => r.scope as CredentialScope);
  }

  /** Most recent credential for an extension (scope precedence: local > personal > team). */
  getCredential(extensionId: string): Credential | undefined {
    const r = this.raw
      .prepare(
        `SELECT * FROM credentials WHERE extension_id = ?
         ORDER BY CASE scope WHEN 'local' THEN 0 WHEN 'personal' THEN 1 ELSE 2 END, created_at DESC
         LIMIT 1`,
      )
      .get(extensionId) as
      | { id: string; extension_id: string; scope: string; name: string; credentials_enc: string; created_at: number }
      | undefined;
    if (!r) return undefined;
    return {
      id: r.id,
      extension_id: r.extension_id,
      scope: r.scope as CredentialScope,
      name: r.name,
      secrets: decryptSecrets(r.credentials_enc),
      created_at: r.created_at,
    };
  }

  // ---- Extensions (uploaded JSON manifests) ----
  saveExtension(manifest: { id: string; name: string; category?: string } & Record<string, unknown>): void {
    this.raw
      .prepare(
        `INSERT INTO extensions (id, name, category, manifest) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, category = excluded.category, manifest = excluded.manifest`,
      )
      .run(manifest.id, manifest.name, (manifest.category as string) ?? "custom", JSON.stringify(manifest));
  }

  listExtensions(): Array<Record<string, unknown>> {
    const rows = this.raw.prepare(`SELECT manifest FROM extensions ORDER BY name`).all() as { manifest: string }[];
    return rows.map((r) => JSON.parse(r.manifest));
  }

  getExtension(id: string): Record<string, unknown> | undefined {
    const r = this.raw.prepare(`SELECT manifest FROM extensions WHERE id = ?`).get(id) as { manifest: string } | undefined;
    return r ? JSON.parse(r.manifest) : undefined;
  }

  deleteExtension(id: string): void {
    this.raw.prepare(`DELETE FROM extensions WHERE id = ?`).run(id);
  }

  // ---- meta ----
  getMeta(key: string): string | undefined {
    const r = this.raw.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return r?.value;
  }

  setMeta(key: string, value: string): void {
    this.raw
      .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?`)
      .run(key, value, value);
  }

  // ---- Cloud table links (local↔cloud push, TRI-3295) ----
  // The one-way local→cloud push records the cloud `tables.id` a local table was
  // pushed to, keyed by the local table id, in the `meta` store. A present link
  // means a re-push OVERWRITES that cloud table (local is the source of truth); an
  // absent link means the first push CREATES a new cloud table and stores the link.
  // Stored under a `cloud_table_link:<localTableId>` meta key (single-purpose so it
  // never collides with other meta entries like favorites or current_project).
  private static cloudLinkKey(localTableId: string): string {
    return `cloud_table_link:${localTableId}`;
  }

  /** The cloud `tables.id` a local table is linked to, or `undefined` if unpushed. */
  getCloudTableLink(localTableId: string): string | undefined {
    return this.getMeta(Db.cloudLinkKey(localTableId));
  }

  /** Record (or update) the cloud `tables.id` a local table was pushed to. */
  setCloudTableLink(localTableId: string, cloudTableId: string): void {
    this.setMeta(Db.cloudLinkKey(localTableId), cloudTableId);
  }

  /**
   * All persisted local↔cloud links in this project, as `{ [localTableId]:
   * cloudTableId }`. Reads the same `cloud_table_link:<localTableId>` meta rows
   * `getCloudTableLink` reads (the prefix is the single source of truth), so the
   * map is exactly the set of links any push has recorded. The sidecar's
   * `GET /api/cloud/tables/links` returns this so the desktop can hydrate its
   * synced-table status from the authoritative meta instead of a localStorage
   * mirror that can drift (TRI-3311).
   */
  listCloudTableLinks(): Record<string, string> {
    const prefix = "cloud_table_link:";
    const rows = this.raw
      .prepare(`SELECT key, value FROM meta WHERE key LIKE ? || '%'`)
      .all(prefix) as { key: string; value: string }[];
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key.slice(prefix.length)] = r.value;
    return out;
  }

  private nextPos(table: string, scopeCol?: string, scopeVal?: string): number {
    const where = scopeCol ? `WHERE ${scopeCol} = ?` : "";
    const stmt = this.raw.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS n FROM ${table} ${where}`);
    const r = (scopeVal ? stmt.get(scopeVal) : stmt.get()) as { n: number };
    return r.n;
  }
}
