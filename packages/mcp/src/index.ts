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
import {
  Db,
  connectorFromManifest,
  globalDbPath,
  openProject,
  parseManifest,
  type Registry,
} from "@gtmgrid/engine";
import type { RunErrorContext } from "@gtmgrid/engine";
import { captureException, installProcessHandlers } from "@gtmgrid/observability";
import { capCellValue } from "./cell.js";
import { describeGridEnv, selectGridEnv } from "./cloud-context.js";
import {
  decide,
  hashArgs,
  parseApprovedAction,
  parsePermissionMode,
  permissionConfigured,
  riskClass,
} from "./permission.js";
import {
  CloudToolUnsupportedError,
  defaultCloudSourceDeps,
  makeCloudSource,
  registryWithExtensions,
} from "./cloud-source.js";

// Last-gasp crash reporting for the long-lived MCP process (uncaught exceptions /
// unhandled rejections → PostHog Error Tracking, tagged "mcp"). No-ops without a key.
installProcessHandlers("mcp");

// Forward systemic run failures (connector/AI bugs) from the engine to Error
// Tracking, deduped per run. Wired onto both the local and cloud engine config.
const reportEngineError = (error: unknown, ctx: RunErrorContext): void =>
  captureException(error, { source: "engine-run", ...ctx });

const gridEnv = selectGridEnv(process.env);

/**
 * Build the CLOUD registry: the built-in connectors PLUS every JSON-manifest
 * extension from the SHARED global db — the SAME set `openProject` loads for a
 * LOCAL project (engine `openProject` reads `globalDb.listExtensions()`). Without
 * this the cloud agent only saw the built-ins (ai/formatting/formula/github/http)
 * and reported enrichment/social connectors like Trigify as "not available",
 * diverging from local. The MCP runs on the user's machine (spawned by the
 * sidecar), so `globalDbPath()` resolves to the same global.db the sidecar uses.
 * Read-only + best-effort: a missing db or a bad manifest degrades to the
 * built-ins rather than failing the whole MCP.
 */
function cloudRegistry(): Registry {
  try {
    const globalDb = new Db(globalDbPath());
    try {
      return registryWithExtensions(globalDb.listExtensions());
    } finally {
      globalDb.close();
    }
  } catch {
    // No global db (e.g. fresh install) → built-in connectors only.
    return registryWithExtensions([]);
  }
}

/**
 * `ai.generate` fallback when the user has no AI provider key connected: route the
 * prompt to the persistent sidecar's `/api/ai/generate`, which runs it through the
 * user's already-authenticated coding agent (Claude Code / Codex) — so AI columns
 * work off the model they're already using, no separate key. One agent call per
 * row, so it's slower than a batched API key (acceptable as a no-key fallback).
 */
