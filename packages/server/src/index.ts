#!/usr/bin/env node
// gtmgrid HTTP server — the engine sidecar the desktop UI talks to.
// Plain node:http, JSON REST. Project via GTMGRID_PROJECT (name or .db path).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  Db,
  Engine,
  defaultRegistry,
  parseManifest,
  connectorFromManifest,
  connectAi,
  storedAiConfig,
  storedAiProviders,
  aiConfigFromEnv,
  globalDbPath,
  projectPath,
  migrateGlobals,
  listProjects,
} from "@gtmgrid/engine";
import type { CellProgress } from "@gtmgrid/engine";
import { detectAgents, streamClaude, streamCodex, streamHermes, setAgentPath, rescanAgents, getHermesConn, setHermesConn, type AgentKind, type HermesConn } from "./agent.js";
import { streamHermesRemote } from "./hermes-remote.js";
import { listAgentSessions, readAgentSession } from "./agent-history.js";
import { runCloudColumn, defaultCloudRunDeps } from "./cloud-run.js";
import { corsHeadersFor, isOriginAllowed } from "./cors.js";
import { Semaphore } from "./semaphore.js";
import {
  SIGNAL_SOURCES,
  getSource,
  listBindings,
  upsertBinding,
  deleteBinding,
  newBinding,
  syncBinding,
  warmUpBinding,
  type SignalDeps,
  type SignalSchedule,
} from "./signals.js";

const PORT = Number(process.env.GTMGRID_PORT ?? 8787);
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SERVER_DIR, "..", "..", "..");

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

// AI config resolved from the global db (env wins for the active provider).
function aiConfig() {
  return { ai: aiConfigFromEnv() ?? storedAiConfig(globalDb), aiProviders: storedAiProviders(globalDb) };
}

// ── Current project (swappable in-process, no sidecar restart).
interface Current {
  name: string;
  path: string;
  projectDb: Db;
  engine: Engine;
}
let current!: Current;

function switchTo(name: string): Current {
  const path = projectPath(name);
  const projectDb = new Db(path);
  const engine = new Engine(projectDb, aiConfig(), registry, globalDb);
  current = { name, path, projectDb, engine };
  globalDb.setMeta("current_project", name);
  let recents: string[] = [];
  try {
    recents = JSON.parse(globalDb.getMeta("recent_projects") || "[]");
  } catch {
    /* ignore */
  }
  globalDb.setMeta("recent_projects", JSON.stringify([name, ...recents.filter((r) => r !== name)].slice(0, 12)));
  return current;
}

switchTo(process.env.GTMGRID_PROJECT ?? globalDb.getMeta("current_project") ?? "default");

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

const tableSummary = (t: { id: string; name: string }) => ({
  id: t.id,
  name: t.name,
  columns: current.projectDb.listColumns(t.id).length,
  rows: current.projectDb.listRows(t.id).length,
  favorite: current.projectDb.isFavorite(t.id),
});

function fullTable(tableId: string) {
  const t = current.projectDb.getTable(tableId);
  if (!t) return null;
  const columns = current.projectDb.listColumns(t.id).map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    kind: c.kind,
    provider: c.provider,
    method: c.method,
    fn: c.provider ? `${c.provider}.${c.method}` : c.code ? "code" : null,
    params: c.params,
  }));
  const rows = current.projectDb.listRows(t.id).map((r) => {
    const cells = current.projectDb.rowCells(r.id);
    const out: Record<string, { value: unknown; status: string; error: string | null }> = {};
    for (const c of columns) {
      const cell = cells.get(c.id);
      out[c.id] = cell
        ? { value: cell.value, status: cell.status, error: cell.error }
        : { value: null, status: "empty", error: null };
    }
    return { id: r.id, cells: out };
  });
  return { id: t.id, name: t.name, columns, rows };
}

