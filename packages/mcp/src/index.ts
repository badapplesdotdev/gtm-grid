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

/**
 * Cap a cell value for `get_table` so one fat column (e.g. a raw enrichment JSON
 * blob) can't blow the whole response budget and truncate the table after row 1.
 * Small/compiled values pass through untouched; large strings/objects are sliced
 * with a '…[+N chars]' marker so the agent knows it was cut (and can extract the
 * fields it needs via a code/formula column). The full value stays in the cell.
 */
const CELL_CAP = 500;
function capCellValue(v: unknown): unknown {
  if (v == null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") {
    return v.length > CELL_CAP ? `${v.slice(0, CELL_CAP)}…[+${v.length - CELL_CAP} chars]` : v;
  }
  const s = JSON.stringify(v);
  if (s.length <= CELL_CAP) return v; // small object/array — keep structured
  return `${s.slice(0, CELL_CAP)}…[+${s.length - CELL_CAP} chars, full value in the cell]`;
}

/**
 * Standard "this is destructive or large — get the user's OK first" response.
 * The tool does NOT execute; it returns confirmationRequired so the agent (per
 * its system prompt) surfaces the impact and waits for the user. Only after the
 * user approves does the agent re-call with confirm:true.
 */
const needsConfirm = (action: string, willAffect: number, target: string, extra?: Record<string, unknown>) =>
  ok({
    confirmationRequired: true,
    action,
    willAffect,
    target,
    message: `${action} would affect ${willAffect} item(s) in "${target}". Confirm with the user, then re-call with confirm:true.`,
    ...extra,
  });

/** Above this many affected rows/cells, a destructive or compute-heavy op asks first. */
const CONFIRM_THRESHOLD = 50;

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
  "Add a column. Computed columns come in three flavours: (1) a FORMULA — set `formula` to a JS expression evaluated per row (reference other columns with {{Column Name}}; standard JS plus Lodash `_`, Moment `moment`, and Excel/Sheets functions VLOOKUP/IF/SUM/CONCATENATE/… available by their bare UPPERCASE names); (2) a connector FUNCTION — set `fn` to 'provider.method' (see list_functions); or (3) custom `code` (a JS body: function(inputs, sdk){...}). `params` maps inputs to values; use {{Column Name}} templates, e.g. { username: '{{Username}}' }. Set `condition` (an 'only run if' JS boolean expression, e.g. 'Number({{Headcount}}) > 40') to skip rows that don't match — the column won't run or spend credits on them.",
  {
    table: z.string(),
    name: z.string(),
    formula: z
      .string()
      .optional()
      .describe('A formula expression, e.g. \'{{Email}}.split("@")[1]\' or \'UPPER({{Name}})\'. Creates a formula column.'),
    fn: z.string().optional().describe("'provider.method', e.g. 'github.getUser' or 'ai.generate'"),
    code: z.string().optional().describe("Custom QuickJS body: function(inputs, sdk){ ... }"),
    type: z.enum(["text", "number", "boolean", "date", "json"]).optional(),
    params: z.record(z.string(), z.any()).optional(),
    condition: z
      .string()
      .optional()
      .describe("'Only run if' JS boolean expression with {{Column}} refs, e.g. 'Boolean({{Email}})'. Falsy rows are skipped (no credits)."),
  },
  async ({ table, name, formula, fn, code, type, params, condition }) => {
    if (cloudSource) {
      return ok(
        await cloudSource.addColumn(table, {
          name,
          ...(formula !== undefined ? { formula } : {}),
          ...(fn !== undefined ? { fn } : {}),
          ...(code !== undefined ? { code } : {}),
          ...(type !== undefined ? { type } : {}),
          ...(params !== undefined ? { params } : {}),
          ...(condition !== undefined ? { condition } : {}),
        }),
      );
    }
    const t = localTableOr(table);
    let provider: string | null = null;
    let method: string | null = null;
    let colParams: Record<string, unknown> = params ?? {};
    if (formula) {
      // A formula column is a function column backed by the built-in `formula` connector.
      provider = "formula";
      method = "eval";
      colParams = { ...colParams, expression: formula };
    } else if (fn) {
      const [p, m] = fn.split(".");
      if (!p || !m) throw new Error("fn must be 'provider.method'");
      if (!registry.method(p, m)) throw new Error(`Unknown function ${fn}. Use list_functions.`);
      provider = p;
      method = m;
    }
    const kind = provider || code ? "function" : "manual";
    const col = local!.db.createColumn({
      tableId: t.id,
      name,
      type: type ?? "text",
      kind,
      provider,
      method,
      code: code ?? null,
      params: colParams,
      condition: condition?.trim() ? condition.trim() : null,
    });
    return ok({ id: col.id, name: col.name, kind, fn: formula ? "formula.eval" : (fn ?? null), condition: col.condition });
  },
);