const mcpAiFallback = async (req: { prompt: string; system?: string; model?: string }): Promise<string> => {
  const port = process.env.GTMGRID_PORT ?? "8787";
  const res = await fetch(`http://127.0.0.1:${port}/api/ai/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: req.prompt, system: req.system }),
  });
  if (!res.ok) {
    throw new Error(
      "No AI provider connected, and the agent fallback is unavailable. Tell the user to connect an AI key (Anthropic/OpenAI/OpenRouter) in the Extensions panel.",
    );
  }
  const data = (await res.json()) as { text?: string; error?: string };
  if (data.error) throw new Error(data.error);
  if (typeof data.text !== "string") throw new Error("AI agent fallback returned no text.");
  return data.text;
};

// LOCAL mode opens the SQLite project (and exposes its registry of connectors).
// CLOUD mode opens NO SQLite file (the engine is Db-free, backed by the cloud
// store); it still needs a registry for connector discovery + cloud runs, so we
// build one with the SAME extensions loaded so cloud == local (skip `openProject`).
const local = gridEnv.mode === "local" ? openProject(gridEnv.project) : undefined;
// AI columns fall back to the user's coding-agent model when no key is set (both modes).
if (local) {
  local.engine.config.aiFallback = mcpAiFallback;
  local.engine.config.reportError = reportEngineError;
}
const cloudDeps =
  gridEnv.mode === "cloud"
    ? defaultCloudSourceDeps(cloudRegistry(), { aiFallback: mcpAiFallback, reportError: reportEngineError })
    : undefined;
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

// ── Permission mode + HITL approval (Phase 2) ──────────────────────────────
// The composer's permission mode + any human approval are threaded in via env by
// the sidecar (mcpEnv). The gate below is the ONE enforcement point all three
// providers share, so the 4 modes behave identically regardless of provider. A
// confirm can ONLY be unlocked by a human approval delivered through the env
// (GTMGRID_APPROVED_*), a channel the model can't reach — so a model setting
// `confirm:true` itself never bypasses a gate.
const permMode = parsePermissionMode(process.env);
const permActive = permissionConfigured(process.env);
const approvedAction = parseApprovedAction(process.env);
/** Approvals are single-use within this MCP process (a resumed turn) so an OK to
 *  delete/spend once can't be replayed for a second identical call. */
const consumedApprovals = new Set<string>();

/** A plan-mode no-op result for a mutating tool that must not execute. */
const planBlocked = (tool: string, action: string, target: string) =>
  ok({
    planMode: true,
    blocked: true,
    tool,
    action,
    target,
    note: `Plan mode is active — "${action}" was NOT executed. Add it to your plan and let the user click Approve to run it.`,
  });

/** Plan-mode guard for the pure-edit tools (which have no confirm gate of their
 *  own): blocks them in plan mode, no-op otherwise. Returns a result or null. */
function planGuard(tool: string, action: string, target: string) {
  return permActive && permMode === "plan" && riskClass(tool) !== "read"
    ? planBlocked(tool, action, target)
    : null;
}

type GateResult = { ok: true } | { ok: false; result: ReturnType<typeof ok> };

/**
 * Mode-aware permission gate for a destructive / credit-spending / large-edit op.
 * Returns `{ok:true}` to proceed, or `{ok:false, result}` — a confirmationRequired
 * payload (HITL) or a plan-mode block — to return instead of executing. Only a
 * human approval (env-passed) unlocks a confirm; the model's own `confirm:true`
 * does NOT (except in the legacy no-permission-env path, for back-compat).
 */
function gate(
  tool: string,
  args: Record<string, unknown>,
  info: {
    affected: number;
    perRowCredits?: number;
    estimatedCredits?: number;
    action: string;
    target: string;
    extra?: Record<string, unknown>;
  },
): GateResult {
  const display: Record<string, unknown> = {
    ...(info.estimatedCredits ? { estimatedCredits: info.estimatedCredits } : {}),
    ...info.extra,
  };
  // Back-compat: an old launcher set no permission mode → keep the legacy soft
  // confirm:true behavior (the caller already decided this op warrants a gate).
  if (!permActive) {
    return args.confirm === true
      ? { ok: true }
      : { ok: false, result: needsConfirm(info.action, info.affected, info.target, Object.keys(display).length ? display : undefined) };
  }
  const decision = decide(permMode, riskClass(tool), {
    affected: info.affected,
    credits: info.perRowCredits ?? 0,
    threshold: CONFIRM_THRESHOLD,
  });
  if (decision === "execute") return { ok: true };
  if (decision === "block") return { ok: false, result: planBlocked(tool, info.action, info.target) };
  // confirm: only a matching, unconsumed HUMAN approval (from the env) unlocks it.
  const argsHash = hashArgs(args);
  if (
    approvedAction &&
    approvedAction.tool === tool &&
    approvedAction.argsHash === argsHash &&
    !consumedApprovals.has(argsHash)
  ) {
    consumedApprovals.add(argsHash);
    return { ok: true };
  }
  return {
    ok: false,
    result: ok({
      confirmationRequired: true,
      action: info.action,
      willAffect: info.affected,
      target: info.target,
      ...display,
      message: `${info.action} would affect ${info.affected} item(s) in "${info.target}". STOP and ask the user — they Approve in the chat. Do NOT set confirm:true yourself; it will not run the tool.`,
      approvalRequest: {
        pendingId: `pr_${argsHash.slice(0, 12)}`,
        tool,
        argsHash,
        mode: permMode,
        action: info.action,
        willAffect: info.affected,
        target: info.target,
        ...(info.estimatedCredits ? { estimatedCredits: info.estimatedCredits } : {}),
      },
    }),
  };
}

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

/**
 * Turn a connector / AI error message into an ACTIONABLE note the agent surfaces
 * to the user — so a missing AI key, a 401, or a quota cap explains itself (and
 * which panel fixes it) instead of the agent having to dig the message out of a
 * follow-up get_table.
 */
function errorHint(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("no ai provider connected"))
    return "No AI provider is connected. Tell the user to connect an AI key (Anthropic, OpenAI, or OpenRouter) in the Extensions panel so AI columns can run — or, with no key, AI columns fall back to the user's own connected Claude/Codex agent model (slower, one call per row).";
  if (m.includes("401") || m.includes("403") || m.includes("unauthor") || m.includes("authentication required") || m.includes("invalid api key") || m.includes("missing api key"))
    return "This connector's API key is missing or invalid. Tell the user to connect it in the Extensions panel; do NOT retry blindly.";
  if (m.includes("[quota]") || m.includes("402") || m.includes("exceed your plan"))
    return "The workspace hit its plan's cloud-action limit. Tell the user to upgrade or run fewer rows; nothing was charged for the failed cells.";
  return message;
}

/** Attach an actionable error hint to a run result when some cells errored. */
function withRunHint<T extends { errors: number; firstError?: string }>(
  res: T,
): T & { errorHint?: string } {
  return res.errors > 0 && res.firstError
    ? { ...res, errorHint: errorHint(res.firstError) }
    : res;
}

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

// --- Human-in-the-loop: ask the user a structured multiple-choice question ---
// Returns IMMEDIATELY with the questions payload (non-blocking). The desktop
// renders selectable answer cards and the user's reply arrives as the next
// message. Works for every provider because all three CLIs mount this MCP
// server — no provider-specific code, mirroring the permission-gate pattern.
server.tool(
  "ask_user_question",
  "Ask the user a structured multiple-choice question and STOP. Use this whenever you need the user to choose between options — which AI model/system prompt to use, how big a cohort to source, or to disambiguate an ambiguous request — instead of asking in prose. Provide 1–4 questions, each with a short `header`, the `question` text, and 2–4 `options` ({label, description}). After calling this, end your turn: do NOT answer for the user. Their selection (or a typed 'Other' answer) arrives as the next message.",
  {
    questions: z
      .array(
        z.object({
          header: z.string().describe("Short chip label (≤ ~12 chars), e.g. 'AI model'"),
          question: z.string().describe("The full question text shown to the user"),
          multiSelect: z.boolean().optional().describe("Allow the user to pick multiple options"),
          options: z
            .array(
              z.object({
                label: z.string().describe("Concise option label the user selects"),
                description: z.string().optional().describe("What this option means / its trade-off"),
              }),
            )
            .min(2)
            .max(4),
        }),
      )
      .min(1)
      .max(4),
  },
  async ({ questions }) =>
    ok({
      askUserQuestion: true,
      questions,
      message:
        "STOP. Present these options to the user in the chat and WAIT for their reply — do NOT answer for them. End your turn now; their selection arrives as the next message.",
    }),
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
  const blocked = planGuard("create_table", "Create table", name);
  if (blocked) return blocked;
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
    const blocked = planGuard("add_column", "Add column", `${table} › ${name}`);
    if (blocked) return blocked;
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
  "Add one or more rows DIRECTLY into the table — this is how you POPULATE a table with sourced/enriched data; never stage rows to a file. Each row is an object of { ColumnName: value } for manual columns, e.g. [{ Username: 'torvalds' }]. When loading many rows, send them in batches of ~25-50 per call (keeps each call within size/quota limits and lets you show progress). If the table has dedup ON (see set_dedupe), incoming rows whose key already exists are skipped automatically — so you can stream paginated search results straight in without deduping yourself. Returns { added, skipped, replaced }.",
  { table: z.string(), rows: z.array(z.record(z.string(), z.any())) },
  async ({ table, rows }) => {
    const blocked = planGuard("add_rows", "Add rows", table);
    if (blocked) return blocked;
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
    const blocked = planGuard("set_dedupe", "Set dedupe", table);
    if (blocked) return blocked;
    if (cloudSource) return ok(await cloudSource.setDedupe(table, column, keep ?? "oldest"));
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
  "Run a function column over its rows (enriching cells), in grid order (top-down — the same order the user sees). Pass `limit` to enrich only the next N rows that still need filling — use this for requests like 'run this for 10 rows' or 'do the next 20': it fills the first N unfilled cells in display order, NEVER a random subset. Add `offset` to skip the first matches (e.g. limit:10, offset:10 = rows 11–20). Omit `limit` to run every pending row. A large run (more than ~50 pending rows) asks first: it returns the pending-row count + estimated credits — surface that and only re-call with confirm:true once the user approves. A confirmed large run is then started in the BACKGROUND on the sidecar (it outlasts this turn — a synchronous run of hundreds of rows would hit the 5-min turn limit and be killed), and returns immediately with {started:true}; poll get_column/get_table to watch the done count rise and tell the user when it's complete. A small run (≤50 rows) runs synchronously and returns {ran, errors}.",
  { table: z.string(), column: z.string(), force: z.boolean().optional(), concurrency: z.number().optional(), limit: z.number().optional(), offset: z.number().optional(), confirm: z.boolean().optional() },
  async ({ table, column, force, concurrency, limit, offset, confirm }) => {
    const args = { table, column, force, concurrency, limit, offset, confirm };
    if (cloudSource) {
      // Cloud lacks a cheap pending-count, so gate conservatively: a small
      // limit-scoped run auto-approves (matches local), an unbounded run asks. The
      // precise count + credit estimate aren't available without running.
      const g = gate("run_column", args, {
        affected: limit ?? CONFIRM_THRESHOLD + 1,
        perRowCredits: 1,
        action: "Run column",
        target: `${table} › ${column}`,
      });
      if (!g.ok) return g.result;
      return ok(withRunHint(await cloudSource.runColumn(table, column, { force, concurrency, limit, offset })));
    }
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
    const pending = scoped.length;
    const method = col.provider && col.method ? local!.engine.registry.method(col.provider, col.method) : undefined;
    // Permission/cost gate — mode-aware: a paid or large run asks (and only a human
    // approval, not the model's own confirm, unlocks it). Counts the SCOPED set, so
    // a deliberately small `limit` run never trips the threshold.
    const g = gate("run_column", args, {
      affected: pending,
      perRowCredits: method?.credits ?? 0,
      estimatedCredits: (method?.credits ?? 0) * pending,
      action: "Run column",
      target: `${t.name} › ${col.name}`,
      extra: {
        // Surface the "only run if" rule so a ran:0 (every row skipped by the
        // condition) is explainable up front, not a mystery after the fact.
        condition: col.condition ?? undefined,
        hint: col.condition
          ? "rows that fail the column's run-condition are skipped (may run fewer than shown)"
          : "enriches every pending row",
      },
    });
    if (!g.ok) return g.result;
    if (pending > CONFIRM_THRESHOLD) {
      // Large (confirmed) run → delegate to the PERSISTENT sidecar so the work
      // outlives the 5-min agent turn. A synchronous run here would block the turn
      // and be killed mid-way (the "connection drop" on big Firecrawl/enrichment runs).
      // A limit-scoped run forwards its rowIds so the background run honours the scope.
      const port = process.env.GTMGRID_PORT ?? "8787";
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/columns/${col.id}/run/async`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            force,
            concurrency,
            rowIds: limit != null ? scoped.map((row) => row.id) : undefined,
          }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      } catch (e) {
        throw new Error(
          `Couldn't start the background run (${e instanceof Error ? e.message : String(e)}). The user can run it from the column's ▶ button instead.`,
        );
      }
      return ok({
        column: col.name,
        started: true,
        pending,
        note: `Started enriching ${pending} rows in the background — it keeps running past this turn. Poll get_column("${col.name}") or get_table to watch the done count rise, and tell the user when it finishes. Do NOT re-run the column while it's in progress.`,
      });
    }
    const res = await local!.engine.runColumn(col.id, {
      force,
      concurrency: concurrency ?? 5,
      // Only pass an explicit row scope when the caller asked for one; otherwise
      // leave it undefined so the engine runs every row exactly as before.
      rowIds: limit != null ? scoped.map((r) => r.id) : undefined,
    });
    return ok(withRunHint({ column: col.name, ...res }));
  },
);

