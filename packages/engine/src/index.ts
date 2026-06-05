// Public API for the gtmgrid engine.

import { homedir } from "node:os";
import { join, basename } from "node:path";
import { mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { Db } from "./db.js";
import type { AiConfig } from "./types.js";
import { Engine, aiConfigFromEnv, type EngineConfig } from "./execute.js";
import { defaultRegistry, Registry } from "./registry.js";
import { parseManifest, connectorFromManifest } from "./connectors/manifest.js";

export { Db } from "./db.js";
export { Engine, mapConcurrent, aiConfigFromEnv } from "./execute.js";
export type { EngineConfig, RunColumnOptions } from "./execute.js";
export { Registry, defaultRegistry } from "./registry.js";
export { runFunction, normalizeCode } from "./sandbox.js";
export { defineHttpConnector } from "./connectors/http.js";
export { parseManifest, connectorFromManifest, manifestSchema, type ExtensionManifest } from "./connectors/manifest.js";
export * from "./types.js";
// Canonical Effect-TS service pattern (see docs/effect-conventions.md). Later
// business-logic services (e.g. GridStore) follow this same Service + typed-error + Layer shape.
export { CellCoercionService, CellCoercionError, type CoercedValue } from "./sample-service.js";
// GridStore — the engine's async storage abstraction (Effect service + typed
// errors + Layer). SqliteGridStore is the local implementation; the cloud lane
// adds a ConvexGridStore Layer for the same tag.
export {
  GridStore,
  CredentialStore,
  GridStoreError,
  sqliteGridStore,
  sqliteCredentialStore,
  sqliteGridStoreShape,
  type GridStoreShape,
  type CellPatch,
} from "./store.js";

export interface OpenProjectResult {
  db: Db;
  engine: Engine;
}

/** Root directory for all project + global .db files. */
export function gtmgridDir(): string {
  const dir = join(homedir(), "gtmgrid");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Default location for project .db files: ~/gtmgrid/<name>.db */
export function projectPath(name: string): string {
  return join(gtmgridDir(), `${name}.db`);
}

/** The shared global db holding credentials, extensions, and AI config. */
export function globalDbPath(): string {
  return join(gtmgridDir(), "global.db");
}

export interface ProjectInfo {
  name: string;
  path: string;
  mtimeMs: number;
}

/** List projects in ~/gtmgrid (every *.db except the shared global.db), newest first. */
export function listProjects(): ProjectInfo[] {
  const dir = gtmgridDir();
  const out: ProjectInfo[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".db") || file === "global.db") continue;
    const path = join(dir, file);
    try {
      out.push({ name: basename(file, ".db"), path, mtimeMs: statSync(path).mtimeMs });
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * One-time migration: copy credentials, extensions, and AI meta from a legacy
 * single-file project into the shared global db, so existing connected keys
 * survive the split. No-op if the global db already has any credentials/AI key.
 */
export function migrateGlobals(globalDb: Db, legacyPath: string): void {
  if (!existsSync(legacyPath)) return;
  const alreadySeeded =
    (globalDb.raw.prepare(`SELECT COUNT(*) AS n FROM credentials`).get() as { n: number }).n > 0 ||
    !!globalDb.getMeta("ai_provider");
  if (alreadySeeded) return;
  const legacy = new Db(legacyPath);
  try {
    const creds = legacy.raw.prepare(`SELECT * FROM credentials`).all() as Record<string, unknown>[];
    const insCred = globalDb.raw.prepare(
      `INSERT OR IGNORE INTO credentials (id, extension_id, scope, name, credentials_enc, created_at)
       VALUES (@id, @extension_id, @scope, @name, @credentials_enc, @created_at)`,
    );
    for (const c of creds) insCred.run(c);
    const exts = legacy.raw.prepare(`SELECT * FROM extensions`).all() as Record<string, unknown>[];
    const insExt = globalDb.raw.prepare(
      `INSERT OR IGNORE INTO extensions (id, name, category, manifest) VALUES (@id, @name, @category, @manifest)`,
    );
    for (const e of exts) insExt.run(e);
    for (const key of ["ai_provider", "ai_model"]) {
      const v = legacy.getMeta(key);
      if (v != null) globalDb.setMeta(key, v);
    }
  } finally {
    legacy.close();
  }
}

/** Open (or create) a project and return a wired engine. AI config: env first, then stored (encrypted). */
export function openProject(
  pathOrName: string,
  opts: { config?: EngineConfig; registry?: Registry } = {},
): OpenProjectResult {
  const path = pathOrName.endsWith(".db") || pathOrName.includes("/") ? pathOrName : projectPath(pathOrName);
  const db = new Db(path);
  const config = opts.config ?? { ai: aiConfigFromEnv() ?? storedAiConfig(db), aiProviders: storedAiProviders(db) };
  const registry = opts.registry ?? defaultRegistry();
  // Load any uploaded JSON-manifest extensions into the registry.
  for (const manifest of db.listExtensions()) {
    try {
      registry.add(connectorFromManifest(parseManifest(manifest)));
    } catch (err) {
      console.error(`Skipping invalid extension "${(manifest as any)?.id}": ${err instanceof Error ? err.message : err}`);
    }
  }
  const engine = new Engine(db, config, registry);
  return { db, engine };
}

const DEFAULT_MODEL = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  openrouter: "openai/gpt-4o-mini",
} as const;

const AI_PROVIDER_IDS = ["anthropic", "openai", "openrouter"] as const;
type AiProvider = (typeof AI_PROVIDER_IDS)[number];

/** Resolve the stored key for one provider (new per-provider slot, with legacy fallback). */
function storedKeyFor(db: Db, provider: AiProvider): string | undefined {
  const cred = db.getCredential(`ai:${provider}`);
  if (cred?.secrets.apiKey) return cred.secrets.apiKey;
  // Legacy single-slot fallback: the old "ai" credential for the active provider.
  if (db.getMeta("ai_provider") === provider) return db.getCredential("ai")?.secrets.apiKey;
  return undefined;
}

/** Resolve the default/active AI config (provider/model in meta, key encrypted in credentials). */
export function storedAiConfig(db: Db): EngineConfig["ai"] {
  const provider = db.getMeta("ai_provider") as AiProvider | undefined;
  if (!provider) return undefined;
  const apiKey = storedKeyFor(db, provider);
  if (!apiKey) return undefined;
  return { provider, apiKey, model: db.getMeta("ai_model") ?? DEFAULT_MODEL[provider] };
}

/** Resolve every connected AI provider (for model-based routing in AI Generate). */
export function storedAiProviders(db: Db): AiConfig[] {
  const out: AiConfig[] = [];
  for (const provider of AI_PROVIDER_IDS) {
    const apiKey = storedKeyFor(db, provider);
    if (apiKey) out.push({ provider, apiKey, model: DEFAULT_MODEL[provider] });
  }
  return out;
}

/** Persist an AI provider key (encrypted) so the project works without env vars. */
export function connectAi(
  db: Db,
  provider: AiProvider,
  apiKey: string,
  model?: string,
  scope: "personal" | "team" | "local" = "local",
): void {
  // Track the most-recently-connected provider as the default active one.
  db.setMeta("ai_provider", provider);
  db.setMeta("ai_model", model ?? DEFAULT_MODEL[provider]);
  // Store under a per-provider slot so multiple providers can be connected at once.
  db.saveCredential({ extensionId: `ai:${provider}`, scope, name: provider, secrets: { apiKey } });
}
