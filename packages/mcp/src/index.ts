#!/usr/bin/env node
// gtmgrid MCP server — exposes the grid (tables, columns, connectors, runs) as
// MCP tools over stdio, so Claude Code / Codex can build and run GTM pipelines.
//
// DATA SOURCE (TRI-3296): the project to operate on is resolved from the
// environment by `selectGridEnv`. In LOCAL mode (the default, and every
// pure-local build with no cloud context) the tools open the SQLite project
// named by GTMGRID_PROJECT via `openProject` — byte-identical to before. In
// CLOUD mode (GTMGRID_MODE=cloud + the threaded apiUrl/token/workspace/project/
// table) the table tools operate on the user's CLOUD (Supabase) project through
// the engine's cloud GridStore + the apps/web worker API. The mode is EXPLICIT
// (read from GTMGRID_MODE), never guessed inside a tool, and the bearer token is
// never logged.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openProject, parseManifest, connectorFromManifest } from "@gtmgrid/engine";
import { describeGridEnv, selectGridEnv } from "./cloud-context.js";
import {
  CloudToolUnsupportedError,
  defaultCloudSourceDeps,
  makeCloudSource,
} from "./cloud-source.js";

const gridEnv = selectGridEnv(process.env);

// LOCAL mode opens the SQLite project (and exposes its registry of connectors).
// CLOUD mode opens NO SQLite file (the engine is Db-free, backed by the cloud
// store); it still needs a registry for connector discovery + cloud runs, so we
// reuse the cloud source's registry/config and skip `openProject` entirely.
const local = gridEnv.mode === "local" ? openProject(gridEnv.project) : undefined;
const cloudDeps = gridEnv.mode === "cloud" ? defaultCloudSourceDeps() : undefined;
const cloudSource =
  gridEnv.mode === "cloud" && cloudDeps
    ? makeCloudSource(gridEnv.context, cloudDeps)
    : undefined;

// The registry the discovery + run_function tools read from. In local mode it is
// the project's (with uploaded extensions loaded); in cloud mode it is the
// default registry on the cloud deps.
const registry = local ? local.engine.registry : cloudDeps!.registry;

const server = new McpServer({ name: "gtmgrid", version: "0.0.1" });

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

/** LOCAL-only helper: resolve a table by id/name on the SQLite project. */
const localTableOr = (ref: string) => {
  const t = local!.db.resolveTable(ref);
  if (!t) throw new Error(`No table "${ref}". Use list_tables.`);
  return t;
};

/** Reject a write tool that the cloud worker boundary does not yet expose. */
const cloudUnsupported = (tool: string): never => {
  throw new CloudToolUnsupportedError(tool);
};

// --- Discovery: what enrichments/functions exist ---
// Three tiers: list_providers (lightweight catalog), search_functions (intent
// search), list_functions (full schema — scoped to one provider, else huge).
server.tool(
  "list_providers",
  "FIRST CALL for discovery. Lightweight catalog: each connector's id, name, category and method count. Use this to find the right provider, then narrow with search_functions or list_functions(provider).",
  {},
  async () =>
    ok(
      registry.list().map((c) => ({
        provider: c.id,
        name: c.name,
        category: c.category,
        requiresCredential: !!c.auth,
        methodCount: c.methods.length,
      })),
    ),
);