server.tool(
  "get_table",
  "Get a table's columns + rows (each row carries its _id for update_cells/delete_rows). Bounded: returns up to `limit` rows (default 200) from `offset`, plus totalRows — for a big table, paginate or use find_rows/get_column instead of pulling it all. Large cell values are truncated with a '…[+N chars]' marker (full value stays in the cell; extract fields via a code/formula column); small/compiled columns come through whole.",
  { table: z.string(), limit: z.number().optional(), offset: z.number().optional() },
  async ({ table, limit, offset }) => {
    if (cloudSource) return ok(await cloudSource.getTable(table, { limit, offset }));
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
    if (cloudSource) return ok(await cloudSource.findRows(table, where, columns, limit));
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
    if (cloudSource) return ok(await cloudSource.getColumn(table, column, limit));
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
    if (cloudSource) return ok(await cloudSource.describeColumn(table, column));
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
    const gargs = { table, updates, confirm };
    if (cloudSource) {
      const g = gate("update_cells", gargs, { affected: updates.length, action: "Update cells", target: table });
      if (!g.ok) return g.result;
      return ok(await cloudSource.updateCells(table, updates));
    }
    const t = localTableOr(table);
    const g = gate("update_cells", gargs, { affected: updates.length, action: "Update cells", target: t.name });
    if (!g.ok) return g.result;
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
    const gargs = { table, ids, where, confirm };
    if (cloudSource) {
      // Preview the target count WITHOUT deleting (drives the approval card and
      // short-circuits an empty match), then gate the destructive op.
      const preview = await cloudSource.deleteRows(table, { ids, where, dryRun: true });
      if (preview.deleted === 0) return ok({ deleted: 0, note: "no matching rows" });
      const g = gate("delete_rows", gargs, { affected: preview.deleted, action: "Delete rows", target: table });
      if (!g.ok) return g.result;
      return ok(await cloudSource.deleteRows(table, { ids, where }));
    }
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
    const g = gate("delete_rows", gargs, { affected: targets.size, action: "Delete rows", target: t.name });
    if (!g.ok) return g.result;
    for (const id of targets) local!.db.deleteRow(id);
    return ok({ deleted: targets.size });
  },
);

