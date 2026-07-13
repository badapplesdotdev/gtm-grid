#!/usr/bin/env node
// gtmgrid HTTP server — the engine sidecar the desktop UI talks to.
// Plain node:http, JSON REST.
//
// The sidecar is now an EXECUTION host + a SECRETS-ONLY vault. Grid data lives in
// the cloud (Postgres); there is no local SQLite project store. The sidecar:
//   - runs columns on a CLOUD project via the cloud run path (cloud-run.ts), and
//   - serves the vault-backed endpoints (AI providers, extensions, skills,
//     options, health) off the shared `global.db` secrets vault.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isProcessAlive, reclaimPort } from "./port.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import {
  Db,
  Engine,
  defaultRegistry,
  parseManifest,
  connectorFromManifest,
  extractOptions,
  connectAi,
  storedAiConfig,
  storedAiProviders,
  aiConfigFromEnv,
  globalDbPath,
  projectPath,
  migrateGlobals,
  DEFAULT_HERMES_BASE_URL,
  GridStoreError,
  type AiConfig,
  type Credential,
  type EngineConfig,
  type GridStoreShape,
} from "@gtmgrid/engine";
import { Effect } from "effect";
import type { RunErrorContext, AiGenerationEvent } from "@gtmgrid/engine";
import { randomUUID } from "node:crypto";
import { codexModelOptions, detectAgents, streamClaude, streamCodex, streamCursor, setAgentPath, rescanAgents, generateWithAgent, parseAgentCloud, type AgentKind } from "./agent.js";
import { localProviderEnv, resolveCloudProviderEnv } from "./provider-env.js";
import { listAgentSessions, readAgentSession } from "./agent-history.js";
import { runCloudColumn, previewCloudColumn, defaultCloudRunDeps } from "./cloud-run.js";
import { requiredInputKeys, resolveOptionArgs } from "./option-args.js";
import { corsHeadersFor, isLoopbackHost, isOriginAllowed } from "./cors.js";
import { Semaphore } from "./semaphore.js";
import { captureException, captureServerEvent, flushObservability, installProcessHandlers, log } from "./observability.js";

// Install last-gasp crash handlers ASAP so an error during boot/init is reported.
installProcessHandlers();

const PORT = Number(process.env.GTMGRID_PORT ?? 8787);
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
// The working directory the agent CLIs (claude/codex/cursor) are spawned in.
// MUST be a stable, real, user-writable dir that is identical across launches AND
// byte-identical on the spawn side (agent.ts) and the history-read side
// (agent-history.ts) — the agents key their transcripts by encoded cwd, so any
// drift silently breaks "Resume". The desktop shell passes GTMGRID_AGENT_CWD (a
// per-user ~/.gtmgrid/workspace). The old `join(SERVER_DIR, "../../..")` pointed
// INTO the install bundle: read-only on Windows, and a different (possibly `\\?\`
// verbatim) path than the read side — the Windows resume bug. Falls back to the
// repo root only for dev/non-packaged runs.
const REPO_ROOT = process.env.GTMGRID_AGENT_CWD ?? join(SERVER_DIR, "..", "..", "..");
try {
  mkdirSync(REPO_ROOT, { recursive: true });
} catch {
  /* best-effort — the agents will surface a clearer error if cwd is unusable */
}

// ── Process-wide run limiter (M6). The engine's per-run `mapConcurrent` only
// bounds ONE column run's row fan-out; it does NOT cap how many runs execute at
// once. A couple of simultaneous device runs (auto-run + manual) therefore push
// many sandboxed executions through this single sidecar at once. This semaphore
// is shared by BOTH the local and cloud run routes so the TOTAL number of
// in-flight runs is bounded regardless of how many start simultaneously.
// Overridable via GTMGRID_MAX_CONCURRENT_RUNS for tuning; defaults to 4.
const MAX_CONCURRENT_RUNS = Number(
  process.env.GTMGRID_MAX_CONCURRENT_RUNS ?? 4,
);
const runLimiter = new Semaphore(MAX_CONCURRENT_RUNS);

// ── Shared global db: credentials, extensions, AI config (across all projects).
const globalDb = new Db(globalDbPath());
migrateGlobals(globalDb, projectPath("default")); // one-time: pull legacy keys in

// Registry of callable functions (built-ins + uploaded manifests in globalDb).
const registry = defaultRegistry();

// Curated "featured" tools for the Browse-all gallery. This is the single source
// of truth — driven by code, NOT by the manifest/db — so the featured set is
// identical everywhere and can't drift with stale local db rows left behind by
// branch-switching (which previously made tools like Slack/Notion show as
// featured locally but not on prod).
const FEATURED_TOOLS = new Set(["trigify", "smuggler", "leadmagic", "avtrz"]);

// Seed bundled connector manifests (extensions/*.json shipped next to the server
// in the packaged app, or repo/extensions in dev) into the GLOBAL db + registry.
// Directory the bundled connector manifests + their `<tool>.skill.md` files live in.
const EXT_DIR =
  [process.env.GTMGRID_EXT_DIR, join(SERVER_DIR, "extensions"), join(REPO_ROOT, "extensions")].find(
    (d): d is string => !!d && existsSync(d),
  ) ?? null;

function seedExtensions() {
  if (!EXT_DIR) return;
  for (const file of readdirSync(EXT_DIR).filter((f) => f.endsWith(".json"))) {
    try {
      const manifest = parseManifest(readFileSync(join(EXT_DIR, file), "utf8"));
      globalDb.saveExtension(manifest as any);
      registry.add(connectorFromManifest(manifest));
    } catch (err) {
      console.error(`seed extension ${file} failed:`, err instanceof Error ? err.message : err);
    }
  }
}
seedExtensions();

