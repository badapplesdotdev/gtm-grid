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
export type { EngineConfig, RunColumnOptions, EngineStores, CellProgress } from "./execute.js";
export { Registry, defaultRegistry } from "./registry.js";
export { runFunction, normalizeCode } from "./sandbox.js";
export { defineHttpConnector } from "./connectors/http.js";
// Default Hermes gateway base URL — shared so the server's provider routes and
// the AI connector agree on the same fallback (no duplicated literal).
export { DEFAULT_HERMES_BASE_URL } from "./connectors/ai.js";
export {
  fetchWithRetry,
  isRetryableStatus,
  isFatalStopStatus,
  parseRetryAfter,
  type RetryOptions,
} from "./http-retry.js";
export { parseManifest, connectorFromManifest, manifestSchema, type ExtensionManifest } from "./connectors/manifest.js";
export { assertPublicUrl, isBlockedIp, SsrfBlockedError, type SsrfOptions } from "./ssrf.js";
export * from "./types.js";
// Canonical Effect-TS service pattern (see docs/effect-conventions.md). Later
// business-logic services (e.g. GridStore) follow this same Service + typed-error + Layer shape.
export { CellCoercionService, CellCoercionError, type CoercedValue } from "./sample-service.js";
// Cloud schema mapping/validation (engine domain <-> cloud schema literals).
export {
  CloudSchemaMapping,
  UnknownCellStatusError,
  UnmappableCredentialScopeError,
  type CloudCellStatus,
  type CloudCredentialScope,
} from "./cloud-schema.js";
// GridStore — the engine's async storage abstraction (Effect service + typed
// errors + Layer). SqliteGridStore is the local implementation; the cloud store
// adds a cloud-client-backed Layer for the same tag.
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
// The cloud GridStore Layer (cloud-client-backed). A small injected client
// interface keeps the engine's `tsc -b` build backend-agnostic; the
// desktop/server/worker wiring passes an HTTP client plus the operation refs.
export {
  cloudGridStore,
  cloudCredentialStore,
  cloudGridStoreShape,
  type CloudClientLike,
  type CloudFunctionRefs,
  type CloudGridStoreConfig,
  type CloudCredentialResolution,
  type CloudCredentialForRunResult,
} from "./store-cloud.js";
// The local→cloud one-way table push orchestrator (TRI-3295). A scoped Effect
// service owning its own resilience (retry/jitter/timeout/rate-limit/bounded
// concurrency) over a THIN, NON-retrying injected transport — so the engine
// build stays backend-agnostic and the sidecar wires the tRPC grid surface.
export {
  CloudPushService,
  TransientPushError,
  FatalPushError,
  CloudActionsLimitError,
  LinkConflictError,
  PUSH_ROW_CHUNK,
  PUSH_MAX_CONCURRENCY,
  PUSH_RATE_LIMIT,
  PUSH_TIMEOUT,
  PUSH_MAX_RETRIES,
  type CloudPushTransport,
  type CloudPushError,
  type CloudPushConfig,
  type CloudCellMap,
  type CloudColumnSpec,
  type PushOutcome,
  type PushResult,
  type PushTableInput,
} from "./cloud-push.js";

export interface OpenProjectResult {
  db: Db;
  engine: Engine;
  /**
   * The shared global db holding connector/AI credentials (see {@link globalDbPath}).
   * Distinct from {@link db} (the project store) since the global-db split: callers
   * that read or write credentials (CLI `connect`/`status`) MUST use this, not `db`,
   * or they'll save/inspect keys the engine never resolves. Equals `db` only when the
   * opened project IS the global db.
   */
  credsDb: Db;
}

/**
 * Root directory for all project + global .db files. Defaults to `~/gtmgrid`;
 * `GTMGRID_HOME` overrides it (used to sandbox tests/CI so they never touch the
 * real global db, and to relocate state in containerised deploys).
 */