// --- routes ---
//
// METERING (C26): these are the LOCAL sidecar routes — `/api/cells`,
// `/api/columns/:id/run`, `/api/tables/:id/rows`, etc. They operate on the local
// SQLite project (`current.projectDb` / `current.engine`) entirely on the user's
// machine and NEVER touch Convex or our cost. They are INTENTIONALLY UNMETERED:
// local actions are unlimited and unmetered on EVERY tier (free included) and
// MUST NEVER increment the cloud_actions meter. The meter lives ONLY inside the
// Convex CLOUD mutations (convex/cells.ts, convex/tables.ts), which local
// projects never call — do NOT add any cloud_actions counting here or in the
// local engine. The ONE exception below (`/api/cloud/columns/run`) drives a
// CLOUD project: it writes via the Convex setCell/setCellStatus mutations, which
// do the metering once on the Convex side — so it stays unmetered HERE too (no
// double-count, and the sidecar holds no Autumn secret).
route("GET", "/api/health", () => ({ ok: true, project: current.name }));

// --- projects ---
route("GET", "/api/projects", () => {
  let recents: string[] = [];
  try {
    recents = JSON.parse(globalDb.getMeta("recent_projects") || "[]");
  } catch {
    /* ignore */
  }
  const projects = listProjects();
  // ensure the current project shows even if its file was just created
  if (!projects.some((p) => p.name === current.name)) {
    projects.unshift({ name: current.name, path: current.path, mtimeMs: Date.now() });
  }
  const rank = (n: string) => { const i = recents.indexOf(n); return i === -1 ? 1e9 : i; };
  return projects
    .map((p) => ({ ...p, current: p.name === current.name }))
    .sort((a, b) => rank(a.name) - rank(b.name));
});

route("POST", "/api/projects", (_p, body) => {
  const name = String(body?.name ?? "").trim().replace(/[/\\]/g, "");
  if (!name) return { error: "name required" };
  switchTo(name);
  return { ok: true, project: current.name };
});

route("POST", "/api/projects/switch", (_p, body) => {
  const name = String(body?.name ?? "").trim().replace(/[/\\]/g, "");
  if (!name) return { error: "name required" };
  switchTo(name);
  return { ok: true, project: current.name };
});

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
        credits: m.credits,
        input: m.inputSchema ?? null,
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
    featured: !!e.featured,
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

// --- Signals: bind a table to a Trigify saved search + poll new results in ---
function signalDeps(): SignalDeps {
  return { dispatch: (pr, m, i) => current.engine.dispatch(pr, m, i), projectDb: current.projectDb };
}

// Catalog of signal sources + each one's input schema (for the config form).
route("GET", "/api/signals/sources", () => ({
  trigifyConnected: !!globalDb.getCredential("trigify"),
  sources: SIGNAL_SOURCES.map((s) => {
    const m = registry.method("trigify", s.method);
    return {
      id: s.id,
      label: s.label,
      group: s.group,
      kind: s.kind,
      description: s.description,
      columns: s.columns,
      inputSchema: (m as any)?.inputSchema ?? null,
    };
  }),
}));

// Bindings in the current project (without the heavy `seen` dedupe window).
route("GET", "/api/signals", () =>
  listBindings(current.projectDb).map(({ seen: _seen, ...b }) => b),
);