server.tool(
  "delete_column",
  "Delete a column and its values from every row. DESTRUCTIVE: needs confirm:true after the user approves.",
  { table: z.string(), column: z.string(), confirm: z.boolean().optional() },
  async ({ table, column, confirm }) => {
    const gargs = { table, column, confirm };
    const hint = { hint: "removes the column and its cells from every row" };
    if (cloudSource) {
      const { rows } = await cloudSource.tableStats(table);
      const g = gate("delete_column", gargs, { affected: rows, action: "Delete column", target: `${table} › ${column}`, extra: hint });
      if (!g.ok) return g.result;
      return ok(await cloudSource.deleteColumn(table, column));
    }
    const t = localTableOr(table);
    const col = local!.db.resolveColumn(t.id, column);
    if (!col) throw new Error(`No column "${column}" in "${t.name}"`);
    const g = gate("delete_column", gargs, { affected: local!.db.countRows(t.id), action: "Delete column", target: `${t.name} › ${col.name}`, extra: hint });
    if (!g.ok) return g.result;
    local!.db.deleteColumn(col.id);
    return ok({ deleted: col.name });
  },
);

server.tool(
  "delete_table",
  "Delete an entire table — all of its columns and rows. DESTRUCTIVE: needs confirm:true after the user approves.",
  { table: z.string(), confirm: z.boolean().optional() },
  async ({ table, confirm }) => {
    const gargs = { table, confirm };
    const hint = { hint: "permanently removes the whole table" };
    if (cloudSource) {
      const { rows } = await cloudSource.tableStats(table);
      const g = gate("delete_table", gargs, { affected: rows, action: "Delete table", target: table, extra: hint });
      if (!g.ok) return g.result;
      return ok(await cloudSource.deleteTable(table));
    }
    const t = localTableOr(table);
    const g = gate("delete_table", gargs, { affected: local!.db.countRows(t.id), action: "Delete table", target: t.name, extra: hint });
    if (!g.ok) return g.result;
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
    const blocked = planGuard("update_column", "Update column", `${table} › ${column}`);
    if (blocked) return blocked;
    if (cloudSource) return ok(await cloudSource.updateColumn(table, column, patch));
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
    const blocked = planGuard("rename_table", "Rename table", table);
    if (blocked) return blocked;
    if (cloudSource) return ok(await cloudSource.renameTable(table, name));
    const t = localTableOr(table);
    local!.db.renameTable(t.id, name.trim() || t.name);
    return ok({ renamed: name.trim() || t.name });
  },
);

