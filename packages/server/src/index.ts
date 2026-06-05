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
import { detectAgents, streamClaude, streamCodex, setAgentPath, rescanAgents, type AgentKind } from "./agent.js";
import { runCloudColumn, defaultCloudRunDeps } from "./cloud-run.js";
import { corsHeadersFor, isOriginAllowed } from "./cors.js";

const PORT = Number(process.env.GTMGRID_PORT ?? 8787);
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SERVER_DIR, "..", "..", "..");

// ── Shared global db: credentials, extensions, AI config (across all projects).
const globalDb = new Db(globalDbPath());
migrateGlobals(globalDb, projectPath("default")); // one-time: pull legacy keys in

// Registry of callable functions (built-ins + uploaded manifests in globalDb).
const registry = defaultRegistry();

// Seed bundled connector manifests (extensions/*.json shipped next to the server
// in the packaged app, or repo/extensions in dev) into the GLOBAL db + registry.
function seedExtensions() {
  const dirs = [process.env.GTMGRID_EXT_DIR, join(SERVER_DIR, "extensions"), join(REPO_ROOT, "extensions")].filter(
    (d): d is string => !!d && existsSync(d),
  );
  const dir = dirs[0];
  if (!dir) return;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      const manifest = parseManifest(readFileSync(join(dir, file), "utf8"));
      globalDb.saveExtension(manifest as any);
      registry.add(connectorFromManifest(manifest));
    } catch (err) {
      console.error(`seed extension ${file} failed:`, err instanceof Error ? err.message : err);
    }
  }
}
seedExtensions();
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

// --- AI providers (bring-your-own-key for AI step functions) ---
// `fallbackModels` is only used if the live /v1/models fetch fails (offline,
// bad key). When connected, the real model list is pulled from the provider.
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
] as const;

type AiProviderId = (typeof AI_PROVIDERS)[number]["id"];

// Live model lists, fetched from each provider's API with the connected key.
// Cached per provider for a short TTL so we don't hit the API on every poll.
const modelCache = new Map<string, { key: string; models: string[]; ts: number }>();
const MODEL_TTL_MS = 10 * 60 * 1000;

async function fetchModels(provider: AiProviderId, apiKey: string): Promise<string[] | null> {
  const cached = modelCache.get(provider);
  if (cached && cached.key === apiKey && Date.now() - cached.ts < MODEL_TTL_MS) return cached.models;
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
    modelCache.set(provider, { key: apiKey, models, ts: Date.now() });
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
        : undefined;
  const envKeyFor = (id: string) =>
    id === "anthropic"
      ? process.env.ANTHROPIC_API_KEY
      : id === "openai"
        ? process.env.OPENAI_API_KEY
        : id === "openrouter"
          ? process.env.OPENROUTER_API_KEY
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
      // Pull the real model list when connected; fall back to the static list.
      let models: string[] = [...p.fallbackModels];
      if (connected && apiKey) {
        const live = await fetchModels(p.id, apiKey);
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
        connectedScopes: hasKey ? globalDb.credentialScopes(`ai:${p.id}`) : [],
      };
    }),
  );
});

route("POST", "/api/ai-providers/:id/connect", (p, body) => {
  if (p.id !== "anthropic" && p.id !== "openai" && p.id !== "openrouter")
    return { error: "unsupported provider" };
  const apiKey = String(body?.apiKey ?? "").trim();
  if (!apiKey) return { error: "apiKey required" };
  connectAi(globalDb, p.id, apiKey, undefined, normScope(body?.scope));
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

route("POST", "/api/cells", (_p, body) => {
  current.projectDb.setCell(body.rowId, body.columnId, { value: body.value, status: "done" });
  return { ok: true };
});

route("POST", "/api/columns/:id/run", async (p, body) => {
  const rowIds = Array.isArray(body?.rowIds) && body.rowIds.length ? (body.rowIds as string[]) : undefined;
  const res = await current.engine.runColumn(p.id, { force: !!body?.force, concurrency: body?.concurrency ?? 5, rowIds });
  return res;
});

// --- cloud run path (T9) ---
// Running a column on a CLOUD project: build an Engine whose store is the
// Convex-backed ConvexGridStore (authed as the signed-in member), so inputs are
// read from Convex and statuses/results stream back live to all members. LOCAL
// projects keep the route above unchanged. The registry + AI config are the
// sidecar's existing ones, so connectors/AI columns behave identically.
route("POST", "/api/cloud/columns/run", async (_p, body) => {
  const convexUrl = String(body?.convexUrl ?? "").trim();
  const token = String(body?.token ?? "").trim();
  const tableId = String(body?.tableId ?? "").trim();
  const columnId = String(body?.columnId ?? "").trim();
  if (!convexUrl || !token || !tableId || !columnId)
    return { error: "convexUrl, token, tableId and columnId are required" };
  const rowIds = Array.isArray(body?.rowIds) && body.rowIds.length ? (body.rowIds as string[]) : undefined;
  const deps = defaultCloudRunDeps(registry, aiConfig());
  // The engine constructor needs a Db for its (unused on this path) db fields;
  // reuse the shared global db so no new SQLite file is created.
  return runCloudColumn(
    { convexUrl, token, tableId, columnId, force: !!body?.force, concurrency: body?.concurrency ?? 5, rowIds },
    deps,
    globalDb,
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

// Manually connect a CLI (set its path) and/or rescan after install.
route("POST", "/api/agents/connect", (_p, body) => {
  const agent = body?.agent as AgentKind;
  if ((agent === "claude" || agent === "codex") && typeof body?.path === "string" && body.path.trim()) {
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
    ...(corsHeadersFor(origin) ?? {}),
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
      const context = body?.context;
      if (agent === "codex") streamCodex(res, { message, project: current.name, repoRoot: REPO_ROOT, threadId: body?.sessionId, context, origin });
      else streamClaude(res, { message, project: current.name, repoRoot: REPO_ROOT, sessionId: body?.sessionId, context, origin });
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
      return send(res, 500, { error: e instanceof Error ? e.message : String(e) }, origin);
    }
  }
  send(res, 404, { error: "not found" }, origin);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`gtmgrid server: port ${PORT} already in use — assuming another instance is running.`);
    process.exit(0);
  }
  throw err;
});

// Bind to loopback (127.0.0.1) ONLY, never 0.0.0.0 (#22): the sidecar runs
// connectors with the user's credentials and spawns their authenticated CLIs,
// so it must be reachable only from this machine — not exposed on the LAN.
const HOST = "127.0.0.1";
server.listen(PORT, HOST, () => {
  console.error(`gtmgrid server on http://${HOST}:${PORT} (project: ${current.name})`);
});