// Create: table + columns + Trigify search + binding + initial pull.
route("POST", "/api/signals", async (_p, body) => {
  const source = getSource(String(body?.sourceId ?? ""));
  if (!source) return { error: "unknown signal source" };
  if (!globalDb.getCredential("trigify")) return { error: "Connect Trigify first (Tools → Trigify)." };
  const name = (String(body?.name ?? "").trim() || source.label).slice(0, 80);
  const config = (body?.config ?? {}) as Record<string, unknown>;
  const schedule = (["manual", "hourly", "daily", "weekly"].includes(body?.schedule) ? body.schedule : "daily") as SignalSchedule;

  const table = current.projectDb.createTable(name);
  for (const col of source.columns) {
    current.projectDb.createColumn({ tableId: table.id, name: col.name, type: "text", kind: "manual", provider: null, method: null, code: null, params: {} });
  }

  let searchId: string | null = null;
  try {
    const created: any = await current.engine.dispatch("trigify", source.method, { name, ...config });
    searchId = created?.id ?? created?.search_id ?? created?.data?.id ?? created?.search?.id ?? null;
  } catch (e) {
    current.projectDb.deleteTable(table.id);
    return { error: `Could not create the Trigify search: ${e instanceof Error ? e.message : String(e)}` };
  }

  const binding = newBinding({ tableId: table.id, source, config: { name, ...config }, schedule, searchId });
  upsertBinding(current.projectDb, binding);
  const sync = await syncBinding(signalDeps(), binding);
  // Results populate async — keep retrying in the background until rows land.
  if (!sync.error && sync.added === 0) void warmUpBinding(signalDeps(), binding.id);
  return { tableId: table.id, bindingId: binding.id, searchId, added: sync.added, error: sync.error ?? null };
});

// Manual "pull now".
route("POST", "/api/signals/:id/sync", async (p) => {
  const b = listBindings(current.projectDb).find((x) => x.id === p.id);
  if (!b) return { error: "not found" };
  const r = await syncBinding(signalDeps(), b);
  return { ok: !r.error, added: r.added, error: r.error ?? null };
});

route("POST", "/api/signals/:id/toggle", (p, body) => {
  const b = listBindings(current.projectDb).find((x) => x.id === p.id);
  if (!b) return { error: "not found" };
  b.enabled = (body as any)?.enabled !== false;
  upsertBinding(current.projectDb, b);
  return { ok: true, enabled: b.enabled };
});

route("DELETE", "/api/signals/:id", (p) =>
  deleteBinding(current.projectDb, p.id) ? { ok: true } : { error: "not found" },
);

// --- AI providers (bring-your-own-key for AI step functions) ---
// `fallbackModels` is only used if the live /v1/models fetch fails (offline,
// bad key). When connected, the real model list is pulled from the provider.
// Default Hermes gateway base URL — the user's SSH tunnel to the mac-mini
// api_server (localhost:18642 -> mac-mini:8642). Overridable per connection.
const DEFAULT_HERMES_BASE_URL = "http://localhost:18642/v1";
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
  const connectedProviders = new Set((current.engine.config.aiProviders ?? []).map((a) => a.provider));
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
        (current.engine.config.aiProviders ?? []).find((a) => a.provider === p.id)?.apiKey ??
        cred?.secrets.apiKey ??
        (viaEnv ? envKeyFor(p.id) : undefined);
      // Hermes is a configurable gateway — resolve its base URL (stored cred,
      // then env, then the default tunnel) so live model fetch + the UI prefill work.
      const baseUrl =
        p.id === "hermes"
          ? ((current.engine.config.aiProviders ?? []).find((a) => a.provider === "hermes")?.baseURL ??
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
  const apiKey = String(body?.apiKey ?? "").trim();
  const baseURL = String(body?.baseURL ?? body?.baseUrl ?? "").trim() || undefined;
  // Hermes (a local/LAN gateway) accepts any bearer when API_SERVER_KEY is unset,
  // so it can connect with just a base URL; the other providers require a key.
  if (!apiKey && p.id !== "hermes") return { error: "apiKey required" };
  connectAi(
    globalDb,
    p.id,
    apiKey || "hermes",
    undefined,
    normScope(body?.scope),
    p.id === "hermes" ? (baseURL ?? DEFAULT_HERMES_BASE_URL) : undefined,
  );
  // Refresh the live engine so AI columns work immediately — both the active
  // provider and the full set used for model-based routing.
  current.engine.config.ai = storedAiConfig(globalDb);
  current.engine.config.aiProviders = storedAiProviders(globalDb);
  return { ok: true };
});