server.tool(
  "reorder_columns",
  "Move a column to a new 0-based display position within its table (0 = first/leftmost; out-of-range clamps to the ends). Non-destructive — only the column order changes, no cells are touched. Returns the new column-id order.",
  { table: z.string(), column: z.string(), toIndex: z.number().describe("0-based target position (0 = leftmost)") },
  async ({ table, column, toIndex }) => {
    const blocked = planGuard("reorder_columns", "Reorder columns", table);
    if (blocked) return blocked;
    if (cloudSource) return ok(await cloudSource.reorderColumn(table, column, toIndex));
    const t = localTableOr(table);
    const col = local!.db.resolveColumn(t.id, column);
    if (!col) throw new Error(`No column "${column}" in "${t.name}"`);
    return ok({ columnIds: local!.db.moveColumn(col.id, toIndex) });
  },
);

server.tool(
  "reorder_rows",
  "Move a row (by its _id from get_table/find_rows) to a new 0-based display position within its table (0 = first/top; out-of-range clamps). Non-destructive — only the row order changes. Returns the new row-id order.",
  { table: z.string(), row: z.string().describe("The row _id from get_table/find_rows"), toIndex: z.number().describe("0-based target position (0 = top)") },
  async ({ table, row, toIndex }) => {
    const blocked = planGuard("reorder_rows", "Reorder rows", table);
    if (blocked) return blocked;
    if (cloudSource) return ok(await cloudSource.reorderRow(table, row, toIndex));
    const t = localTableOr(table);
    if (!local!.db.listRows(t.id).some((r) => r.id === row)) throw new Error(`Row "${row}" is not in "${t.name}"`);
    return ok({ rowIds: local!.db.moveRow(row, toIndex) });
  },
);