server.tool(
  "search_functions",
  "Search the function catalog by keyword (matches method id, label and description). Returns concise hits as 'provider.method — label — description'. Use this when you know WHAT you want (e.g. 'enrich linkedin profile', 'send slack message', 'find email') but not WHICH connector.",
  {
    query: z.string().describe("Free-text intent, e.g. 'enrich linkedin', 'find email', 'monitor twitter'"),
    provider: z.string().optional().describe("Optional: restrict to one provider id"),
    limit: z.number().optional().describe("Max hits (default 30)"),
  },
  async ({ query, provider, limit }) => {
    const q = query.toLowerCase().trim();
    const terms = q.split(/\s+/).filter(Boolean);
    const hits: { fn: string; label: string; description: string; score: number }[] = [];
    for (const c of registry.list()) {
      if (provider && c.id !== provider) continue;
      for (const m of c.methods) {
        const hay = `${m.id} ${m.label} ${m.description} ${c.id} ${c.name} ${c.category}`.toLowerCase();
        let score = 0;
        for (const t of terms) if (hay.includes(t)) score += 1;
        if (score === 0) continue;
        hits.push({ fn: `${c.id}.${m.id}`, label: m.label, description: m.description.slice(0, 160), score });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return ok({ query, matches: hits.slice(0, limit ?? 30) });
  },
);

server.tool(
  "list_functions",
  "Full method list with INPUT SCHEMAS. WARNING: with many extensions installed this can be HUGE — prefer list_providers + search_functions first, then call this scoped to one provider (e.g. provider:'trigify') to get just its methods.",
  { provider: z.string().optional().describe("Restrict to one provider id (recommended)") },
  async ({ provider }) =>
    ok(
      registry
        .list()
        .filter((c) => !provider || c.id === provider)
        .map((c) => ({
          provider: c.id,
          name: c.name,
          category: c.category,
          requiresCredential: !!c.auth,
          methods: c.methods.map((m) => ({
            method: m.id,
            label: m.label,
            description: m.description,
            credits: m.credits,
            inputSchema: m.inputSchema,
          })),
        })),
    ),
);

server.tool("list_tables", "List all tables in the project with their column and row counts.", {}, async () => {
  if (cloudSource) return ok(await cloudSource.listTables());
  return ok(
    local!.db.listTables().map((t) => ({
      id: t.id,
      name: t.name,
      columns: local!.db.listColumns(t.id).length,
      rows: local!.db.listRows(t.id).length,
    })),
  );
});

server.tool("create_table", "Create a new table.", { name: z.string() }, async ({ name }) => {
  if (cloudSource) return ok(await cloudSource.createTable(name));
  const t = local!.db.createTable(name);
  return ok({ id: t.id, name: t.name });
});

server.tool(
  "add_column",
  "Add a column. For a function column, set `fn` to 'provider.method' (see list_functions) OR provide custom `code` (a JS body: function(inputs, sdk){...}). `params` maps inputs to values; use {{Column Name}} templates to inject other cells, e.g. { username: '{{Username}}' }.",
  {
    table: z.string(),
    name: z.string(),
    fn: z.string().optional().describe("'provider.method', e.g. 'github.getUser' or 'ai.generate'"),
    code: z.string().optional().describe("Custom QuickJS body: function(inputs, sdk){ ... }"),
    type: z.enum(["text", "number", "boolean", "date", "json"]).optional(),
    params: z.record(z.string(), z.any()).optional(),
  },
  async ({ table, name, fn, code, type, params }) => {
    if (cloudSource) {
      return ok(
        await cloudSource.addColumn(table, {
          name,
          ...(fn !== undefined ? { fn } : {}),
          ...(code !== undefined ? { code } : {}),
          ...(type !== undefined ? { type } : {}),
          ...(params !== undefined ? { params } : {}),
        }),
      );
    }
    const t = localTableOr(table);
    let provider: string | null = null;
    let method: string | null = null;
    if (fn) {
      const [p, m] = fn.split(".");
      if (!p || !m) throw new Error("fn must be 'provider.method'");
      if (!registry.method(p, m)) throw new Error(`Unknown function ${fn}. Use list_functions.`);
      provider = p;
      method = m;
    }
    const kind = provider || code ? "function" : "manual";
    const col = local!.db.createColumn({ tableId: t.id, name, type: type ?? "text", kind, provider, method, code: code ?? null, params: params ?? {} });
    return ok({ id: col.id, name: col.name, kind, fn: fn ?? null });
  },
);

server.tool(
  "add_rows",
  "Add one or more rows. Each row is an object of { ColumnName: value } for manual columns, e.g. [{ Username: 'torvalds' }].",
  { table: z.string(), rows: z.array(z.record(z.string(), z.any())) },
  async ({ table, rows }) => {
    if (cloudSource) return ok(await cloudSource.addRows(table, rows));
    const t = localTableOr(table);
    const created: string[] = [];
    for (const r of rows) {
      const row = local!.db.createRow(t.id);
      for (const [colName, val] of Object.entries(r)) {
        const col = local!.db.resolveColumn(t.id, colName);
        if (!col) throw new Error(`No column "${colName}" in "${t.name}"`);
        local!.db.setCell(row.id, col.id, { value: val, status: "done" });
      }
      created.push(row.id);
    }
    return ok({ added: created.length });
  },
);

server.tool(
  "run_column",
  "Run a function column over its rows (enriching cells). Returns how many ran and errored.",
  { table: z.string(), column: z.string(), force: z.boolean().optional(), concurrency: z.number().optional() },
  async ({ table, column, force, concurrency }) => {
    if (cloudSource) return ok(await cloudSource.runColumn(table, column, { force, concurrency }));
    const t = localTableOr(table);
    const col = local!.db.resolveColumn(t.id, column);
    if (!col) throw new Error(`No column "${column}" in "${t.name}"`);
    const res = await local!.engine.runColumn(col.id, { force, concurrency: concurrency ?? 5 });
    return ok({ column: col.name, ...res });
  },
);

server.tool(
  "get_table",
  "Get a table's full contents: columns and every row's cell values + statuses.",
  { table: z.string() },
  async ({ table }) => {
    if (cloudSource) return ok(await cloudSource.getTable(table));
    const t = localTableOr(table);
    const cols = local!.db.listColumns(t.id);
    const rows = local!.db.listRows(t.id).map((r) => {
      const cells = local!.db.rowCells(r.id);
      const obj: Record<string, unknown> = {};
      for (const c of cols) {
        const cell = cells.get(c.id);
        obj[c.name] = cell ? (cell.status === "error" ? { error: cell.error } : cell.value) : null;
      }
      return obj;
    });
    return ok({ table: t.name, columns: cols.map((c) => ({ name: c.name, kind: c.kind, fn: c.provider ? `${c.provider}.${c.method}` : c.code ? "code" : null })), rows });
  },
);

server.tool(
  "upload_extension",
  "Upload a JSON-manifest extension (a connector defined as data: baseUrl, auth, and HTTP methods). Its methods become callable via sdk.<id>.<method> and appear in list_functions. Pass the manifest JSON as a string.",
  { manifestJson: z.string().describe("The extension manifest as a JSON string.") },
  async ({ manifestJson }) => {
    if (cloudSource) return cloudUnsupported("upload_extension");
    const manifest = parseManifest(manifestJson);
    local!.db.saveExtension({ ...manifest });
    registry.add(connectorFromManifest(manifest));
    return ok({ id: manifest.id, name: manifest.name, methods: manifest.methods.map((m) => `${manifest.id}.${m.id}`) });
  },
);

server.tool(
  "run_function",
  "Call a connector function DIRECTLY and get its raw result — use this to SOURCE data (find people, run a search, enrich one input) then feed results into add_rows. Examples: trigify.discoverCreators {posted_about_keywords:['Trigify'], posted_about_days:30, page_size:25}; trigify.enrichProfile {profileUrl:'...'}; leadmagic.emailFinder {first_name, last_name, domain}. See list_functions for provider.method and inputs.",
  {
    provider: z.string().describe("Connector id, e.g. 'trigify', 'leadmagic', 'github'"),
    method: z.string().describe("Method id, e.g. 'discoverCreators', 'enrichProfile'"),
    input: z.record(z.string(), z.any()).optional().describe("Method inputs object"),
  },
  async ({ provider, method, input }) => {
    if (cloudSource) return cloudUnsupported("run_function");
    if (!registry.method(provider, method)) throw new Error(`Unknown function ${provider}.${method}. Use list_functions.`);
    const result = await local!.engine.dispatch(provider, method, input ?? {});
    return ok(result);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
// Token-free banner: report the mode + project only — never the bearer token.
console.error(`gtmgrid MCP server connected (${describeGridEnv(gridEnv)})`);