route("GET", "/api/tables", () => current.projectDb.listTables().map(tableSummary));
route("POST", "/api/tables", (_p, body) => tableSummary(current.projectDb.createTable(body?.name ?? "Untitled")));
route("GET", "/api/tables/:id", (p) => fullTable(p.id) ?? { error: "not found" });

route("POST", "/api/tables/:id/update", (p, body) => {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return { error: "name required" };
  current.projectDb.renameTable(p.id, name);
  return { ok: true };
});

route("POST", "/api/tables/:id/delete", (p) => {
  current.projectDb.deleteTable(p.id);
  return { ok: true };
});

route("POST", "/api/tables/:id/favorite", (p, body) => {
  current.projectDb.setFavorite(p.id, body?.favorite !== false);
  return { ok: true, favorite: current.projectDb.isFavorite(p.id) };
});

route("POST", "/api/tables/:id/columns", (p, body) => {
  const provider = body.fn ? String(body.fn).split(".")[0] : null;
  const method = body.fn ? String(body.fn).split(".")[1] : null;
  const kind = provider || body.code ? "function" : "manual";
  const col = current.projectDb.createColumn({
    tableId: p.id,
    name: body.name ?? "Column",
    type: body.type ?? "text",
    kind,
    provider,
    method,
    code: body.code ?? null,
    params: body.params ?? {},
  });
  return { id: col.id };
});

route("POST", "/api/tables/:id/rows", (p, body) => {
  const row = current.projectDb.createRow(p.id);
  if (body?.cells) {
    for (const [colId, value] of Object.entries(body.cells)) {
      current.projectDb.setCell(row.id, colId, { value, status: "done" });
    }
  }
  return { id: row.id };
});

// Bulk row insert for CSV import: create many rows + their cells in ONE
// better-sqlite3 transaction (fast + atomic). Each row is a `{ columnId: value }`
// map; empty values are skipped so the cell stays empty. LOCAL projects only —
// never metered (local is unlimited on every tier).
route("POST", "/api/tables/:id/rows/bulk", (p, body) => {
  const inputRows: Array<Record<string, unknown>> = Array.isArray(body?.rows)
    ? body.rows
    : [];
  const rowIds: string[] = [];
  const insertAll = current.projectDb.raw.transaction(
    (rows: Array<Record<string, unknown>>) => {
      for (const cells of rows) {
        const row = current.projectDb.createRow(p.id);
        rowIds.push(row.id);
        if (cells) {
          for (const [colId, value] of Object.entries(cells)) {
            if (value === "" || value === null || value === undefined) continue;
            current.projectDb.setCell(row.id, colId, { value, status: "done" });
          }
        }
      }
    },
  );
  insertAll(inputRows);
  return { rowIds };
});

route("POST", "/api/cells", (_p, body) => {
  current.projectDb.setCell(body.rowId, body.columnId, { value: body.value, status: "done" });
  return { ok: true };
});

route("POST", "/api/columns/:id/run", async (p, body) => {
  const rowIds = Array.isArray(body?.rowIds) && body.rowIds.length ? (body.rowIds as string[]) : undefined;
  // Bound the number of simultaneous runs process-wide (M6): a run waits for a
  // permit before fanning out, so concurrent runs queue instead of all spiking
  // the single sidecar at once.
  return runLimiter.run(() =>
    current.engine.runColumn(p.id, { force: !!body?.force, concurrency: body?.concurrency ?? 5, rowIds }),
  );
});

// --- cloud run path (T9) ---
// Running a column on a CLOUD project: build an Engine whose store is the
// cloud-backed GridStore (POSTing to the apps/web `/api/worker/*` endpoints), so
// inputs are read from Postgres and statuses/results stream back live to all
// members via the realtime broadcast the server emits. LOCAL projects keep the
// route above unchanged. The registry + AI config are the sidecar's existing
// ones, so connectors/AI columns behave identically.
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

route("POST", "/api/columns/:id/update", (p, body) => {
  const col = current.projectDb.updateColumn(p.id, body ?? {});
  return col ? { ok: true, tableId: col.table_id, id: col.id } : { error: "not found" };
});