server.tool(
  "run_table",
  "Run EVERY function column over all its pending rows, LEFT-TO-RIGHT (grid order — the natural dependency order, since a later column can reference an earlier column's output). Without `force` each column only fills cells that aren't already `done`; with `force` it recomputes every cell. A large run (more than ~50 pending cells in total) asks first: it returns the pending count + the function-column count — surface that and only re-call with confirm:true once the user approves. Returns a per-column ran/errors breakdown plus the totals.",
  { table: z.string(), force: z.boolean().optional(), concurrency: z.number().optional(), confirm: z.boolean().optional() },
  async ({ table, force, concurrency, confirm }) => {
    const gargs = { table, force, concurrency, confirm };
    const totals = (cols: { ran: number; errors: number }[]) => ({
      ran: cols.reduce((n, c) => n + c.ran, 0),
      errors: cols.reduce((n, c) => n + c.errors, 0),
    });
    if (cloudSource) {
      const fns = await cloudSource.functionColumns(table);
      const pending = force
        ? (await cloudSource.tableStats(table)).rows * fns.length
        : fns.reduce((n, c) => n + c.pending, 0);
      // Treat a full-table run as paid (it runs function columns) — gate accordingly.
      const g = gate("run_table", gargs, { affected: pending, perRowCredits: 1, action: "Run table", target: table, extra: { functionColumns: fns.length } });
      if (!g.ok) return g.result;
      const targets = force ? fns : fns.filter((c) => c.pending > 0);
      const results: { column: string; ran: number; errors: number; firstError?: string }[] = [];
      for (const c of targets) results.push(await cloudSource.runColumn(table, c.name, { force, concurrency }));
      return ok(withRunHint({ columns: results, ...totals(results), firstError: results.find((r) => r.firstError)?.firstError }));
    }
    const t = localTableOr(table);
    const rows = local!.db.listRows(t.id);
    const fnCols = local!.db.listColumns(t.id).filter((c) => c.kind === "function");
    const perCol = fnCols.map((col) => ({
      col,
      pending: force ? rows.length : rows.filter((r) => (local!.db.getCell(r.id, col.id)?.status ?? "empty") !== "done").length,
    }));
    const pending = perCol.reduce((n, c) => n + c.pending, 0);
    // Paid if any function column charges credits — that drives the spend gate.
    const anyPaid = fnCols.some((c) => (c.provider && c.method ? (local!.engine.registry.method(c.provider, c.method)?.credits ?? 0) : 0) > 0);
    const g = gate("run_table", gargs, { affected: pending, perRowCredits: anyPaid ? 1 : 0, action: "Run table", target: t.name, extra: { functionColumns: fnCols.length } });
    if (!g.ok) return g.result;
    const results: { column: string; ran: number; errors: number; firstError?: string }[] = [];
    for (const { col, pending: p } of perCol) {
      if (!force && p === 0) continue; // nothing to do for this column
      const res = await local!.engine.runColumn(col.id, { force, concurrency: concurrency ?? 5 });
      results.push({ column: col.name, ...res });
    }
    return ok({ columns: results, ...totals(results) });
  },
);