// ── Tool skills: per-tool operating manuals (`<tool>.skill.md`) the workflow generates.
//    Read straight off disk so they hot-update when regenerated. Custom (user-authored)
//    skills live in the global db `meta` table as a JSON array under "custom_skills".
function loadToolSkill(id: string): string | null {
  if (!EXT_DIR) return null;
  const f = join(EXT_DIR, `${id}.skill.md`);
  return existsSync(f) ? readFileSync(f, "utf8") : null;
}
interface CustomSkill {
  id: string;
  name: string;
  description?: string;
  body: string;
  enabled?: boolean;
}
function listCustomSkills(): CustomSkill[] {
  try {
    const raw = globalDb.getMeta("custom_skills");
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function saveCustomSkills(skills: CustomSkill[]): void {
  globalDb.setMeta("custom_skills", JSON.stringify(skills));
}

function wordCount(s: string): number {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}
// Load any custom (uploaded) manifests already stored in the global db.
for (const manifest of globalDb.listExtensions()) {
  try {
    registry.add(connectorFromManifest(parseManifest(manifest)));
  } catch {
    /* skip invalid */
  }
}

/**
 * `ai.generate` fallback when no AI provider key is connected — route the prompt
 * through the user's already-authenticated coding agent (Claude Code / Codex), so
 * AI columns work off the model they're already using. Throws (→ the cell errors
 * with this message) when no agent is connected either.
 */
async function aiAgentFallback(req: { prompt: string; system?: string }): Promise<string> {
  const r = await generateWithAgent(req.prompt, req.system ?? "");
  if ("error" in r) throw new Error(r.error);
  return r.text;
}

// AI config resolved from the global db (env wins for the active provider); the
// agent fallback covers the no-key case in-process.
/** Emit a PostHog LLM-observability `$ai_generation` event for an ai.generate run.
 *  Server-side delivery (the reliable path); one trace id per generation. */
function emitAiGeneration(e: AiGenerationEvent): void {
  captureServerEvent("$ai_generation", {
    // Run-scoped when inside a column run (groups the run's generations into one
    // trace); a fresh id for a standalone generation (preview / one-off).
    $ai_trace_id: e.traceId ?? randomUUID(),
    $ai_provider: e.provider,
    $ai_model: e.model,
    $ai_input_tokens: e.inputTokens,
    $ai_output_tokens: e.outputTokens,
    $ai_latency: e.latencyMs / 1000, // PostHog expects seconds
    $ai_is_error: e.isError,
    ...(e.error ? { $ai_error: e.error } : {}),
    platform: process.platform,
  });
}

function aiConfig(): EngineConfig {
  return {
    ai: aiConfigFromEnv() ?? storedAiConfig(globalDb),
    aiProviders: storedAiProviders(globalDb),
    aiFallback: aiAgentFallback,
    onAiGeneration: emitAiGeneration,
    // Surface systemic run failures (connector/AI bugs) to PostHog Error Tracking,
    // deduped per run by the engine. Per-cell errors still land as cell status.
    reportError: (error: unknown, ctx: RunErrorContext) =>
      captureException(error, { source: "engine-run", ...ctx }),
  };
}

// ── Credential-only GridStore (no grid table) backed by the secrets vault.
// The sidecar no longer owns grid data — the cloud (Postgres) tier does. But a
// few routes still dispatch a connector DIRECTLY with no table (the
// `/api/options` name-picker resolves an option source through `engine.dispatch`).
// That path only needs the credential resolver, so we back a table-free
// GridStoreShape with the vault's `getCredential` and stub the grid reads/writes
// (they are never reached on a table-free dispatch). The engine is always
// store-backed, so this satisfies its constructor without opening a grid Db.
function vaultGridStore(): GridStoreShape {
  const unsupported = (operation: string) =>
    Effect.fail(
      new GridStoreError({
        message: `${operation} is not available on the secrets vault (no local grid)`,
        operation,
      }),
    );
  return {
    getColumn: () => unsupported("getColumn"),
    listColumns: () => unsupported("listColumns"),
    listRows: () => unsupported("listRows"),
    rowCells: () => unsupported("rowCells"),
    getCell: () => unsupported("getCell"),
    setCell: () => unsupported("setCell"),
    getCredential: (provider: string) =>
      Effect.try({
        try: (): Credential | undefined => globalDb.getCredential(provider),
        catch: (cause) =>
          new GridStoreError({
            message: cause instanceof Error ? cause.message : String(cause),
            operation: "getCredential",
            cause,
          }),
      }),
  };
}

// A standing engine for the table-free dispatch path (`/api/options`): no grid,
// credentials resolve from the vault. Its config is refreshed in place when AI
// keys change (see the ai-providers/connect route).
const dispatchStore = vaultGridStore();
const engine = new Engine(aiConfig(), registry, { store: dispatchStore, creds: dispatchStore });

// The sidecar drives a single CLOUD project; the display name is purely
// cosmetic (agent chat banner / repo context), the grid itself lives in the
// cloud and is addressed per-request by the cloud run path.
const PROJECT_NAME = process.env.GTMGRID_PROJECT ?? "gtmgrid";

// Resolve the AI provider config the `/api/ai-providers` route reports on.
function aiProviderConfigs(): AiConfig[] {
  return engine.config.aiProviders ?? [];
}

type Handler = (params: Record<string, string>, body: any) => Promise<unknown> | unknown;
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}
const routes: Route[] = [];
function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" + path.replace(/:[^/]+/g, (m) => (keys.push(m.slice(1)), "([^/]+)")) + "$",
  );
  routes.push({ method, pattern, keys, handler });
}

// --- serialization helpers ---
// Derive a brand logo from a domain via Google's favicon service (reliable,
// no API key). Strips api./www. so we hit the marketing root domain.
function logoFor(domainOrUrl?: string | null): string | null {
  if (!domainOrUrl) return null;
  let host = domainOrUrl;
  try {
    host = new URL(domainOrUrl.includes("://") ? domainOrUrl : `https://${domainOrUrl}`).hostname;
  } catch {
    /* treat as bare host */
  }
  host = host.replace(/^(www|api)\./, "");
  return host ? `https://www.google.com/s2/favicons?domain=${host}&sz=128` : null;
}

/** URL/id-safe slug from a display name (for custom skill ids). */
function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

// Credential scope from request body — Personal / Team / Local tabs in the UI.
function normScope(s: unknown): "personal" | "team" | "local" {
  return s === "team" || s === "local" || s === "personal" ? s : "personal";
}