server.tool(
  "add_rows",
  "Add one or more rows. Each row is an object of { ColumnName: value } for manual columns, e.g. [{ Username: 'torvalds' }]. If the table has dedup ON (see set_dedupe), incoming rows whose key already exists are skipped automatically — so you can stream paginated search results straight in without deduping yourself. Returns { added, skipped, replaced }.",
  { table: z.string(), rows: z.array(z.record(z.string(), z.any())) },
  async ({ table, rows }) => {
    if (cloudSource) return ok(await cloudSource.addRows(table, rows));
    const t = localTableOr(table);
    // Resolve { ColumnName: value } -> { columnId: value }, validating names up front.
    const resolved = rows.map((r) => {
      const cells: Record<string, unknown> = {};
      for (const [colName, val] of Object.entries(r)) {
        const col = local!.db.resolveColumn(t.id, colName);
        if (!col) throw new Error(`No column "${colName}" in "${t.name}"`);
        cells[col.id] = val;
      }
      return cells;
    });
    const res = local!.db.addRowsDeduped(t.id, resolved);
    return ok({ added: res.added, skipped: res.skipped, replaced: res.replaced });
  },
);

server.tool(
  "set_dedupe",
  "Turn deduplication on/off for a table. With it ON, the table stays unique on one column — add_rows skips incoming duplicates automatically (ideal for sourcing N unique rows across paginated searches). Pass column:null to turn it off. keep:'oldest' keeps the first row seen; keep:'newest' replaces it with the new one. Enabling also sweeps existing duplicates once. Match is EXACT (no URL/email normalization), and a blank or over-200-char key cell is never merged.",
  { table: z.string(), column: z.string().nullable().describe("Column NAME to dedupe on, or null to disable"), keep: z.enum(["oldest", "newest"]).optional() },
  async ({ table, column, keep }) => {
    if (cloudSource) return cloudUnsupported("set_dedupe");
    const t = localTableOr(table);
    if (column === null || column === "") {
      local!.db.setTableDedupe(t.id, null);
      return ok({ dedupe: null });
    }
    const col = local!.db.resolveColumn(t.id, column);
    if (!col) throw new Error(`No column "${column}" in "${t.name}"`);
    local!.db.setTableDedupe(t.id, { column: col.id, keep: keep ?? "oldest" });
    const swept = local!.db.dedupeTable(t.id);
    return ok({ dedupe: { column: col.name, keep: keep ?? "oldest" }, removedExistingDuplicates: swept.deleted });
  },
);

