#!/usr/bin/env node
// gtmgrid MCP server — exposes the local grid (tables, columns, connectors, runs)
// as MCP tools over stdio, so Claude Code / Codex can build and run GTM pipelines.
//
// The project to operate on comes from GTMGRID_PROJECT (a name or .db path).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openProject, parseManifest, connectorFromManifest } from "@gtmgrid/engine";

const projectRef = process.env.GTMGRID_PROJECT ?? "default";
const { db, engine } = openProject(projectRef);

const server = new McpServer({ name: "gtmgrid", version: "0.0.1" });

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const tableOr = (ref: string) => {
  const t = db.resolveTable(ref);
  if (!t) throw new Error(`No table "${ref}". Use list_tables.`);
  return t;
};

// --- Discovery: what enrichments/functions exist ---
server.tool(
  "list_functions",
  "List all available connector functions (the catalog of enrichments/AI/HTTP methods) that a column can call via sdk.<provider>.<method>. Returns each method's description and input schema.",
  {},
  async () =>
    ok(
      engine.registry.list().map((c) => ({
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

server.tool("list_tables", "List all tables in the project with their column and row counts.", {}, async () =>
  ok(
    db.listTables().map((t) => ({
      id: t.id,
      name: t.name,
      columns: db.listColumns(t.id).length,
      rows: db.listRows(t.id).length,
    })),
  ),
);

server.tool("create_table", "Create a new table.", { name: z.string() }, async ({ name }) => {
  const t = db.createTable(name);
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
    const t = tableOr(table);
    let provider: string | null = null;
    let method: string | null = null;
    if (fn) {
      const [p, m] = fn.split(".");
      if (!p || !m) throw new Error("fn must be 'provider.method'");
      if (!engine.registry.method(p, m)) throw new Error(`Unknown function ${fn}. Use list_functions.`);
      provider = p;
      method = m;
    }
    const kind = provider || code ? "function" : "manual";
    const col = db.createColumn({ tableId: t.id, name, type: type ?? "text", kind, provider, method, code: code ?? null, params: params ?? {} });
    return ok({ id: col.id, name: col.name, kind, fn: fn ?? null });
  },
);

server.tool(
  "add_rows",
  "Add one or more rows. Each row is an object of { ColumnName: value } for manual columns, e.g. [{ Username: 'torvalds' }].",
  { table: z.string(), rows: z.array(z.record(z.string(), z.any())) },
  async ({ table, rows }) => {
    const t = tableOr(table);
    const created: string[] = [];
    for (const r of rows) {
      const row = db.createRow(t.id);
      for (const [colName, val] of Object.entries(r)) {
        const col = db.resolveColumn(t.id, colName);
        if (!col) throw new Error(`No column "${colName}" in "${t.name}"`);
        db.setCell(row.id, col.id, { value: val, status: "done" });
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
    const t = tableOr(table);
    const col = db.resolveColumn(t.id, column);
    if (!col) throw new Error(`No column "${column}" in "${t.name}"`);
    const res = await engine.runColumn(col.id, { force, concurrency: concurrency ?? 5 });
    return ok({ column: col.name, ...res });
  },
);

server.tool(
  "get_table",
  "Get a table's full contents: columns and every row's cell values + statuses.",
  { table: z.string() },
  async ({ table }) => {
    const t = tableOr(table);
    const cols = db.listColumns(t.id);
    const rows = db.listRows(t.id).map((r) => {
      const cells = db.rowCells(r.id);
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
    const manifest = parseManifest(manifestJson);
    db.saveExtension(manifest as any);
    engine.registry.add(connectorFromManifest(manifest));
    return ok({ id: manifest.id, name: manifest.name, methods: manifest.methods.map((m) => `${manifest.id}.${m.id}`) });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`gtmgrid MCP server connected (project: ${projectRef})`);