/** Strip Markdown fences / leading `return` / trailing `;` an LLM may wrap output in. */
function cleanFormulaOutput(text: string): string {
  let s = text.trim();
  const fence = s.match(/^```(?:[a-z]*)?\n?([\s\S]*?)\n?```$/i);
  if (fence) s = fence[1].trim();
  s = s.replace(/^return\s+/, "").replace(/;+\s*$/, "");
  return s.trim();
}

/** System prompt steering the AI to emit a bare formula / boolean expression. */
function formulaSystemPrompt(mode: "formula" | "condition", columns: string[]): string {
  const cols = columns.length ? columns.map((c) => `{{${c}}}`).join(", ") : "(none yet)";
  const shared =
    `Reference other columns with {{Column Name}} (double braces). Available columns: ${cols}. ` +
    `Each {{Column}} is replaced with that row's typed value (string/number/boolean/object). ` +
    `You may use standard JavaScript, Lodash as \`_\`, Moment as \`moment\`, and Excel/Google-Sheets ` +
    `functions (VLOOKUP, IF, SUM, CONCATENATE, LEFT, RIGHT, TEXT, …) by their bare UPPERCASE names. ` +
    `Output ONLY the expression — no explanation, no code fences, no \`return\`, no trailing semicolon.`;
  if (mode === "condition") {
    return (
      `You write a single JavaScript boolean expression that decides whether an enrichment should ` +
      `run for a row ("only run if"). It must evaluate to true (run) or false (skip). ${shared}\n\n` +
      `Examples:\n` +
      `- Only run if title contains "VP" → /VP/i.test({{Title}})\n` +
      `- Only run if company size is over 100 → Number({{Company Size}}) > 100\n` +
      `- Only run if a news article was found → Boolean({{News Article}})`
    );
  }
  return (
    `You write a single JavaScript expression for a spreadsheet "formula column", evaluated per row. ${shared}\n\n` +
    `Examples:\n` +
    `- Extract the domain from {{Email}} → {{Email}}.split("@")[1]\n` +
    `- Use {{LinkedIn URL}} if available; otherwise {{LinkedIn Profile}}.url → {{LinkedIn URL}} || {{LinkedIn Profile}}.url\n` +
    `- Days between {{Created Date}} and {{Closed Date}} → moment({{Closed Date}}).diff(moment({{Created Date}}), "days")`
  );
}

// --- routes ---
//
// METERING: grid data lives in the cloud (Postgres); the sidecar holds NO local
// grid. The CLOUD run route (`/api/cloud/columns/run`) writes via the apps/web
// worker mutations, which meter once on the cloud side — so the sidecar stays
// unmetered (no double-count, and it holds no billing secret). The remaining
// routes serve the secrets vault (AI providers, extensions, skills, options).
route("GET", "/api/health", () => ({ ok: true, project: PROJECT_NAME }));

route("GET", "/api/functions", () =>
  registry.list().map((c) => {
    const ext: any = globalDb.getExtension(c.id);
    return {
      provider: c.id,
      name: c.name,
      category: c.category,
      requiresCredential: !!c.auth,
      logo: ext ? ext.logo ?? logoFor(ext.baseUrl) : null,
      methods: c.methods.map((m) => ({
        method: m.id,
        label: m.label,
        description: m.description,
        category: m.category ?? null,
        credits: m.credits,
        input: m.inputSchema ?? null,
        // Fields the UI should render as a live name-picker (field → option source).
        options: m.options ?? null,
        source: m.source ?? null,
        batchSize: m.batchSize ?? 1,
        output: m.output ?? "text",
      })),
    };
  }),
);

route("GET", "/api/extensions", () =>
  globalDb.listExtensions().map((e: any) => ({
    id: e.id,
    name: e.name,
    category: e.category,
    description: e.description ?? null,
    featured: FEATURED_TOOLS.has(e.id),
    methods: (e.methods ?? []).length,
    connected: !!globalDb.getCredential(e.id),
    logo: e.logo ?? logoFor(e.baseUrl),
  })),
);

// Full manifest for one extension — powers the extension detail panel.
route("GET", "/api/extensions/:id", (p) => {
  const m: any = globalDb.getExtension(p.id);
  if (!m) return { error: "not found" };
  return {
    id: m.id,
    name: m.name,
    category: m.category ?? "custom",
    description: m.description ?? null,
    version: m.version ?? null,
    baseUrl: m.baseUrl ?? null,
    logo: m.logo ?? logoFor(m.baseUrl),
    auth: m.auth
      ? { type: m.auth.type, header: m.auth.header ?? null, secretKey: m.auth.secretKey ?? "apiKey" }
      : null,
    connected: !!globalDb.getCredential(m.id),
    connectedScopes: globalDb.credentialScopes(m.id),
    methods: (m.methods ?? []).map((x: any) => ({
      id: x.id,
      label: x.label ?? x.id,
      description: x.description ?? "",
      credits: x.credits ?? 0,
      verb: x.verb ?? null,
      path: x.path ?? null,
    })),
  };
});

// --- Skills: per-tool agent playbooks (<tool>.skill.md) + custom user skills ---
// List: one entry per tool that ships a skill file, plus every custom skill.
route("GET", "/api/skills", () => {
  const toolSkills = globalDb
    .listExtensions()
    .map((e: any) => {
      const body = loadToolSkill(e.id);
      if (!body) return null;
      return {
        id: e.id,
        name: e.name,
        category: e.category ?? "custom",
        description: e.description ?? null,
        source: "tool" as const,
        connected: !!globalDb.getCredential(e.id),
        wordCount: wordCount(body),
        logo: e.logo ?? logoFor(e.baseUrl),
        enabled: true,
      };
    })
    .filter(Boolean);
  const custom = listCustomSkills().map((s) => ({
    id: s.id,
    name: s.name,
    category: "custom",
    description: s.description ?? null,
    source: "custom" as const,
    connected: false,
    wordCount: wordCount(s.body ?? ""),
    logo: null,
    enabled: s.enabled !== false,
  }));
  return [...toolSkills, ...custom];
});

