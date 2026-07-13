// SQLite secrets vault (better-sqlite3). One shared `global.db` holds the
// sidecar's local SECRETS only — connector/AI credentials, uploaded extension
// manifests, and a small key/value `meta` store. Grid data (tables, columns,
// rows, cells) no longer lives here: it is owned by the cloud (Postgres) tier,
// and the engine is always cloud-store-backed.

// `better-sqlite3` is a native addon. We import only its TYPES at module scope so
// that merely importing this file (and therefore `@gtmgrid/engine`) does NOT load
// the native `.node` binary — the cloud run path never touches SQLite. The
// runtime constructor is lazily `require`d inside the `Db` constructor, the
// single place that actually opens a database.
import type DatabaseT from "better-sqlite3";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { encryptSecrets, decryptSecrets } from "./crypto.js";
import type { Credential, CredentialScope } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

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
}
