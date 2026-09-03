// Public API for the gtmgrid engine.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { Db } from "./db.js";
import type { AiConfig } from "./types.js";
import type { EngineConfig } from "./execute.js";

export { Db } from "./db.js";
export { Engine, mapConcurrent, RateLimiter, DEFAULT_RATE_LIMIT, aiConfigFromEnv } from "./execute.js";
export type { EngineConfig, RunColumnOptions, EngineStores, CellProgress, RunErrorContext } from "./execute.js";
export { classifyCellError, type CellErrorKind, type ClassifiedCellError } from "./cell-error.js";
export { Registry, defaultRegistry, bundledConnectors } from "./registry.js";
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
export { parseManifest, connectorFromManifest, manifestSchema, extractOptions, type ExtensionManifest, type FieldOption } from "./connectors/manifest.js";
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
// errors + Layer). The engine is always cloud-store-backed; the cloud store
// (`store-cloud.ts`) provides the cloud-client-backed Layer for the same tag.
export {
  GridStore,
  CredentialStore,
  GridStoreError,
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
// TableGateway — the cross-table surface table.push / table.lookup run against
// (injected per-engine as `EngineConfig.grid`, surfaced to methods as `ctx.grid`).
// Same injected-client decoupling as the cloud GridStore.
export {
  cloudTableGateway,
  type TableGateway,
  type TableGatewayRefs,
  type CloudTableGatewayConfig,
  type GatewayTableInfo,
  type GatewayTableSchema,
  type GatewayRow,
  type GatewayUpsertInput,
  type GatewayUpsertResult,
  type GatewayPushInput,
} from "./table-gateway.js";

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