// Full skill body (markdown) for one skill — tool skill from disk, or a custom skill.
route("GET", "/api/skills/:id", (p) => {
  const ext: any = globalDb.getExtension(p.id);
  const body = loadToolSkill(p.id);
  if (ext && body) {
    return {
      id: ext.id,
      name: ext.name,
      category: ext.category ?? "custom",
      description: ext.description ?? null,
      source: "tool" as const,
      connected: !!globalDb.getCredential(ext.id),
      logo: ext.logo ?? logoFor(ext.baseUrl),
      enabled: true,
      body,
    };
  }
  const custom = listCustomSkills().find((s) => s.id === p.id);
  if (custom) {
    return {
      id: custom.id,
      name: custom.name,
      category: "custom",
      description: custom.description ?? null,
      source: "custom" as const,
      connected: false,
      logo: null,
      enabled: custom.enabled !== false,
      body: custom.body ?? "",
    };
  }
  return { error: "not found" };
});

// Create or update a CUSTOM skill (tool skills are read-only files).
route("POST", "/api/skills", (_p, body) => {
  const b = (body ?? {}) as Partial<CustomSkill>;
  const name = (b.name ?? "").trim();
  if (!name) return { error: "name required" };
  const id = (b.id ?? "").trim() || `custom-${slugify(name)}`;
  const skills = listCustomSkills();
  const next: CustomSkill = {
    id,
    name,
    description: b.description ?? "",
    body: b.body ?? "",
    enabled: b.enabled !== false,
  };
  const i = skills.findIndex((s) => s.id === id);
  if (i >= 0) skills[i] = next;
  else skills.push(next);
  saveCustomSkills(skills);
  return { ok: true, id };
});

// Toggle whether a custom skill is injected into the agent.
route("POST", "/api/skills/:id/toggle", (p, body) => {
  const skills = listCustomSkills();
  const s = skills.find((x) => x.id === p.id);
  if (!s) return { error: "not found (tool skills are always on for connected tools)" };
  s.enabled = (body as any)?.enabled !== false;
  saveCustomSkills(skills);
  return { ok: true, enabled: s.enabled };
});

// Delete a custom skill (tool skills cannot be deleted via the API).
route("DELETE", "/api/skills/:id", (p) => {
  const skills = listCustomSkills();
  const next = skills.filter((s) => s.id !== p.id);
  if (next.length === skills.length) return { error: "no such custom skill" };
  saveCustomSkills(next);
  return { ok: true };
});

// NOTE: the local-grid SIGNALS routes (bind a Trigify saved search to a local
// SQLite table + poll results in) were removed with the local grid paradigm —
// they wrote tables/columns/rows into the project Db, which no longer exists.
// Recurring/scheduled signal refresh is a CLOUD-only feature (the Inngest cron
// worker). See the workstream summary for the owner decision.

// --- AI providers (bring-your-own-key for AI step functions) ---
// `fallbackModels` is only used if the live /v1/models fetch fails (offline,
// bad key). When connected, the real model list is pulled from the provider.
// `DEFAULT_HERMES_BASE_URL` (the SSH tunnel to the mac-mini api_server,
// localhost:18642 -> mac-mini:8642) is shared from @gtmgrid/engine so the
// connector and these provider routes can't drift. Overridable per connection.
const AI_PROVIDERS = [
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude models for reasoning and generation.",
    domain: "anthropic.com",
    fallbackModels: ["claude-opus-4-1-20250805", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "Industry-leading models for reasoning and generation.",
    domain: "openai.com",
    fallbackModels: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o3-mini"],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "One key for hundreds of models across providers.",
    domain: "openrouter.ai",
    fallbackModels: [
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
      "anthropic/claude-3.5-sonnet",
      "google/gemini-2.0-flash-001",
      "meta-llama/llama-3.3-70b-instruct",
    ],
  },
  {
    id: "hermes",
    name: "Hermes",
    description: "Your Hermes agent gateway (OpenAI-compatible). Each call runs the full agent — tools, skills, memory.",
    domain: "nousresearch.com",
    fallbackModels: ["hermes-4"],
  },
] as const;

type AiProviderId = (typeof AI_PROVIDERS)[number]["id"];

// Live model lists, fetched from each provider's API with the connected key.
// Cached per provider for a short TTL so we don't hit the API on every poll.
const modelCache = new Map<string, { key: string; models: string[]; ts: number }>();
const MODEL_TTL_MS = 10 * 60 * 1000;

async function fetchModels(
  provider: AiProviderId,
  apiKey: string,
  baseURL?: string,
): Promise<string[] | null> {
  // Hermes' model list is per-gateway, so key the cache by (apiKey, baseURL).
  const cacheKey = provider === "hermes" ? `${apiKey}|${baseURL ?? ""}` : apiKey;
  const cached = modelCache.get(provider);
  if (cached && cached.key === cacheKey && Date.now() - cached.ts < MODEL_TTL_MS) return cached.models;
  try {
    let models: string[] = [];
    if (provider === "anthropic") {
      const r = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      });
      if (!r.ok) return null;
      const data = (await r.json()) as { data: { id: string }[] };
      // API returns newest-first; keep that order.
      models = data.data.map((m) => m.id);
    } else if (provider === "openrouter") {
      const r = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      if (!r.ok) return null;
      const data = (await r.json()) as { data: { id: string }[] };
      // Namespaced ids ("vendor/model"); sort alphabetically for a stable list.
      models = data.data.map((m) => m.id).sort();
    } else if (provider === "hermes") {
      // OpenAI-compatible gateway: GET {baseURL}/models with a bearer token.
      const base = (baseURL || DEFAULT_HERMES_BASE_URL).replace(/\/+$/, "");
      const r = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
      if (!r.ok) return null;
      const data = (await r.json()) as { data: { id: string }[] };
      models = data.data.map((m) => m.id);
    } else {
      const r = await fetch("https://api.openai.com/v1/models", {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      if (!r.ok) return null;
      const data = (await r.json()) as { data: { id: string }[] };
      // Keep chat-capable text models; drop embeddings/audio/image/etc.
      models = data.data
        .map((m) => m.id)
        .filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id))
        .filter((id) => !/(embedding|whisper|tts|audio|realtime|image|dall-e|moderation|transcribe|davinci|babbage|instruct)/.test(id))
        .sort()
        .reverse();
    }
    if (!models.length) return null;
    modelCache.set(provider, { key: cacheKey, models, ts: Date.now() });
    return models;
  } catch {
    return null;
  }
}