route("POST", "/api/columns/:id/delete", (p) => {
  current.projectDb.deleteColumn(p.id);
  return { ok: true };
});

route("POST", "/api/rows/:id/delete", (p) => {
  current.projectDb.deleteRow(p.id);
  return { ok: true };
});

route("POST", "/api/cells/delete", (_p, body) => {
  if (body?.rowId && body?.columnId) current.projectDb.deleteCell(body.rowId, body.columnId);
  return { ok: true };
});

route("POST", "/api/extensions/:id/connect", (p, body) => {
  globalDb.saveCredential({ extensionId: p.id, scope: normScope(body?.scope), name: "default", secrets: body?.secrets ?? {} });
  return { ok: true };
});

route("GET", "/api/agents", () => detectAgents());

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
  if ((agent === "claude" || agent === "codex" || agent === "hermes") && typeof body?.path === "string" && body.path.trim()) {
    setAgentPath(agent, body.path.trim());
  }
  rescanAgents();
  return detectAgents();
});

// Read the Hermes connection (mode + remote URL/model; never returns the key).
route("GET", "/api/agents/hermes-config", () => {
  const conn = getHermesConn();
  return { mode: conn?.mode ?? "local", url: conn?.url ?? "", model: conn?.model ?? "", hasKey: !!conn?.apiKey };
});

// Save the Hermes connection: local binary (ACP) vs remote gateway brain (URL/key).
route("POST", "/api/agents/hermes-config", (_p, body) => {
  const mode: HermesConn["mode"] = body?.mode === "remote" ? "remote" : "local";
  const trimmed = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  // Partial updates preserve existing values, so toggling Local<->Remote never
  // wipes the saved gateway URL/key/model. Blank fields keep what's stored.
  const prev = getHermesConn();
  const apiKey = trimmed(body?.apiKey) ?? prev?.apiKey;
  const url = trimmed(body?.url) ?? prev?.url;
  const model = trimmed(body?.model) ?? prev?.model;
  setHermesConn({ mode, url, apiKey, model });
  rescanAgents();
  return { ok: true, agents: detectAgents() };
});

