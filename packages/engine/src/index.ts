// Public API for the gtmgrid engine.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { Db } from "./db.js";
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
  const config = opts.config ?? { ai: aiConfigFromEnv() ?? storedAiConfig(db) };
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

/** Resolve a persisted AI config (provider/model in meta, key encrypted in credentials). */
export function storedAiConfig(db: Db): EngineConfig["ai"] {
  const provider = db.getMeta("ai_provider") as "anthropic" | "openai" | undefined;
  if (!provider) return undefined;
  const cred = db.getCredential("ai");
  if (!cred?.secrets.apiKey) return undefined;
  return { provider, apiKey: cred.secrets.apiKey, model: db.getMeta("ai_model") ?? DEFAULT_MODEL[provider] };
}

/** Persist an AI provider key (encrypted) so the project works without env vars. */
export function connectAi(db: Db, provider: "anthropic" | "openai", apiKey: string, model?: string): void {
  db.setMeta("ai_provider", provider);
  db.setMeta("ai_model", model ?? DEFAULT_MODEL[provider]);
  db.saveCredential({ extensionId: "ai", scope: "local", name: provider, secrets: { apiKey } });
}