server.tool(
  "run_column",
  "Run a function column over its rows (enriching cells), in grid order (top-down — the same order the user sees). Pass `limit` to enrich only the next N rows that still need filling — use this for requests like 'run this for 10 rows' or 'do the next 20': it fills the first N unfilled cells in display order, NEVER a random subset. Add `offset` to skip the first matches (e.g. limit:10, offset:10 = rows 11–20). Omit `limit` to run every pending row. A large run (more than ~50 pending rows) asks first: it returns the pending-row count + estimated credits — surface that and only re-call with confirm:true once the user approves. Returns how many ran and errored.",
  { table: z.string(), column: z.string(), force: z.boolean().optional(), concurrency: z.number().optional(), limit: z.number().optional(), offset: z.number().optional(), confirm: z.boolean().optional() },
  async ({ table, column, force, concurrency, limit, offset, confirm }) => {
    if (cloudSource) return ok(await cloudSource.runColumn(table, column, { force, concurrency, limit, offset }));
    const t = localTableOr(table);
    const col = local!.db.resolveColumn(t.id, column);
    if (!col) throw new Error(`No column "${column}" in "${t.name}"`);
    // Candidate rows in grid order (listRows is already sorted by position,
    // created_at). Without `force`, skip cells already `done`; with it, every row
    // is a candidate. `limit`/`offset` then scope to the next N — so "run 10 rows"
    // fills the first 10 unfilled cells in display order, not a random subset.
    const ordered = local!.db.listRows(t.id);
    const candidates = force
      ? ordered
      : ordered.filter((r) => (local!.db.getCell(r.id, col.id)?.status ?? "empty") !== "done");
    const scoped = limit != null ? candidates.slice(offset ?? 0, (offset ?? 0) + limit) : candidates;
    // Cost/scale gate — a massive run needs the user's OK first. Counts the SCOPED
    // set, so a deliberately small `limit` run never trips the confirm threshold.
    const pending = scoped.length;
    const method = col.provider && col.method ? local!.engine.registry.method(col.provider, col.method) : undefined;
    if (pending > CONFIRM_THRESHOLD && !confirm) {
      return needsConfirm("Run column", pending, `${t.name} › ${col.name}`, {
        estimatedCredits: (method?.credits ?? 0) * pending,
        // Surface the "only run if" rule so a ran:0 (every row skipped by the
        // condition) is explainable up front, not a mystery after the fact.
        condition: col.condition ?? undefined,
        hint: col.condition
          ? "rows that fail the column's run-condition are skipped (may run fewer than shown)"
          : "enriches every pending row",
      });
    }
    const res = await local!.engine.runColumn(col.id, {
      force,
      concurrency: concurrency ?? 5,
      // Only pass an explicit row scope when the caller asked for one; otherwise
      // leave it undefined so the engine runs every row exactly as before.
      rowIds: limit != null ? scoped.map((r) => r.id) : undefined,
    });
    return ok({ column: col.name, ...res });
  },
);

server.tool(
  "get_table",
  "Get a table's columns + rows (each row carries its _id for update_cells/delete_rows). Bounded: returns up to `limit` rows (default 200) from `offset`, plus totalRows — for a big table, paginate or use find_rows/get_column instead of pulling it all. Large cell values are truncated with a '…[+N chars]' marker (full value stays in the cell; extract fields via a code/formula column); small/compiled columns come through whole.",
  { table: z.string(), limit: z.number().optional(), offset: z.number().optional() },
  async ({ table, limit, offset }) => {
    if (cloudSource) return ok(await cloudSource.getTable(table));
    const t = localTableOr(table);
    const cols = local!.db.listColumns(t.id);
    const total = local!.db.countRows(t.id);
    const start = Math.max(offset ?? 0, 0);
    const cap = Math.min(Math.max(limit ?? 200, 1), 1000);
    const rows = local!.db.listRows(t.id).slice(start, start + cap).map((r) => {
      const cells = local!.db.rowCells(r.id);
      const obj: Record<string, unknown> = { _id: r.id };
      for (const c of cols) {
        const cell = cells.get(c.id);
        obj[c.name] = cell ? (cell.status === "error" ? { error: capCellValue(cell.error) } : capCellValue(cell.value)) : null;
      }
      return obj;
    });
    return ok({
      table: t.name,
      columns: cols.map((c) => ({
        name: c.name,
        kind: c.kind,
        fn: c.provider ? `${c.provider}.${c.method}` : c.code ? "code" : null,
        // Expose the column's logic so the agent can DIAGNOSE/FIX it in place: a
        // wrong "only run if" condition skips every row → run_column reports ran:0,
        // and without seeing the condition the agent can't tell why.
        condition: c.condition ?? null,
        params: c.params,
        code: typeof c.code === "string" && c.code.length > 600 ? `${c.code.slice(0, 600)}…[+${c.code.length - 600} chars]` : c.code ?? null,
      })),
      rows,
      totalRows: total,
      returned: rows.length,
      offset: start,
      truncated: start + rows.length < total,
    });
  },
);

server.tool(
  "find_rows",
  "Search inside a table: return only the rows whose cells match `where` (exact match, AND across the given columns) — no whole-table pull needed. Each returned row carries its _id (use with update_cells / delete_rows). Pass `columns` to slim the payload, and `limit` to bound it.",
  {
    table: z.string(),
    where: z.record(z.string(), z.any()).describe("{ ColumnName: value } — a row must match ALL of these"),
    columns: z.array(z.string()).optional().describe("Only return these columns (plus _id). Omit for all."),
    limit: z.number().optional(),
  },
  async ({ table, where, columns, limit }) => {
    if (cloudSource) return cloudUnsupported("find_rows");
    const t = localTableOr(table);
    const match: Record<string, unknown> = {};
    for (const [name, val] of Object.entries(where ?? {})) {
      const col = local!.db.resolveColumn(t.id, name);
      if (!col) throw new Error(`No column "${name}" in "${t.name}"`);
      match[col.id] = val;
    }
    const wantCols = (columns ?? local!.db.listColumns(t.id).map((c) => c.name))
      .map((n) => local!.db.resolveColumn(t.id, n))
      .filter((c): c is NonNullable<typeof c> => !!c);
    const rows = local!.db.findRows(t.id, match, Math.min(limit ?? 100, 1000)).map((r) => {
      const obj: Record<string, unknown> = { _id: r.id };
      for (const c of wantCols) {
        const cell = local!.db.getCell(r.id, c.id);
        obj[c.name] = cell ? capCellValue(cell.value) : null;
      }
      return obj;
    });
    return ok({ matched: rows.length, rows });
  },
);