route("GET", "/api/ai-providers", async () => {
  // Each provider connects independently (per-provider credential slot), so any
  // number can be connected at once and all their models pull through.
  const connectedProviders = new Set(aiProviderConfigs().map((a) => a.provider));
  const envProvider = process.env.ANTHROPIC_API_KEY
    ? "anthropic"
    : process.env.OPENAI_API_KEY
      ? "openai"
      : process.env.OPENROUTER_API_KEY
        ? "openrouter"
        : process.env.HERMES_BASE_URL
          ? "hermes"
          : undefined;
  const envKeyFor = (id: string) =>
    id === "anthropic"
      ? process.env.ANTHROPIC_API_KEY
      : id === "openai"
        ? process.env.OPENAI_API_KEY
        : id === "openrouter"
          ? process.env.OPENROUTER_API_KEY
          : id === "hermes"
            ? process.env.HERMES_API_KEY ?? "hermes"
            : undefined;
  return Promise.all(
    AI_PROVIDERS.map(async (p) => {
      const cred = globalDb.getCredential(`ai:${p.id}`);
      const hasKey = !!cred;
      const viaEnv = !hasKey && envProvider === p.id;
      const connected = connectedProviders.has(p.id) || viaEnv;
      // Prefer the engine-resolved key (handles the legacy single-slot credential
      // for keys connected before per-provider storage existed).
      const apiKey =
        aiProviderConfigs().find((a) => a.provider === p.id)?.apiKey ??
        cred?.secrets.apiKey ??
        (viaEnv ? envKeyFor(p.id) : undefined);
      // Hermes is a configurable gateway — resolve its base URL (stored cred,
      // then env, then the default tunnel) so live model fetch + the UI prefill work.
      const baseUrl =
        p.id === "hermes"
          ? (aiProviderConfigs().find((a) => a.provider === "hermes")?.baseURL ??
            cred?.secrets.baseUrl ??
            process.env.HERMES_BASE_URL ??
            DEFAULT_HERMES_BASE_URL)
          : null;
      // Pull the real model list when connected; fall back to the static list.
      let models: string[] = [...p.fallbackModels];
      if (connected && apiKey) {
        const live = await fetchModels(p.id, apiKey, baseUrl ?? undefined);
        if (live?.length) models = live;
      }
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        logo: logoFor(p.domain),
        models,
        connected,
        viaEnv,
        baseUrl,
        connectedScopes: hasKey ? globalDb.credentialScopes(`ai:${p.id}`) : [],
      };
    }),
  );
});

route("POST", "/api/ai-providers/:id/connect", (p, body) => {
  if (p.id !== "anthropic" && p.id !== "openai" && p.id !== "openrouter" && p.id !== "hermes")
    return { error: "unsupported provider" };
  const apiKeyIn = String(body?.apiKey ?? "").trim();
  const baseURLIn = String(body?.baseURL ?? body?.baseUrl ?? "").trim();
  // Preserve existing values on partial updates: changing only the URL must NOT
  // wipe the saved key (and vice-versa).
  const prev = globalDb.getCredential(`ai:${p.id}`)?.secrets ?? {};
  const apiKey = apiKeyIn || prev.apiKey || "";
  // Hermes (a local/LAN gateway) accepts any bearer when API_SERVER_KEY is unset,
  // so it can connect with just a base URL; the other providers require a key.
  if (!apiKey && p.id !== "hermes") return { error: "apiKey required" };
  const baseURL = p.id === "hermes" ? baseURLIn || prev.baseUrl || DEFAULT_HERMES_BASE_URL : undefined;
  connectAi(globalDb, p.id, apiKey || "hermes", undefined, normScope(body?.scope), baseURL);
  // Refresh the live engine so AI columns work immediately — both the active
  // provider and the full set used for model-based routing.
  engine.config.ai = storedAiConfig(globalDb);
  engine.config.aiProviders = storedAiProviders(globalDb);
  return { ok: true };
});