export function gtmgridDir(): string {
  const override = process.env.GTMGRID_HOME;
  const dir = override && override.length > 0 ? override : join(homedir(), "gtmgrid");
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
  // Connector secrets + AI config live in the SHARED global db (since the
  // global-db split). The desktop sidecar already wires this as the Engine's
  // credsDb (`new Engine(projectDb, …, globalDb)`); openProject must do the same
  // or every key stored only in global.db (exa, firecrawl, …) resolves to
  // undefined and the connector fires keyless — e.g. Exa then 402s. Reuse `db`
  // when this project IS the global db so we never double-open it.
  const gPath = globalDbPath();
  const credsDb = path === gPath ? db : new Db(gPath);
  const config =
    opts.config ?? { ai: aiConfigFromEnv() ?? storedAiConfig(credsDb), aiProviders: storedAiProviders(credsDb) };
  const registry = opts.registry ?? defaultRegistry();
  // Load JSON-manifest extensions from the GLOBAL db, not the project db — they
  // live alongside credentials in the shared global store (see {@link globalDbPath}),
  // and the server seeds the current `extensions/*.json` set there on startup. A
  // project db only ever held a stale snapshot, so the MCP agent (which opens a
  // project) was missing connectors the UI showed — firecrawl, notion, supabase…
  for (const manifest of credsDb.listExtensions()) {
    try {
      registry.add(connectorFromManifest(parseManifest(manifest)));
    } catch (err) {
      console.error(`Skipping invalid extension "${(manifest as any)?.id}": ${err instanceof Error ? err.message : err}`);
    }
  }
  const engine = new Engine(db, config, registry, credsDb);
  return { db, engine, credsDb };
}

const DEFAULT_MODEL = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  openrouter: "openai/gpt-4o-mini",
  // The Hermes gateway reports its real model id via /v1/models once connected;
  // this is only the fallback before the user picks one. Keep "hermes" in the id
  // so AI Generate's model-based routing sends it to the hermes provider.
  hermes: "hermes-4",
} as const;

const AI_PROVIDER_IDS = ["anthropic", "openai", "openrouter", "hermes"] as const;
type AiProvider = (typeof AI_PROVIDER_IDS)[number];

/** Resolve the stored key for one provider (new per-provider slot, with legacy fallback). */
function storedKeyFor(db: Db, provider: AiProvider): string | undefined {
  const cred = db.getCredential(`ai:${provider}`);
  if (cred?.secrets.apiKey) return cred.secrets.apiKey;
  // Legacy single-slot fallback: the old "ai" credential for the active provider.
  if (db.getMeta("ai_provider") === provider) return db.getCredential("ai")?.secrets.apiKey;
  return undefined;
}

/** Resolve a stored OpenAI-compatible base URL for a provider (e.g. hermes). */
function storedBaseUrlFor(db: Db, provider: AiProvider): string | undefined {
  return db.getCredential(`ai:${provider}`)?.secrets.baseUrl || undefined;
}

/** Resolve the default/active AI config (provider/model in meta, key encrypted in credentials). */
export function storedAiConfig(db: Db): EngineConfig["ai"] {
  const provider = db.getMeta("ai_provider") as AiProvider | undefined;
  if (!provider) return undefined;
  const apiKey = storedKeyFor(db, provider);
  if (!apiKey) return undefined;
  const baseURL = storedBaseUrlFor(db, provider);
  return {
    provider,
    apiKey,
    model: db.getMeta("ai_model") ?? DEFAULT_MODEL[provider],
    ...(baseURL ? { baseURL } : {}),
  };
}

/** Resolve every connected AI provider (for model-based routing in AI Generate). */
export function storedAiProviders(db: Db): AiConfig[] {
  const out: AiConfig[] = [];
  for (const provider of AI_PROVIDER_IDS) {
    const apiKey = storedKeyFor(db, provider);
    if (!apiKey) continue;
    const baseURL = storedBaseUrlFor(db, provider);
    out.push({ provider, apiKey, model: DEFAULT_MODEL[provider], ...(baseURL ? { baseURL } : {}) });
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
  baseURL?: string,
): void {
  // Track the most-recently-connected provider as the default active one.
  db.setMeta("ai_provider", provider);
  db.setMeta("ai_model", model ?? DEFAULT_MODEL[provider]);
  // Store under a per-provider slot so multiple providers can be connected at once.
  // `baseUrl` is persisted alongside the key for OpenAI-compatible providers (hermes).
  db.saveCredential({
    extensionId: `ai:${provider}`,
    scope,
    name: provider,
    secrets: { apiKey, ...(baseURL ? { baseUrl: baseURL } : {}) },
  });
}
