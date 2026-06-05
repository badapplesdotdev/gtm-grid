// Public API for the gtmgrid engine.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
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

export interface OpenProjectResult {
  db: Db;
  engine: Engine;
}

/** Default location for project .db files: ~/gtmgrid/<name>.db */
export function projectPath(name: string): string {
  const dir = join(homedir(), "gtmgrid");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${name}.db`);
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

const DEFAULT_MODEL = { anthropic: "claude-haiku-4-5-20251001", openai: "gpt-4o-mini" } as const;

const AI_PROVIDER_IDS = ["anthropic", "openai"] as const;
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