// Copy a LOCAL connector/AI key up to the shared CLOUD (workspace) key — the
// desktop "Use my local key" action. SECURITY: the plaintext is revealed ONLY
// inside this sidecar process (the user's own machine) and forwarded to the cloud
// over TLS; it is never returned to the caller (the renderer), never logged, and
// stored only as ciphertext server-side. The cloud save is member-authenticated
// (the forwarded Better Auth bearer in `X-Gtmgrid-Member`), so a non-member is
// rejected server-side. This route inherits the loopback-`Host` / allowed-`Origin`
// gate every route is wrapped in, so it is not LAN-reachable.
route("POST", "/api/credentials/copy-to-cloud", async (_p, body) => {
  const credId = String(body?.credId ?? "").trim();
  const extensionId = String(body?.extensionId ?? credId).trim() || credId;
  const apiUrl = String(body?.apiUrl ?? "").trim();
  const token = String(body?.token ?? "").trim();
  const workspaceId = String(body?.workspaceId ?? "").trim();
  const name = String(body?.name ?? extensionId).trim() || extensionId;
  if (!credId || !apiUrl || !token || !workspaceId)
    return { error: "credId, apiUrl, token and workspaceId are required" };

  // Reveal the LOCAL plaintext — only ever in this process; never returned/logged.
  const secrets = globalDb.getCredential(credId)?.secrets ?? null;
  if (!secrets || Object.keys(secrets).length === 0)
    return { error: "No local key found to copy to the cloud." };

  // Server-to-server save over TLS, authenticated as the signed-in member. The
  // cloud worker route encrypts the map at rest (CredentialService.saveCredential).
  const base = apiUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/worker/saveCredential`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Gtmgrid-Member": token },
    body: JSON.stringify({ workspaceId, extensionId, name, secrets }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      error:
        `Cloud save failed (${res.status} ${res.statusText}). ${text}`.trim(),
    };
  }
  return { ok: true };
});

// NOTE: the LOCAL grid CRUD/run routes (`/api/tables*`, `/api/folders*`,
// `/api/columns/:id/run[/async]`, `/api/cells*`, `/api/tables/:id/rows[/bulk]`,
// dedupe, preview-function, cloud-table-links) were removed with the local grid
// paradigm. Grid data lives in the cloud (Postgres); column runs go through the
// CLOUD run route below (`/api/cloud/columns/run`).

// Live options for a pick-field: resolve `provider.method`'s declared option
// source for `field`, call the source list endpoint with the connector's stored
// credential, and return `{ label, value }[]`. Powers the column-editor's
// name-dropdown so a user picks an Instantly campaign / HeyReach sender by NAME
// and the id is stored — no hand-pasted UUIDs. `search` is forwarded to the
// source call (most list endpoints accept a search/keyword filter).
route("POST", "/api/options", async (_p, body) => {
  const provider = String(body?.provider ?? "");
  const ownerMethod = String(body?.method ?? "");
  const field = String(body?.field ?? "");
  if (!provider || !ownerMethod || !field) throw new Error("provider, method and field are required");
  const m = registry.method(provider, ownerMethod);
  const source = m?.options?.[field];
  if (!source) return { error: `no option source for ${provider}.${ownerMethod}.${field}` };
  // Dependent dropdowns: inject any sibling value the SOURCE method (e.g.
  // listCampaigns) declares required (e.g. workspace_id) from the in-progress
  // field values the column editor sends. See ./option-args for the rules.
  const srcRequired = requiredInputKeys(registry.method(provider, source.method)?.inputSchema);
  const values = (body?.values ?? {}) as Record<string, unknown>;
  const { args, missing } = resolveOptionArgs(source.args ?? {}, srcRequired, values);
  // Surface a clear prompt instead of letting the upstream API reject with a raw 400.
  if (missing.length) return { error: `Select ${missing.join(", ")} first to load options` };
  const search = typeof body?.search === "string" ? body.search.trim() : "";
  // Best-effort search passthrough: forward under whichever filter key the
  // source endpoint exposes (its input schema tells us). Harmless if unused.
  if (search) {
    const srcMethod = registry.method(provider, source.method);
    const props = ((srcMethod?.inputSchema as any)?.properties ?? {}) as Record<string, unknown>;
    for (const key of ["search", "keyword", "query", "q", "name"]) {
      if (key in props) {
        args[key] = search;
        break;
      }
    }
  }
  const raw = await runLimiter.run(() => engine.dispatch(provider, source.method, args));
  return { options: extractOptions(raw, source) };
});

// --- cloud run path (T9) ---
// Running a column on a CLOUD project: build an Engine whose store is the
// cloud-backed GridStore (POSTing to the apps/web `/api/worker/*` endpoints), so
// inputs are read from Postgres and statuses/results stream back live to all
// members via the realtime broadcast the server emits. The registry + AI config
// are the sidecar's existing ones, so connectors/AI columns behave identically.
route("POST", "/api/cloud/columns/run", async (_p, body) => {
  const apiUrl = String(body?.apiUrl ?? "").trim();
  const token = String(body?.token ?? "").trim();
  const tableId = String(body?.tableId ?? "").trim();
  const columnId = String(body?.columnId ?? "").trim();
  if (!apiUrl || !token || !tableId || !columnId)
    return { error: "apiUrl, token, tableId and columnId are required" };
  const rowIds = Array.isArray(body?.rowIds) && body.rowIds.length ? (body.rowIds as string[]) : undefined;
  const deps = defaultCloudRunDeps(registry, aiConfig());
  // The cloud path is Db-free: the engine is built with no Db and reads/writes
  // through the injected cloud store, so no SQLite file is opened here. The run
  // waits for a process-wide permit first (M6) so simultaneous cloud + local
  // runs are bounded; `runCloudColumn` additionally clamps `concurrency` to a
  // safe per-run ceiling.
  return runLimiter.run(() =>
    runCloudColumn(
      { apiUrl, token, tableId, columnId, force: !!body?.force, concurrency: body?.concurrency ?? 5, rowIds },
      deps,
    ),
  );
});

// "Try on N rows" preview for a CLOUD table: dry-run a not-yet-saved function
// column and return per-row results WITHOUT persisting or metering anything
// (no quota gate). Same worker-backed store as the cloud run path; bounded by
// the same process-wide run semaphore.
route("POST", "/api/cloud/preview-function", async (_p, body) => {
  const apiUrl = String(body?.apiUrl ?? "").trim();
  const token = String(body?.token ?? "").trim();
  const tableId = String(body?.tableId ?? "").trim();
  const provider = String(body?.provider ?? "").trim();
  const method = String(body?.method ?? "").trim();
  if (!apiUrl || !token || !tableId || !provider || !method)
    return { error: "apiUrl, token, tableId, provider and method are required" };
  const params = (body?.params ?? {}) as Record<string, unknown>;
  const limit = typeof body?.limit === "number" ? body.limit : undefined;
  const deps = defaultCloudRunDeps(registry, aiConfig());
  const results = await runLimiter.run(() =>
    previewCloudColumn({ apiUrl, token, tableId, provider, method, params, limit }, deps),
  );
  return { results };
});

// Generate a formula expression (or an "only run if" boolean) from a natural-language
// description, via the connected AI provider. Reuses the engine's AI dispatch path.
// Generate a formula / "only run if" expression from natural language using the
// connected coding agent (Claude Code or Codex) — the model the user has already
// authenticated, NOT a separate API AI key. Returns a "connect an agent" error when
// neither CLI is available.
// Generic one-shot AI generation via the user's connected coding agent (no API
// key) — the MCP's `ai.generate` fallback POSTs here when no AI provider is set.
route("POST", "/api/ai/generate", async (_p, body) => {
  const prompt = String(body?.prompt ?? "").trim();
  if (!prompt) return { error: "prompt is required" };
  const r = await generateWithAgent(prompt, String(body?.system ?? ""));
  if ("error" in r) return { error: r.error };
  return { text: r.text };
});

route("POST", "/api/ai/generate-formula", async (_p, body) => {
  const description = String(body?.description ?? "").trim();
  if (!description) return { error: "description is required" };
  const columns: string[] = Array.isArray(body?.columns) ? body.columns.map(String) : [];
  const mode = body?.mode === "condition" ? "condition" : "formula";
  const r = await generateWithAgent(description, formulaSystemPrompt(mode, columns));
  if ("error" in r) return { error: r.error };
  return { formula: cleanFormulaOutput(r.text) };
});

route("POST", "/api/extensions/:id/connect", (p, body) => {
  globalDb.saveCredential({ extensionId: p.id, scope: normScope(body?.scope), name: "default", secrets: body?.secrets ?? {} });
  return { ok: true };
});

route("GET", "/api/agents", () => detectAgents());

// Codex's authenticated-plan model catalog, refreshed by the Codex CLI itself.
// This is separate from /api/ai-providers (API-key models used by AI columns).
route("GET", "/api/agent/models/:agent", (p) =>
  p.agent === "codex"
    ? codexModelOptions()
    : { models: [], source: "default" as const },
);

// Past conversations for the current project, read from the CLI's OWN native
// transcript store (Claude Code project dir / Codex rollouts) — no local copy.
route("GET", "/api/agent/sessions/:agent", (p) => ({
  sessions: listAgentSessions(p.agent === "codex" ? "codex" : "claude", REPO_ROOT),
}));
// One conversation's messages, parsed from the native transcript. Resuming it
// reuses the native session id via the chat route's `--resume`.
route("GET", "/api/agent/sessions/:agent/:id", (p) => ({
  messages: readAgentSession(p.agent === "codex" ? "codex" : "claude", REPO_ROOT, p.id),
}));

// Manually connect a CLI (set its path) and/or rescan after install.
route("POST", "/api/agents/connect", (_p, body) => {
  const agent = body?.agent as AgentKind;
  if ((agent === "claude" || agent === "codex" || agent === "cursor") && typeof body?.path === "string" && body.path.trim()) {
    setAgentPath(agent, body.path.trim());
  }
  rescanAgents();
  return detectAgents();
});

// --- server plumbing ---
// CORS is allowlisted, never `*` (#22): a disallowed browser Origin gets NO
// `access-control-allow-origin`, so the calling page can't read the response.
// `origin` is the request's `Origin` header (undefined for non-browser callers).
function send(res: ServerResponse, status: number, data: unknown, origin?: string) {
  const json = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json",
    ...corsHeadersFor(origin),
  });
  res.end(json);
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;

  // ── CSRF / DNS-rebinding defense (applies to EVERY route, before any work).
  // The sidecar is loopback-only and privileged (runs connectors with the user's
  // credentials, spawns their authenticated CLIs). CORS alone is not enough: a
  // hostile page can issue a cross-origin "simple" POST (e.g. `text/plain`, which
  // `readBody` still parses as JSON) and — though it cannot READ the response —
  // the side effect (delete a table, overwrite a key, fire a credit-burning run)
  // still lands; and DNS rebinding makes a hostile page "same-origin" to skip CORS
  // entirely. So we REJECT, not merely omit ACAO:
  //   1. any `Host` that is not the loopback interface (rebinding still carries
  //      the attacker's own `Host`, which page JS cannot forge), and
  //   2. any present-but-disallowed browser `Origin` (a missing Origin = a
  //      non-browser/local caller, which the loopback bind already gates).
  // The previously chat-only `isOriginAllowed` gate now covers the whole surface.
  if (!isLoopbackHost(req.headers.host)) {
    return send(res, 403, { error: "host not allowed" }, origin);
  }
  if (!isOriginAllowed(origin)) {
    return send(res, 403, { error: "origin not allowed" }, origin);
  }

  if (req.method === "OPTIONS") return send(res, 204, {}, origin);
  const url = new URL(req.url ?? "/", "http://localhost");

  // Agent chat is a long-lived SSE stream — handled outside the JSON router.
  if (req.method === "POST" && url.pathname === "/api/agent/chat") {
    // PRIVILEGED route: it spawns the user's authenticated CLI. Reject a
    // disallowed cross-origin browser caller BEFORE spawning anything (#22).
    if (!isOriginAllowed(origin)) return send(res, 403, { error: "origin not allowed" }, origin);
    const body = await readBody(req);
    const agent = body?.agent ?? "claude";
    const message = String(body?.message ?? "");
    if (!message) return send(res, 400, { error: "message required" }, origin);
    try {
      // Snapshot the live connector registry so the skill's "Connectors
      // currently installed" section reflects whatever extensions the user
      // has registered, including ones added since the last app launch.
      const providers = registry.list().map((c) => ({
        id: c.id,
        name: c.name,
        category: c.category,
        methodCount: c.methods.length,
      }));
      // Inject the operating playbook for every CONNECTED tool (so the agent
      // stops guessing endpoints), plus any enabled custom skills. Only connected
      // tools are included to keep the system prompt bounded.
      const toolSkills = registry
        .list()
        .filter((c) => !!globalDb.getCredential(c.id))
        .map((c) => ({ id: c.id, name: c.name, body: loadToolSkill(c.id) }))
        .filter((s): s is { id: string; name: string; body: string } => !!s.body);
      const customSkills = listCustomSkills()
        .filter((s) => s.enabled !== false && s.body?.trim())
        .map((s) => ({ id: s.id, name: s.name, body: s.body }));
      const skills = [...toolSkills, ...customSkills];
      const context = { ...body?.context, providers, skills };
      // Pass `origin` through so the SSE stream emits the allowlisted CORS
      // header on this privileged route (#22).
      const model = typeof body?.model === "string" && body.model.trim() ? body.model.trim() : undefined;
      // Permission mode the user picked in the composer → Claude's --permission-mode.
      // Validated against the headless-safe set; unknown/absent ⇒ undefined (the
      // claude bridge then applies its bypass default).
      const ALLOWED_MODES = new Set(["bypassPermissions", "auto", "acceptEdits", "plan"]);
      const mode = typeof body?.mode === "string" && ALLOWED_MODES.has(body.mode) ? body.mode : undefined;
      // HITL approval: on a resumed-after-Approve turn the desktop sends the
      // human-approved { tool, argsHash }. It's threaded into the MCP env
      // (agent.ts → mcpEnv), a channel the model can't reach, so the gated tool
      // runs only for the exact action the user approved. Validated shape only.
      const approval =
        body?.approval &&
        typeof body.approval === "object" &&
        typeof body.approval.tool === "string" &&
        typeof body.approval.argsHash === "string"
          ? { tool: body.approval.tool as string, argsHash: body.approval.argsHash as string }
          : undefined;
      // CLOUD context (TRI-3296): the desktop operates a CLOUD project and
      // forwards apiUrl/token/workspace/project/table so the spawned MCP's table
      // tools read/write the cloud grid. The token rides the MCP child env (set by
      // agent.ts), never a log line here.
      const cloud = parseAgentCloud(body?.cloud);
      // Saved provider keys → conventional env vars (TRIGIFY_API_KEY etc.) so
      // the CLIs/skills the agent shells out to authenticate with the user's
      // stored credential. CLOUD: the workspace credential store via the
      // member's bearer; otherwise the local secrets vault. Fail-open — a
      // resolution error spawns the agent without injected keys.
      const providerEnv = cloud
        ? await resolveCloudProviderEnv(cloud)
        : localProviderEnv(
            registry.list().map((c) => c.id),
            (id) => globalDb.getCredential(id)?.secrets ?? null,
          );
      const newChat = body?.newChat === true;
      if (agent === "cursor") streamCursor(res, { message, project: PROJECT_NAME, repoRoot: REPO_ROOT, sessionId: body?.sessionId, newChat, context, origin, model, mode, cloud, providerEnv, approval });
      else if (agent === "codex") streamCodex(res, { message, project: PROJECT_NAME, repoRoot: REPO_ROOT, threadId: body?.sessionId, newChat, context, origin, model, mode, cloud, providerEnv, approval });
      else streamClaude(res, { message, project: PROJECT_NAME, repoRoot: REPO_ROOT, sessionId: body?.sessionId, newChat, context, origin, model, mode, cloud, providerEnv, approval });
    } catch (e) {
      send(res, 500, { error: e instanceof Error ? e.message : String(e) }, origin);
    }
    return;
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.pattern);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    try {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      const result = await r.handler(params, body);
      return send(res, 200, result, origin);
    } catch (e) {
      captureException(e, { source: "sidecar-route", path: url.pathname, method: req.method });
      return send(res, 500, { error: e instanceof Error ? e.message : String(e) }, origin);
    }
  }
  send(res, 404, { error: "not found" }, origin);
});

// Parent-death watchdog. The desktop app spawns this sidecar as a child; if the
// app dies WITHOUT killing us — notably an auto-update `relaunch()`, which
// hard-exits and never fires the window-destroyed handler, or a crash / Task
// Manager kill / reinstall — we'd otherwise linger as an orphan holding the port.
// The NEW app's sidecar would then hit EADDRINUSE and the stale (older) process
// would keep serving outdated routes, so the refreshed UI sees 404s / "server not
// reachable".
//
// CROSS-PLATFORM liveness: the old check relied on Unix reparent-to-init (ppid → 1),
// which NEVER happens on Windows — there the orphan's ppid keeps pointing at the
// dead parent, so the watchdog never fired and engines lived forever (the Windows
// "engine unreachable / port in use" bug). `process.kill(pid, 0)` throws when the
// parent is gone — on Windows too — so probe THAT instead. (Skipped in dev, where
// there is no parent app to outlive.)
const PARENT_PID = process.ppid;
if (PARENT_PID > 1) {
  setInterval(() => {
    if (!isProcessAlive(PARENT_PID) || process.ppid <= 1) {
      log.info("parent app exited — shutting down sidecar");
      void flushObservability().finally(() => process.exit(0));
    }
  }, 1500).unref();
}

// Bind to loopback (127.0.0.1) ONLY, never 0.0.0.0 (#22): the sidecar runs
// connectors with the user's credentials and spawns their authenticated CLIs,
// so it must be reachable only from this machine — not exposed on the LAN.
const HOST = "127.0.0.1";

// On EADDRINUSE, RETRY rather than give up: right after an app relaunch the
// previous sidecar may still be releasing the port (its watchdog is exiting), so
// brief contention is expected. After a few failed retries the holder is NOT
// transiently releasing — it's a stale orphan — so reclaim the port once, then
// keep retrying, so the new (current-version) sidecar reliably wins.
let bindAttempts = 0;
let reclaimAttempted = false;
const MAX_BIND_ATTEMPTS = 15;
const RECLAIM_AFTER_ATTEMPTS = 5;
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    bindAttempts += 1;
    if (bindAttempts >= RECLAIM_AFTER_ATTEMPTS && !reclaimAttempted) {
      reclaimAttempted = true;
      console.error(`gtmgrid server: port ${PORT} held after ${bindAttempts} attempts — reclaiming from stale holder`);
      reclaimPort(PORT, log);
    }
    if (bindAttempts >= MAX_BIND_ATTEMPTS) {
      console.error(`gtmgrid server: port ${PORT} still in use after ${bindAttempts} attempts — giving up.`);
      process.exit(0);
    }
    setTimeout(() => server.listen(PORT, HOST), 1000);
    return;
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.error(`gtmgrid server on http://${HOST}:${PORT} (project: )`);
  // Boot-success signal over posthog-node — the only desktop telemetry channel
  // that delivers from packaged builds (the renderer's posthog-js is blocked by
  // the Tauri webview origin, and the Rust shell only reports failures). Tagged
  // with platform/arch so we can see whether the sidecar actually boots per OS —
  // the missing signal that left a Windows "engine unreachable" invisible.
  captureServerEvent("sidecar_listening", {
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    port: PORT,
    // The resolved agent working directory + whether it came from the desktop
    // shell's GTMGRID_AGENT_CWD (the defined ~/.gtmgrid/workspace) or fell back to
    // the install-relative dir — surfaces the old Windows "agent ran out of a random
    // repo" drift directly in PostHog, on every boot.
    repo_root: REPO_ROOT,
    agent_cwd_source: process.env.GTMGRID_AGENT_CWD ? "env" : "fallback",
  });
});

// NOTE: the LOCAL desktop does NOT run a recurring poller — a social-signal table
// pulls once when created (with a short warm-up retry while Trigify scrapes), and
// can be re-synced on demand via POST /api/signals/:id/sync. Recurring/scheduled
// auto-refresh is a CLOUD-only feature (the Inngest cron worker), since a desktop
// "cron" can't run while the app is closed anyway.