// Probe a remote Hermes gateway: GET {url}/models with the bearer key.
route("POST", "/api/agents/hermes-test", async (_p, body) => {
  const url = String(body?.url ?? "").trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
  const apiKey = String(body?.apiKey ?? "").trim();
  if (!url) return { ok: false, error: "url required" };
  try {
    const r = await fetch(`${url}/v1/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
    if (!r.ok) return { ok: false, error: `gateway ${r.status} ${r.statusText}` };
    const data = (await r.json().catch(() => ({}))) as { data?: Array<{ id: string }> };
    return { ok: true, models: Array.isArray(data.data) ? data.data.map((m) => m.id) : [] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
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
      const providers = current.engine.registry.list().map((c) => ({
        id: c.id,
        name: c.name,
        category: c.category,
        methodCount: c.methods.length,
      }));
      // Inject the operating playbook for every CONNECTED tool (so the agent
      // stops guessing endpoints), plus any enabled custom skills. Only connected
      // tools are included to keep the system prompt bounded.
      const toolSkills = current.engine.registry
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
      if (agent === "hermes") {
        // Remote "brain": GTM Grid runs the grid tools locally, gateway is the model.
        const conn = getHermesConn();
        if (conn?.mode === "remote")
          streamHermesRemote(res, { message, project: current.name, repoRoot: REPO_ROOT, url: conn.url, apiKey: conn.apiKey, model: conn.model || model, context, origin });
        else streamHermes(res, { message, project: current.name, repoRoot: REPO_ROOT, sessionId: body?.sessionId, context, origin, model });
      }
      else if (agent === "codex") streamCodex(res, { message, project: current.name, repoRoot: REPO_ROOT, threadId: body?.sessionId, context, origin, model });
      else streamClaude(res, { message, project: current.name, repoRoot: REPO_ROOT, sessionId: body?.sessionId, context, origin, model });
    } catch (e) {
      send(res, 500, { error: e instanceof Error ? e.message : String(e) }, origin);
    }
    return;
  }

  // LOCAL run progress stream (TRI-3275): run a function column on the local
  // SQLite project and stream per-cell progress as Server-Sent Events so the
  // desktop patches only the changed cells as they complete — instead of running
  // blind then refetching+replacing the whole grid. This is the SSE twin of the
  // JSON `POST /api/columns/:id/run` route, handled here because the JSON router
  // can't keep a streaming response open. CORS stays allowlisted, never `*` (#22).
  {
    const m = req.method === "POST" && url.pathname.match(/^\/api\/columns\/([^/]+)\/run\/stream$/);
    if (m) {
      const columnId = decodeURIComponent(m[1]);
      const body = await readBody(req);
      const rowIds =
        Array.isArray(body?.rowIds) && body.rowIds.length ? (body.rowIds as string[]) : undefined;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...corsHeadersFor(origin),
      });
      const write = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      try {
        const summary = await current.engine.runColumn(columnId, {
          force: !!body?.force,
          concurrency: body?.concurrency ?? 5,
          rowIds,
          onCell: (cell: CellProgress) =>
            write({
              type: "cell",
              rowId: cell.rowId,
              columnId: cell.columnId,
              cell: { value: cell.value, status: cell.status, error: cell.error },
            }),
        });
        write({ type: "done", ran: summary.ran, errors: summary.errors });
      } catch (e) {
        write({ type: "error", error: e instanceof Error ? e.message : String(e) });
      }
      res.end();
      return;
    }
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
      return send(res, 500, { error: e instanceof Error ? e.message : String(e) }, origin);
    }
  }
  send(res, 404, { error: "not found" }, origin);
});

// Parent-death watchdog. The desktop app spawns this sidecar as a child; if the
// app dies WITHOUT killing us — notably an auto-update `relaunch()`, which
// hard-exits and never fires the window-destroyed handler — we'd otherwise linger
// as an orphan holding the port. The NEW app's sidecar would then hit EADDRINUSE
// and the stale (older) process would keep serving outdated routes, so the
// refreshed UI sees 404s and reports "server not reachable". When orphaned we get
// reparented to init/launchd (ppid 1), so exit on that transition. (Skipped when
// launched directly from a shell in dev, where there is no parent app to outlive.)
const PARENT_PID = process.ppid;
if (PARENT_PID > 1) {
  setInterval(() => {
    if (process.ppid !== PARENT_PID || process.ppid <= 1) {
      console.error("gtmgrid server: parent app exited — shutting down sidecar.");
      process.exit(0);
    }
  }, 1500).unref();
}

// Bind to loopback (127.0.0.1) ONLY, never 0.0.0.0 (#22): the sidecar runs
// connectors with the user's credentials and spawns their authenticated CLIs,
// so it must be reachable only from this machine — not exposed on the LAN.
const HOST = "127.0.0.1";

// On EADDRINUSE, RETRY rather than give up: right after an app relaunch the
// previous sidecar may still be releasing the port (its watchdog is exiting), so
// brief contention is expected. Retry for a few seconds before failing, so the
// new (current-version) sidecar reliably wins the port.
let bindAttempts = 0;
const MAX_BIND_ATTEMPTS = 15;
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    bindAttempts += 1;
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
  console.error(`gtmgrid server on http://${HOST}:${PORT} (project: ${current.name})`);
});

// NOTE: the LOCAL desktop does NOT run a recurring poller — a social-signal table
// pulls once when created (with a short warm-up retry while Trigify scrapes), and
// can be re-synced on demand via POST /api/signals/:id/sync. Recurring/scheduled
// auto-refresh is a CLOUD-only feature (the Inngest cron worker), since a desktop
// "cron" can't run while the app is closed anyway.
