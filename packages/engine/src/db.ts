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
  }

  close(): void {
    this.raw.close();
  }

  // ---- Tables ----
  createTable(name: string): Table {
    const t: Table = { id: randomUUID(), name, position: this.nextPos("tables"), created_at: Date.now() };
    this.raw
      .prepare(`INSERT INTO tables (id, name, position, created_at) VALUES (?, ?, ?, ?)`)
      .run(t.id, t.name, t.position, t.created_at);
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
      position: this.nextPos("columns", "table_id", input.tableId),
      created_at: Date.now(),
    };
    this.raw
      .prepare(
        `INSERT INTO columns (id, table_id, name, type, kind, provider, method, code, params, position, created_at)
         VALUES (@id, @table_id, @name, @type, @kind, @provider, @method, @code, @params, @position, @created_at)`,
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
    };
    this.raw
      .prepare(
        `UPDATE columns SET name=@name, type=@type, kind=@kind, provider=@provider, method=@method, code=@code, params=@params WHERE id=@id`,
      )
      .run({ id, ...next, params: JSON.stringify(next.params) });
    return this.getColumn(id);
  }

  deleteColumn(id: string): void {
    this.raw.prepare(`DELETE FROM columns WHERE id = ?`).run(id);
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

  listRows(tableId: string): Row[] {
    return this.raw
      .prepare(`SELECT * FROM rows WHERE table_id = ? ORDER BY position, created_at`)
      .all(tableId) as Row[];
  }

  deleteRow(rowId: string): void {
    this.raw.prepare(`DELETE FROM rows WHERE id = ?`).run(rowId);
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
    patch: { value?: unknown; status?: CellStatus; error?: string | null },
  ): void {
    const value = patch.value === undefined ? undefined : JSON.stringify(patch.value ?? null);
    this.raw
      .prepare(
        `INSERT INTO cells (row_id, column_id, value, status, error, updated_at)
         VALUES (@row_id, @column_id, @value, @status, @error, @updated_at)
         ON CONFLICT(row_id, column_id) DO UPDATE SET
           value = COALESCE(@value, cells.value),
           status = COALESCE(@status, cells.status),
           error = @error,
           updated_at = @updated_at`,
      )
      .run({
        row_id: rowId,
        column_id: columnId,
        value: value ?? null,
        status: patch.status ?? null,
        error: patch.error ?? null,
        updated_at: Date.now(),
      });
  }

  /** All cells for a row, keyed by column id. */
  rowCells(rowId: string): Map<string, Cell> {
    const rows = this.raw.prepare(`SELECT * FROM cells WHERE row_id = ?`).all(rowId) as CellRow[];
    return new Map(rows.map((r) => [r.column_id, this.hydrateCell(r)]));
  }

  private hydrateCell(r: CellRow): Cell {
    return {
      row_id: r.row_id,
      column_id: r.column_id,
      value: r.value == null ? null : JSON.parse(r.value),
      status: r.status as CellStatus,
      error: r.error,
      updated_at: r.updated_at,
    };
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

  private nextPos(table: string, scopeCol?: string, scopeVal?: string): number {
    const where = scopeCol ? `WHERE ${scopeCol} = ?` : "";
    const stmt = this.raw.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS n FROM ${table} ${where}`);
    const r = (scopeVal ? stmt.get(scopeVal) : stmt.get()) as { n: number };
    return r.n;
  }
}