server.tool(
  "get_column",
  "Read one column's values (each with its row _id) — a lean alternative to get_table for assessing a big table on a single field. Bounded by `limit`.",
  { table: z.string(), column: z.string(), limit: z.number().optional() },
  async ({ table, column, limit }) => {
    if (cloudSource) return cloudUnsupported("get_column");
    const t = localTableOr(table);
    const col = local!.db.resolveColumn(t.id, column);
    if (!col) throw new Error(`No column "${column}" in "${t.name}"`);
    const cap = Math.min(limit ?? 1000, 5000);
    const values = local!.db.listRows(t.id).slice(0, cap).map((r) => ({
      _id: r.id,
      value: capCellValue(local!.db.getCell(r.id, col.id)?.value ?? null),
    }));
    return ok({ column: col.name, total: local!.db.countRows(t.id), returned: values.length, values });
  },
);

server.tool(
  "describe_column",
  "Show exactly HOW a column computes its values — its function (provider.method), params (the {{Column}} input mapping), 'only run if' condition, full custom code (uncapped), output type and kind. Use this to understand how an EXISTING column was worked out — e.g. one that already has data filled in — before you edit it, re-run it, or answer 'how is this calculated?'. For a quick overview of every column at once, get_table now also returns a (capped) condition/code/params per column.",
  { table: z.string(), column: z.string() },
  async ({ table, column }) => {
    if (cloudSource) return cloudUnsupported("describe_column");
    const t = localTableOr(table);
    const col = local!.db.resolveColumn(t.id, column);
    if (!col) throw new Error(`No column "${column}" in "${t.name}"`);
    return ok({
      name: col.name,
      kind: col.kind,
      type: col.type,
      fn: col.provider ? `${col.provider}.${col.method}` : col.code ? "code" : null,
      provider: col.provider,
      method: col.method,
      params: col.params,
      condition: col.condition ?? null,
      code: col.code ?? null, // FULL body, not capped — this is the recipe
    });
  },
);

server.tool(
  "update_cells",
  "Set or clear specific cells. Each update is { row: <_id from get_table/find_rows>, column: <name>, value: <any> }; value null/'' clears the cell. For more than 50 cells it asks first (confirm:true after the user approves).",
  {
    table: z.string(),
    updates: z.array(z.object({ row: z.string(), column: z.string(), value: z.any() })),
    confirm: z.boolean().optional(),
  },
  async ({ table, updates, confirm }) => {
    if (cloudSource) return cloudUnsupported("update_cells");
    const t = localTableOr(table);
    if (updates.length > CONFIRM_THRESHOLD && !confirm) return needsConfirm("Update cells", updates.length, t.name);
    // Scope row ids to THIS table — never write a cell against a row id that
    // belongs to another table (a stray/hallucinated id).
    const tableRows = new Set(local!.db.listRows(t.id).map((r) => r.id));
    let updated = 0;
    for (const u of updates) {
      if (!tableRows.has(u.row)) throw new Error(`Row "${u.row}" is not in "${t.name}"`);
      const col = local!.db.resolveColumn(t.id, u.column);
      if (!col) throw new Error(`No column "${u.column}" in "${t.name}"`);
      if (u.value === null || u.value === undefined || u.value === "") local!.db.deleteCell(u.row, col.id);
      else local!.db.setCell(u.row, col.id, { value: u.value, status: "done" });
      updated++;
    }
    return ok({ updated });
  },
);