server.tool(
  "upload_extension",
  "Upload a JSON-manifest extension (a connector defined as data: baseUrl, auth, and HTTP methods). Its methods become callable via sdk.<id>.<method> and appear in list_functions. Pass the manifest JSON as a string.",
  { manifestJson: z.string().describe("The extension manifest as a JSON string.") },
  async ({ manifestJson }) => {
    const blocked = planGuard("upload_extension", "Upload extension", "project");
    if (blocked) return blocked;
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
    const m = registry.method(provider, method);
    if (!m) throw new Error(`Unknown function ${provider}.${method}. Use list_functions.`);
    // Spend gate: a paid direct dispatch (search/enrich) asks in acceptEdits, and
    // only a human approval unlocks it — the model can't self-confirm a credit spend.
    const g = gate("run_function", { provider, method, input }, {
      affected: 1,
      perRowCredits: m.credits ?? 0,
      estimatedCredits: m.credits ?? 0,
      action: `Run ${provider}.${method}`,
      target: provider,
    });
    if (!g.ok) return g.result;
    // Cloud resolves the workspace's shared credentials through the worker and
    // dispatches in-process (cloud-source.runFunction); local hits the SQLite
    // credential store directly. Same registry validation either way (index.ts:76).
    // A connector auth error (missing/invalid key, 401) is re-thrown with an
    // actionable hint so the agent tells the user which key to connect.
    try {
      const result = cloudSource
        ? await cloudSource.runFunction(provider, method, input ?? {})
        : await local!.engine.dispatch(provider, method, input ?? {});
      return ok(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const hint = errorHint(msg);
      throw new Error(hint === msg ? msg : `${msg}\n\n${hint}`);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
// Token-free banner: report the mode + project only — never the bearer token.
console.error(`gtmgrid MCP server connected (${describeGridEnv(gridEnv)})`);
