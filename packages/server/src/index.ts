#!/usr/bin/env node
// gtmgrid HTTP server — the engine sidecar the desktop UI talks to.
// Plain node:http, JSON REST. Project via GTMGRID_PROJECT (name or .db path).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { openProject, parseManifest, connectorFromManifest } from "@gtmgrid/engine";
import { detectAgents, streamClaude, streamCodex, setAgentPath, rescanAgents, type AgentKind } from "./agent.js";

const PROJECT = process.env.GTMGRID_PROJECT ?? "default";
const PORT = Number(process.env.GTMGRID_PORT ?? 8787);
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SERVER_DIR, "..", "..", "..");
const { db, engine } = openProject(PROJECT);

// Seed bundled connector manifests (extensions/*.json shipped next to the
// server in the packaged app, or repo/extensions in dev) into the project.
function seedExtensions() {
  const dirs = [process.env.GTMGRID_EXT_DIR, join(SERVER_DIR, "extensions"), join(REPO_ROOT, "extensions")].filter(
    (d): d is string => !!d && existsSync(d),
  );
  const dir = dirs[0];
  if (!dir) return;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      const manifest = parseManifest(readFileSync(join(dir, file), "utf8"));
      db.saveExtension(manifest as any);
      engine.registry.add(connectorFromManifest(manifest));
    } catch (err) {
      console.error(`seed extension ${file} failed:`, err instanceof Error ? err.message : err);
    }
  }
}
seedExtensions();

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
const tableSummary = (t: { id: string; name: string }) => ({
  id: t.id,
  name: t.name,
  columns: db.listColumns(t.id).length,
  rows: db.listRows(t.id).length,
});

function fullTable(tableId: string) {
  const t = db.getTable(tableId);
  if (!t) return null;
  const columns = db.listColumns(t.id).map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    kind: c.kind,
    provider: c.provider,
    method: c.method,
    fn: c.provider ? `${c.provider}.${c.method}` : c.code ? "code" : null,
    params: c.params,
  }));
  const rows = db.listRows(t.id).map((r) => {
    const cells = db.rowCells(r.id);
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
route("GET", "/api/health", () => ({ ok: true, project: PROJECT }));

route("GET", "/api/functions", () =>
  engine.registry.list().map((c) => ({
    provider: c.id,
    name: c.name,
    category: c.category,
    requiresCredential: !!c.auth,
    methods: c.methods.map((m) => ({ method: m.id, label: m.label, description: m.description, credits: m.credits })),
  })),
);

route("GET", "/api/extensions", () =>
  db.listExtensions().map((e: any) => ({
    id: e.id,
    name: e.name,
    category: e.category,
    methods: (e.methods ?? []).length,
    connected: !!db.getCredential(e.id),
  })),
);

route("GET", "/api/tables", () => db.listTables().map(tableSummary));
route("POST", "/api/tables", (_p, body) => tableSummary(db.createTable(body?.name ?? "Untitled")));
route("GET", "/api/tables/:id", (p) => fullTable(p.id) ?? { error: "not found" });

route("POST", "/api/tables/:id/columns", (p, body) => {
  const provider = body.fn ? String(body.fn).split(".")[0] : null;
  const method = body.fn ? String(body.fn).split(".")[1] : null;
  const kind = provider || body.code ? "function" : "manual";
  const col = db.createColumn({
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
  const row = db.createRow(p.id);
  if (body?.cells) {
    for (const [colId, value] of Object.entries(body.cells)) {
      db.setCell(row.id, colId, { value, status: "done" });
    }
  }
  return { id: row.id };
});

route("POST", "/api/cells", (_p, body) => {
  db.setCell(body.rowId, body.columnId, { value: body.value, status: "done" });
  return { ok: true };
});

route("POST", "/api/columns/:id/run", async (p, body) => {
  const res = await engine.runColumn(p.id, { force: !!body?.force, concurrency: body?.concurrency ?? 5 });
  return res;
});

route("POST", "/api/columns/:id/update", (p, body) => {
  const col = db.updateColumn(p.id, body ?? {});
  return col ? { ok: true, tableId: col.table_id, id: col.id } : { error: "not found" };
});

route("POST", "/api/extensions/:id/connect", (p, body) => {
  db.saveCredential({ extensionId: p.id, scope: "local", name: "default", secrets: body?.secrets ?? {} });
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
function send(res: ServerResponse, status: number, data: unknown) {
  const json = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
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
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url ?? "/", "http://localhost");

  // Agent chat is a long-lived SSE stream — handled outside the JSON router.
  if (req.method === "POST" && url.pathname === "/api/agent/chat") {
    const body = await readBody(req);
    const agent = body?.agent ?? "claude";
    const message = String(body?.message ?? "");
    if (!message) return send(res, 400, { error: "message required" });
    try {
      const context = body?.context;
      if (agent === "codex") streamCodex(res, { message, project: PROJECT, repoRoot: REPO_ROOT, threadId: body?.sessionId, context });
      else streamClaude(res, { message, project: PROJECT, repoRoot: REPO_ROOT, sessionId: body?.sessionId, context });
    } catch (e) {
      send(res, 500, { error: e instanceof Error ? e.message : String(e) });
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
      return send(res, 200, result);
    } catch (e) {
      return send(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  send(res, 404, { error: "not found" });
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`gtmgrid server: port ${PORT} already in use — assuming another instance is running.`);
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, () => {
  console.error(`gtmgrid server on http://localhost:${PORT} (project: ${PROJECT})`);
});