server.tool(
  "delete_rows",
  "Delete rows by _id (from get_table/find_rows) and/or by a `where` match. DESTRUCTIVE: without confirm:true it returns a preview of how many rows would be deleted — surface that to the user and only re-call with confirm:true once they approve.",
  {
    table: z.string(),
    ids: z.array(z.string()).optional(),
    where: z.record(z.string(), z.any()).optional().describe("{ ColumnName: value } — delete rows matching ALL"),
    confirm: z.boolean().optional(),
  },
  async ({ table, ids, where, confirm }) => {
    if (cloudSource) return cloudUnsupported("delete_rows");
    const t = localTableOr(table);
    const targets = new Set<string>();
    if (ids?.length) {
      // Only delete ids that actually belong to THIS table — a stray id must not
      // delete a row in another table (deleteRow is keyed by id alone).
      const tableRows = new Set(local!.db.listRows(t.id).map((r) => r.id));
      for (const id of ids) {
        if (!tableRows.has(id)) throw new Error(`Row "${id}" is not in "${t.name}"`);
        targets.add(id);
      }
    }
    if (where && Object.keys(where).length) {
      const match: Record<string, unknown> = {};
      for (const [name, val] of Object.entries(where)) {
        const col = local!.db.resolveColumn(t.id, name);
        if (!col) throw new Error(`No column "${name}" in "${t.name}"`);
        match[col.id] = val;
      }
      for (const r of local!.db.findRows(t.id, match, 1_000_000)) targets.add(r.id);
    }
    if (targets.size === 0) return ok({ deleted: 0, note: "no matching rows" });
    if (!confirm) return needsConfirm("Delete rows", targets.size, t.name);
    for (const id of targets) local!.db.deleteRow(id);
    return ok({ deleted: targets.size });
  },
);

server.tool(
  "delete_column",
  "Delete a column and its values from every row. DESTRUCTIVE: needs confirm:true after the user approves.",
  { table: z.string(), column: z.string(), confirm: z.boolean().optional() },
  async ({ table, column, confirm }) => {
    if (cloudSource) return cloudUnsupported("delete_column");
    const t = localTableOr(table);
    const col = local!.db.resolveColumn(t.id, column);
    if (!col) throw new Error(`No column "${column}" in "${t.name}"`);
    if (!confirm) return needsConfirm("Delete column", local!.db.countRows(t.id), `${t.name} › ${col.name}`, { hint: "removes the column and its cells from every row" });
    local!.db.deleteColumn(col.id);
    return ok({ deleted: col.name });
  },
);

server.tool(
  "delete_table",
  "Delete an entire table — all of its columns and rows. DESTRUCTIVE: needs confirm:true after the user approves.",
  { table: z.string(), confirm: z.boolean().optional() },
  async ({ table, confirm }) => {
    if (cloudSource) return cloudUnsupported("delete_table");
    const t = localTableOr(table);
    if (!confirm) return needsConfirm("Delete table", local!.db.countRows(t.id), t.name, { hint: "permanently removes the whole table" });
    local!.db.deleteTable(t.id);
    return ok({ deleted: t.name });
  },
);

server.tool(
  "update_column",
  "Change a column's config: name, type, condition, or its function (provider/method/params/code). Non-destructive — it doesn't clear existing cells. Re-run with run_column afterwards if the change should recompute.",
  {
    table: z.string(),
    column: z.string(),
    patch: z.object({
      name: z.string().optional(),
      type: z.enum(["text", "number", "boolean", "date", "json"]).optional(),
      condition: z.string().nullable().optional(),
      provider: z.string().nullable().optional(),
      method: z.string().nullable().optional(),
      code: z.string().nullable().optional(),
      params: z.record(z.string(), z.any()).optional(),
    }),
  },
  async ({ table, column, patch }) => {
    if (cloudSource) return cloudUnsupported("update_column");
    const t = localTableOr(table);
    const col = local!.db.resolveColumn(t.id, column);
    if (!col) throw new Error(`No column "${column}" in "${t.name}"`);
    // patch.type arrives as a string; the db's ColumnType union accepts it at runtime.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updated = local!.db.updateColumn(col.id, patch as any);
    return ok({ column: updated?.name ?? col.name });
  },
);

server.tool(
  "rename_table",
  "Rename a table.",
  { table: z.string(), name: z.string() },
  async ({ table, name }) => {
    if (cloudSource) return cloudUnsupported("rename_table");
    const t = localTableOr(table);
    local!.db.renameTable(t.id, name.trim() || t.name);
    return ok({ renamed: name.trim() || t.name });
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
