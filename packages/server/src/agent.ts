// Agent bridge — spawns the user's already-authenticated `claude` / `codex` CLI
// in headless streaming mode, wired to gtmgrid's MCP server for the active
// project, and forwards text / tool-call / grid-changed events as SSE.
// This is the Revcode "connect your Claude Code / Codex" mechanism: no OAuth,
// no key storage — the app drives the CLI the user already logged into.

import { spawn, execFile, execFileSync, execSync, type SpawnOptions, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, chmodSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import type { ServerResponse } from "node:http";
import { join, dirname, delimiter, extname } from "node:path";
import { corsHeadersFor } from "./cors.js";
import { latestSessionId } from "./agent-history.js";
import { captureServerEvent } from "./observability.js";

const GTM_TOOLS = [
  "list_functions",
  "list_tables",
  "create_table",
  "rename_table",
  "delete_table",
  "add_column",
  "update_column",
  "delete_column",
  "add_rows",
  "update_cells",
  "delete_rows",
  "find_rows",
  "get_column",
  "describe_column",
  "set_dedupe",
  "run_column",
  "run_table",
  "reorder_columns",
  "reorder_rows",
  "get_table",
  "run_function",
  "upload_extension",
  "ask_user_question",
  "list_pipelines",
  "get_pipeline",
  "create_pipeline",
  "patch_pipeline",
  "deploy_pipeline",
];
const MUTATING = new Set([
  "create_table", "rename_table", "delete_table",
  "add_column", "update_column", "delete_column",
  "add_rows", "update_cells", "delete_rows",
  "set_dedupe", "run_column", "run_table",
  "reorder_columns", "reorder_rows", "upload_extension",
  "create_pipeline", "patch_pipeline", "deploy_pipeline",
]);

export interface AgentContext {
  tableName?: string;
  columns?: string[];
  pipelineId?: string;
  pipelineName?: string;
  /** Live snapshot of the connector registry so the skill stays in sync with installed extensions. */
  providers?: Array<{ id: string; name: string; category: string; methodCount: number }>;
  /** Per-tool operating manuals (the `<tool>.skill.md` files) for tools that are CONNECTED,
   *  plus any enabled custom skills. Injected so the agent picks endpoints without guessing. */
  skills?: Array<{ id: string; name: string; body: string }>;
}

/** Render the per-tool skill playbooks for connected tools into the preamble. */
function renderSkillsSection(skills?: AgentContext["skills"]): string {
  if (!skills?.length) return "";
  const blocks = skills
    .filter((s) => s.body && s.body.trim())
    .map((s) => `<skill tool="${s.id}">\n${s.body.trim()}\n</skill>`)
    .join("\n\n");
  if (!blocks) return "";
  return `

## Tool playbooks (READ THESE before using a connected tool)
The following are curated operating manuals for the tools the user has CONNECTED. Each tells you exactly which endpoint to use for each job, the inputs, and copy-paste recipes — so you do NOT need to burn turns on \`list_functions\` guessing. When a task matches one of these tools, follow its playbook first; fall back to \`search_functions\` only for endpoints a playbook doesn't cover.

${blocks}`;
}

/** Render the installed-connectors section dynamically from the registry. */
function renderConnectorsSection(providers?: AgentContext["providers"]): string {
  if (!providers?.length) return "_(No connectors registered. Built-ins like `ai` and `formatting` should always be present — if this is empty, something is wrong.)_";
  const byCategory = new Map<string, typeof providers>();
  for (const p of providers) {
    const cat = p.category || "other";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(p);
  }
  // Stable category order — known first, then alphabetical.
  const KNOWN = ["ai", "formatting", "enrichment", "outreach", "social", "scraping", "research", "meetings", "scoring", "verification", "extraction"];
  const sortedCats = [
    ...KNOWN.filter((c) => byCategory.has(c)),
    ...[...byCategory.keys()].filter((c) => !KNOWN.includes(c)).sort(),
  ];
  const lines: string[] = [];
  for (const cat of sortedCats) {
    const items = byCategory.get(cat)!.sort((a, b) => a.id.localeCompare(b.id));
    const list = items.map((p) => `\`${p.id}\` (${p.methodCount})`).join(", ");
    lines.push(`- **${cat}** — ${list}`);
  }
  return lines.join("\n");
}

/** Operating context for the agent: how gtm grid works + the active table.
 *  This IS the GTM Grid skill — the agent reads this on every turn. */
/**
 * Extra instructions injected when the composer's PLAN MODE is active. Headless
 * `-p` can't surface an interactive plan-approval prompt, so Claude's native
 * plan flow (the `ExitPlanMode` tool) just spins — it presents a plan, gets no
 * approval, retries blocked tools, and narrates "Standing by" forever. We instead
 * teach the agent to plan-then-stop in plain text, which the desktop renders with
 * an Approve button. The agent runs with full tool access here (so research/read
 * tools aren't denied), and THIS note is what keeps it from executing.
 */
const PLAN_MODE_NOTE = `

## PLAN MODE (active)
The user turned on **Plan mode** — they want a PLAN to review, not execution.
- **Investigate, then plan.** Use read-only tools (\`get_table\`, \`describe_column\`, search/web reads) to ground the plan, then present it.
- **Present ONE plan as your FINAL message** — a short markdown doc: a one-line goal, then numbered steps (what to source, which columns to add left-to-right, what to run), and any open questions. Use a markdown table if it helps.
- **Then STOP.** Do NOT execute the plan, create/modify columns, run columns, write files, or change any data. Do NOT call \`ExitPlanMode\` (it does nothing here). After the plan, end your turn and wait — the user will click **Approve** to run it.
- **Never loop.** If a tool is blocked or you're unsure, fold that into the plan as a note or open question — do NOT retry it, and do NOT repeat yourself or narrate "standing by". One plan, then stop.`;

/**
 * Cloud-mode guidance, injected when the agent operates on a shared cloud project
 * (not the local SQLite file). The big behavioural fix: cloud agents must POPULATE
 * tables via `add_rows` (there is no filesystem to stage to) and can address ANY
 * table by name (the cloud source now resolves the `table` arg, not just the
 * active one). Quota errors are surfaced so the agent stops instead of looping.
 */
const CLOUD_NOTE = `

## Cloud project (active)
You're on a **CLOUD** project — shared, multi-user, backed by the team's database (there is **no local filesystem**).
- **Address ANY table by name.** Every table tool takes a \`table\` argument; pass the table's name (or its id from \`list_tables\`). It defaults to the table the user is viewing, but you can read/write any table in the project by naming it — \`get_table(table:"Accounts")\`, \`add_rows(table:"Accounts", …)\`, etc.
- **POPULATE tables with \`add_rows\` — there are NO scratch files.** To put sourced/enriched data into a table, call \`add_rows\` DIRECTLY with the rows. Never write JSON to \`/tmp\` or stage it in a file — there's no filesystem here, so staged data never reaches the grid. If \`add_rows\` reports an unknown column, \`get_table\` that table to read its exact column names, then retry.
- **Batch large inserts.** Send rows in batches of ~25–50 per \`add_rows\` call — keeps each call within size/quota limits and lets you show progress.
- **Quota.** Each row insert and cell write spends a cloud action from the team's plan. If a tool returns a \`[quota]\` / HTTP 402 error ("exceed your plan's remaining cloud actions"), STOP and tell the user they've hit their plan limit (the rejected import wrote nothing) — do not silently retry.`;

export function contextPreamble(ctx?: AgentContext, mode?: string, isCloud?: boolean): string {
  const where = isCloud
    ? "Tables live in your team's **cloud project** (shared, multi-user) — every change writes to the cloud and shows up live for all members."
    : "Tables live in a local SQLite project.";
  const base = `# GTM Grid — operating manual

You are operating **GTM Grid**, a Clay-style ${isCloud ? "cloud" : "local"} spreadsheet where every column is a function. ${where} The user runs you to build GTM pipelines: source prospects, enrich them, score/personalize, push to outreach tools.

## Ground rule — use ONLY the GTM Grid tools
Source, enrich, and write data ONLY through the GTM Grid tools (\`list_tables\`, \`get_table\`, \`add_rows\`, \`add_column\`, \`run_column\`, \`run_function\`, the connectors). You do **not** need a table open to start — call \`list_tables\` to see the project's tables or \`create_table\` to make one, then operate by id. **NEVER** shell out (Bash), read/write local files, or invoke an external CLI or skill (e.g. \`deepline\`, \`npx\`) to find or enrich data — there is no useful local filesystem, those bypass the grid, and their output never reaches the user's tables. If the GTM Grid tools are genuinely unavailable to you this turn, STOP and tell the user to sign in and open their cloud project — do not improvise with other tools.

## Core model
- **Tables** = sheets. **Rows** = records. **Columns** = either MANUAL (user types values) or FUNCTION (runs an enrichment / AI / HTTP call per row).
- A function column is wired to one connector method: \`provider.method\` (e.g. \`trigify.enrichProfile\`, \`leadmagic.emailFinder\`, \`ai.generate\`, \`formatting.normalizeDomain\`).
- A function column's params can reference OTHER columns via \`{{Column Name}}\` templates — that's how data flows row-by-row. Example: an Email column with \`fn: 'leadmagic.emailFinder'\` and \`params: { first_name: "{{First Name}}", last_name: "{{Last Name}}", domain: "{{Domain}}" }\`.
- "Code" columns run a sandboxed JS body (\`function(inputs, sdk){ ... }\`) for custom transforms or to call \`sdk.<provider>.<method>(...)\` directly.

## Columns vs reusable pipelines
Do not turn every request into a pipeline. Choose the smallest durable abstraction:
- Use an **ordinary function column** for one independent enrichment or transform whose result belongs in one column.
- Use **dependent columns** for a linear, table-specific sequence where each stage is useful and visible as a column.
- Use a **pipeline** only when at least one is true: the logic must be reused across tables, it branches, it has multiple outputs, it needs an independent deploy/version lifecycle, or it must run from schedules/webhooks/remote events.
- When the request clearly fits one side, choose it without adding friction: default to columns for a simple one-table linear job, and use a pipeline when the user explicitly asks for a workflow/automation or the logic clearly needs one of the capabilities above.
- When both designs are genuinely viable and the choice materially changes visibility, reuse, or maintenance, ask one concise question before mutating anything: explain the concrete tradeoff and offer **visible table columns** versus **one reusable pipeline-backed column**. Do not ask this for routine one-step work.
- Before creating a pipeline, call \`list_pipelines\`; reuse or extend an existing one when its purpose matches. When an active pipeline is supplied below and the user says "this pipeline", "this workflow", or "the canvas", target it directly instead of searching by name.
- You can build a complete graph with \`create_pipeline(graph)\`, or build/edit any portion of an existing graph with \`patch_pipeline\`. Patches support adding, updating and removing nodes; adding and removing edges; and atomically replacing a node's outgoing branches.
- Pipeline edits are draft-only. Call \`get_pipeline\` first, then use the smallest atomic \`patch_pipeline\` set that leaves the graph connected and valid. Preserve unaffected node positions and configuration. Never deploy merely to test.
- A table attachment has one pipeline output column. Every terminal path result is stored together as structured JSON in that cell; do not propose writing individual node outputs directly into unrelated table columns. If the user wants a field elsewhere, add a later formula/function column that reads it from the structured pipeline result.
- For inserts, deletes, branches and re-branches, include all required node and edge changes in one patch call. Use fresh stable ids for new nodes/edges and inspect the returned graph before claiming success.
- If an active pipeline is present, \`get_pipeline\`, \`patch_pipeline\`, and \`deploy_pipeline\` default to it, so the id may be omitted. Attempt the relevant tool before claiming pipeline tools are disconnected; if a call fails, report its exact error.
- \`deploy_pipeline\` changes production behavior and is approval-gated. Explain what version/attachments are affected and wait for approval.
- Cloud pipeline charging is one action when each executable node starts for a record. Input/output routing is free; skipped branches are free; pipeline output cell writes are not charged again. Mention the estimate before a large run.

## Slash commands
The user can steer you with slash commands typed in the chat. When their message STARTS with one (e.g. \`/goal …\`), treat the leading \`/word\` as the command and the rest of the line as its argument, follow the protocol below, then resume normal operation. An unrecognized \`/word\` is just ordinary text — answer normally.

- **/goal <objective>** — the user is handing you an OBJECTIVE to pursue end-to-end, not a single instruction. Work it like an agent:
  1. **Align** — restate the goal in one line so the user can correct course early.
  2. **Plan** — lay out a short numbered plan of how you'll reach it with the table tools (what to source, which columns to add left-to-right, what to run).
  3. **Execute autonomously** — carry out the plan in order without waiting for "continue" between steps: \`get_table\` first, build columns, and TEST on 1 row before any bulk \`run_column\`. Use real \`provider.method\`s (discover via \`search_functions\`).
  4. **Honor the confirm protocol** — you still STOP for the user's explicit OK before any delete, a \`run_column\` over ~25 paid rows, or spending >~50 credits (never set \`confirm:true\` on your own).
  5. **Report** — when the goal is met (or you're blocked), give a short summary of what you achieved vs the objective and the next step / what you need.
  If the objective after \`/goal\` is empty, ask the user what the goal is rather than guessing.

## Tool discovery (DO NOT call list_functions blindly)
The catalog is huge (Trigify alone exposes 122 methods). Discover in this order:
1. **list_providers** — see the landscape (provider id, name, category, method count). Always call this first if you're unsure what's available.
2. **search_functions(query)** — search by intent (e.g. "enrich linkedin", "find email", "monitor twitter"). Returns concise hits.
3. **list_functions(provider:'trigify')** — only when you need the full input schema for ONE provider's methods. Calling it without \`provider\` returns everything and may blow your token budget.

## Common patterns
- **Source rows**: use \`run_function\` to call a search/source method directly (e.g. \`trigify.createLinkedInPostsSearch\` then \`trigify.searchResults\`, or \`trigify.socialMapping\`), then \`add_rows\` with the results.
- **Enrich rows**: add a function column wired to an enrichment method (e.g. \`trigify.enrichProfile\` with \`params: { profileUrl: "{{LinkedIn URL}}" }\`), then \`run_column\` to fill it. \`run_column\` runs in grid order (top-down) — pass \`limit: N\` to fill just the next N unfilled rows (and \`offset\` to skip the first matches), or omit it to fill every pending row.
- **Personalize**: \`ai.generate\` columns with a prompt referencing other columns — e.g. prompt \`"Write a 2-sentence intro for {{First Name}} who works at {{Company}}"\`. Pass the model + system as params.
- **Format/Normalize**: the \`formatting\` connector has 12 free helpers — normalizeDomain, normalizePhoneNumber, splitFullName, formatDate, titleCase, etc. Use these BEFORE enrichment to clean inputs.
- **Promote JSON fields**: when an enrichment returns a JSON object, do NOT leave it raw. Add code columns to extract the useful fields. Example: \`add_column code="function(i){ var v=JSON.parse(i.src); return v.data && v.data.email; }" params={ src: "{{Enriched Profile}}" }\`.
- **Join tables — do NOT multiply them**: when data belongs in another table (or needs to come FROM one), wire the tables together instead of creating a new table per step:
  - \`table.push\` sends each WHOLE row into another table in the project, webhook-style: the raw row lands in the target's "Pushed data" json column, MANUAL target columns whose names match the source's fill AUTOMATICALLY, and the TARGET table's field mapping (its Incoming data panel — the same mapping a webhook has, paths are the SOURCE table's column names) routes everything else. Deduplicated on a key so re-runs UPDATE instead of duplicating. Example: \`add_column fn='table.push' params={ targetTable: '<table id or exact name>', keyColumn: 'Email', keyValue: '{{Email}}' }\` — \`mode:'append'\` skips dedupe; \`autoRunTarget:true\` runs the target's own function columns on each pushed row (its push columns are skipped, so no loops). Add a \`condition\` to push only qualified rows — that's how you route a filtered segment into a master/outreach table. Editing the target's mapping later can BACKFILL rows already pushed.
  - \`table.lookup\` pulls a matching row's data IN from another table (a per-row JOIN): \`add_column fn='table.lookup' params={ targetTable: 'Accounts', matchColumn: 'Domain', matchValue: '{{Domain}}', return: ['Owner','Tier'] }\` — returns the matched record as JSON (promote fields as usual); \`multiple:'all'|'count'\` for multi-match, \`notFound:'error'\` to surface misses. Use a lookup BEFORE re-enriching: if another table already holds the data, join it instead of paying for the enrichment again.

## Working the table (operational best practices)

### Before you build
- **Read first, write second.** Call \`get_table\` to see what columns + rows already exist before adding new columns or running anything. Don't recreate what's there. Don't assume column names — they're case-sensitive in \`{{templates}}\`.
- **Understand existing columns before touching them.** If a column already has data and you need to know HOW it was computed (e.g. the user asks "how is Branch Count worked out?", or you're about to re-run/edit it), call \`describe_column\` — it returns the column's function/method, params, "only run if" condition, and full code. Don't rebuild a column you can just read. (\`get_table\` also surfaces a capped condition/code/params per column for a quick scan.)
- **Plan the pipeline left-to-right.** Inputs on the left (LinkedIn URL, Email, Domain…), enrichments next, derived/formatted in the middle, AI personalization toward the right. Don't add a column whose params reference something that doesn't exist yet.
- **Pick clean, human-readable column names.** "Email" not "email_address_v2", "First Name" not "fname". These names ARE the API the user types into \`{{First Name}}\` later.

### Iterating safely (do NOT bulk-run cold)
- **Test on 1 row first.** When adding a new function column, after \`add_column\` add ONE row via \`add_rows\` and call \`run_column\` on it. Inspect the result with \`get_table\`. Only after it looks right do you bulk-run. (To smoke-test an EXISTING column cheaply, \`run_column(..., limit: 1)\` runs just the first unfilled row.)
- **For sourcing**: when calling \`run_function\` to discover prospects, START SMALL — \`page_size: 10\`, \`max_results: 25\`. Show the user the sample, ask if it's the right cohort, then go wider.
- **Credits awareness.** Most paid connectors charge 1 credit per row. Before \`run_column\` on a column where \`credits > 0\` with more than ~25 rows, state the expected cost (\`rows × credits\`) and confirm. Free helpers (the \`formatting\` connector, \`ai.generate\` on a user-supplied key) don't need confirmation.

### Run controls (what the UI gives the user)
- The grid has **Auto-run**: when ON, editing/adding a manual cell that a function column depends on auto-recomputes the dependent cells. Don't fight it — when Auto-run is on, just \`add_rows\` and the function columns fill themselves.
- Users can run a **single cell** (hover, click ▶) or a **whole column** (the per-column run button in the header) or **everything** (Run all in the toolbar). \`run_column\` from your side is equivalent to clicking the column run button. When the user asks to run "10 rows" / "the next 20" / "a few", pass \`run_column(..., limit: N)\` — it enriches the next N unfilled rows IN GRID ORDER. Do NOT read rows and hand-pick a subset to enrich; that scatters the work across non-adjacent rows.
- Runs are **idempotent**: \`run_column\` skips cells already \`done\` unless you pass \`force: true\`. Re-running after a transient error is safe.

### Full grid control — and the confirm protocol
You control the whole grid, not just appends:
- **Read precisely** instead of pulling everything. \`get_table\` is paginated (\`limit\`/\`offset\`, returns \`totalRows\`) and truncates fat cells — for a big table use \`find_rows(where:{ Column: value })\` to search, or \`get_column\` to scan one field. Every row comes back with an \`_id\`.
- **Edit**: \`update_cells\` (set/clear cells by \`_id\`), \`update_column\` (change a column's config — non-destructive), \`rename_table\`.
- **Delete**: \`delete_rows\` (by \`_id\` or \`where\`), \`delete_column\`, \`delete_table\`.
- **Dedup**: \`set_dedupe(table, column, keep)\` keeps a table unique on a column — then \`add_rows\` auto-skips duplicates, so you can stream paginated sourcing straight in (no scripts, no scratch files). \`column:null\` turns it off.

**Confirm protocol — non-negotiable.** Delete tools, a large \`update_cells\`, and a big \`run_column\` will return \`{ confirmationRequired: true, willAffect, estimatedCredits? }\` and DO NOTHING. When you see that: STOP, tell the user plainly what will happen ("This will delete 4,200 rows from Leads — proceed?"), and only re-call the SAME tool with \`confirm: true\` AFTER they explicitly approve. NEVER set \`confirm:true\` on your own — that flag exists to carry the user's permission, not your intent.

### Handling errors
- A cell with \`status: "error"\` shows a red **Status Code: 4xx/5xx** pill in the grid. Click → opens the cell-details drawer with the full error body.
- **\`run_column\`/\`run_table\` now return an \`errorHint\`** when cells errored — read it and relay it to the user verbatim instead of digging through \`get_table\`. It already says which key to connect (or that a quota was hit).
- When you see errors (in an \`errorHint\` or \`get_table\` output):
  - **"No AI provider connected"** → an AI column has no key AND no agent fallback was reachable. Tell the user to connect an AI key (Anthropic / OpenAI / OpenRouter) in the Extensions panel. (When the user has no key, AI columns automatically fall back to their connected Claude/Codex agent model — so this only surfaces when neither is available.)
  - **401/403 / "Authentication required"** → the connector's API key is missing or invalid. Tell the user to connect it in the Extensions panel; do NOT silently retry.
  - **422/400** → wrong inputs. Show the user the offending row(s) and ask whether to fix params, clean the input column, or skip those rows.
  - **429** → rate limited. Wait, then \`run_column\` again (it skips already-done cells).
  - **5xx** → provider blip. One retry is fine; if it persists, surface it.
- When fixing a broken column, prefer **updateColumn** or clearing the bad cells over deleting + recreating (preserves cell history).

### Long values, JSON, and clipping
- Cells clip to column width. Long text (a transcript, a summary, an LLM completion) stays whole in the cell — the user clicks ⤢ to expand. Don't truncate before storing.
- JSON objects show as a "Status Code: 200" pill; click opens a fields drawer where the user can promote individual fields to their own columns. If you want to surface specific fields yourself, add code columns (see Promote JSON fields above).

### When to ASK vs just do
- ASK before: dumping many columns, spending more than ~50 credits, deleting/clearing data, picking which AI model/system prompt to use, choosing the cohort size for a source query.
- Just do (no ask): obvious normalizations, single-row test runs, reading via \`get_table\`, retrying a transient failure once.
- **HOW to ask a choice:** when the decision is a pick between options (which model, which cohort size, which of several columns to add, disambiguating an unclear request), call \`ask_user_question\` instead of writing the options out in prose. Pass 1–4 \`questions\`, each with a short \`header\`, the \`question\`, and 2–4 \`options\` (\`{label, description}\`); set \`multiSelect:true\` when several can apply. The user picks via answer cards (or types their own answer). After calling it, STOP and end your turn — do NOT answer for them; their reply comes back as the next message. (The destructive/credit confirm protocol above still uses \`confirm:true\` on the SAME tool, not \`ask_user_question\`.)

### Stay scoped to the active table
- The user is operating ONE table at a time (passed in the "Active table" section below). When they say "this table", "this row", "this column", "here" — that's the one. Don't create new tables unless asked.
- If you need a scratch space, use a code column on the current table rather than spinning up a new table.

## Hard rules
- **ASK before dumping columns.** When a source has many possible fields (transcripts, profiles with 30 fields, search results), DO NOT auto-create a column for every field. Ask the user which they want and suggest a short sensible default (e.g. for a transcript: Title, Date, Summary, Action Items — not the full transcript text).
- **Long text is fine to store.** The grid clips cells to column width and the user can click ⤢ to expand into a full editor.
- **Test on 1 row, then bulk.** Never run a new function column over all rows without first verifying it works on one.
- **No fabricated provider.method.** Always verify with \`search_functions\` or \`list_functions\` before \`add_column\`/\`run_function\`. Calling a non-existent function throws.
- **Reference real column names.** Templates are case-sensitive: \`{{First Name}}\` ≠ \`{{first name}}\`. Use \`get_table\` to read the exact column names before writing params.
- **Credits ≥ 25 rows → confirm first.**
- **Don't auto-fix errors that look like auth (401/403).** Tell the user.

## Connectors currently installed
${renderConnectorsSection(ctx?.providers)}
This snapshot is generated fresh from the live registry each turn — new extensions added to gtm grid appear here automatically. Use \`list_providers\` + \`search_functions\` to drill in, then \`list_functions\` scoped to one provider for the input schemas.
${renderSkillsSection(ctx?.skills)}

## Style
- Be terse. State the plan in one line, do the work, summarize.
- When the user says "this table", "this row", "this column" — they mean the one they're viewing (passed in context below).
- If a step fails, surface the error (status code + message) and ASK before retrying with different inputs.`;

  const cloud = isCloud ? CLOUD_NOTE : "";
  const plan = mode === "plan" ? PLAN_MODE_NOTE : "";
  let active = "";
  if (ctx?.tableName) {
    const cols = ctx.columns?.length ? ` Its columns are: ${ctx.columns.join(", ")}.` : "";
    active += `\n\n## Active table\nThe user is viewing **"${ctx.tableName}"**.${cols} When they say "this table" or don't name one, operate on this one.`;
  }
  if (ctx?.pipelineId) {
    const name = ctx.pipelineName?.trim() || "Untitled pipeline";
    active += `\n\n## Active pipeline\nThe user has **"${name}"** open on the workflow canvas (pipeline id: \`${ctx.pipelineId}\`). When they say "this pipeline", "this workflow", "this automation", "the flow", or "the canvas", they mean this pipeline. You may build it completely or modify only the requested portion: add, configure, update, move, connect, branch, re-branch, or delete nodes and edges with the pipeline tools.\n\n**Pipeline tools are mounted through the same \`gtmgrid\` MCP server as table tools.** Claude may defer their schemas between turns; a deferred/removed schema does NOT mean the tools disconnected. For every request that inspects or changes this pipeline, use ToolSearch to load \`mcp__gtmgrid__get_pipeline\` and, when editing, \`mcp__gtmgrid__patch_pipeline\`, then call \`get_pipeline\` in the current turn before answering. Treat any earlier claim that the pipeline tools were disconnected as stale session memory. Only report a connection problem after a current-turn ToolSearch or pipeline tool call returns an actual error.`;
  }
  return base + cloud + plan + active;
}

/**
 * Claude resumes a long-lived native session. Its deferred-tool index can retain
 * an old turn where pipeline schemas were removed from immediate context and the
 * model may incorrectly remember that as an MCP disconnect. Put the recovery
 * directive next to the current user request as well as in the system preamble;
 * this is deliberately Claude-only because ToolSearch is a Claude runtime tool.
 */
export function claudeTaskMessage(message: string, ctx?: AgentContext): string {
  if (!ctx?.pipelineId) return message;
  return `[GTM Grid active pipeline: ${ctx.pipelineName?.trim() || "Untitled pipeline"} (${ctx.pipelineId})]\nIf this request inspects or changes the pipeline, first use ToolSearch for mcp__gtmgrid__get_pipeline and mcp__gtmgrid__patch_pipeline, then call get_pipeline now. Deferred or previously removed tool schemas are discoverable and are not a disconnect; do not rely on an earlier turn's availability claim.\n\n${message}`;
}

/**
 * The Claude `--permission-mode` value for the composer mode. Valid CLI values are
 * `default | acceptEdits | bypassPermissions | plan`.
 * - `auto` is the COMPOSER's label, not a CLI value — map it to `default` so the
 *   CLI doesn't error on an unknown flag (selecting "Auto" previously sent an
 *   invalid `--permission-mode auto`).
 * - `plan` maps to `bypassPermissions` on purpose: native `plan` denies
 *   research/read tools in headless `-p` and the agent loops on the denials — the
 *   {@link PLAN_MODE_NOTE} preamble enforces plan-only instead.
 *
 * This flag only governs Claude's OWN (non-grid) tools; the gtmgrid grid tools are
 * pre-approved via `--allowedTools`, so grid-tool gating is the MCP layer's job.
 */
export function claudePermissionMode(mode?: string): string {
  if (mode === "auto") return "default";
  if (mode === "acceptEdits" || mode === "bypassPermissions") return mode;
  return "bypassPermissions"; // plan + absent + anything unexpected
}

/**
 * If a tool_result is a gtmgrid `confirmationRequired` payload carrying an
 * `approvalRequest` (the MCP gate paused on a destructive/credit-spending op),
 * build the `permission_request` SSE event the desktop renders as an approval
 * card. Returns null for ordinary results. Shared by all three provider bridges
 * so the HITL surface is identical regardless of provider.
 */
export function permissionEventFromToolResult(raw: string): Record<string, unknown> | null {
  try {
    const p = JSON.parse(raw.trim());
    if (
      p &&
      typeof p === "object" &&
      p.confirmationRequired === true &&
      p.approvalRequest &&
      typeof p.approvalRequest === "object"
    ) {
      return { type: "permission_request", ...(p.approvalRequest as Record<string, unknown>) };
    }
  } catch {
    /* not JSON — no permission request */
  }
  return null;
}

/**
 * If a tool_result is a gtmgrid `ask_user_question` payload, build the `ask_user`
 * SSE event the desktop renders as answer cards (replacing the composer). Returns
 * null for ordinary results. Shared by all three provider bridges so the
 * AskUserQuestion surface is identical regardless of provider.
 */
export function questionEventFromToolResult(raw: string): Record<string, unknown> | null {
  try {
    const p = JSON.parse(raw.trim());
    if (p && typeof p === "object" && p.askUserQuestion === true && Array.isArray(p.questions)) {
      return { type: "ask_user", questions: p.questions };
    }
  } catch {
    /* not JSON — no question request */
  }
  return null;
}

export type AgentKind = "claude" | "codex" | "cursor";

// The on-PATH binary name for each agent. Mostly identical to the kind, except
// Cursor's headless CLI is `cursor-agent` (not `cursor`). Resolution, version
// probing and scanning all go through this so a kind never has to equal its bin.
const AGENT_BIN: Record<AgentKind, string> = { claude: "claude", codex: "codex", cursor: "cursor-agent" };

const isWindows = process.platform === "win32";

// On Windows a CLI on PATH is one of several files. The native installers (the
// recommended path for all three: claude.exe in %USERPROFILE%\.local\bin, the
// codex.exe Rust binary, cursor-agent) ship a real `.exe` that Node can spawn
// directly. An `npm i -g` install instead drops cmd-shims (`<bin>.cmd`/`.ps1`)
// in %APPDATA%\npm. We must (a) try every extension and (b) PREFER the `.exe`,
// because a `.cmd`/`.bat` shim cannot be launched by spawn/execFile without a
// shell (EINVAL since the CVE-2024-27980 patch in Node ≥18.20.2). `.ps1` is
// never selected over `.cmd` since cmd.exe can't run it.
function binCandidates(kind: AgentKind): string[] {
  const base = AGENT_BIN[kind];
  if (!isWindows) return [base];
  return [".exe", ".cmd", ".bat", ""].map((ext) => base + ext);
}

// A resolved `.cmd`/`.bat` shim needs a shell to run (see above); a bare `.exe`
// (or any POSIX binary) is spawned directly. `.ps1` would need PowerShell, which
// we avoid by never preferring it over `.cmd`.
function needsShell(binPath: string): boolean {
  if (!isWindows) return false;
  const ext = extname(binPath).toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

// ── Locating the user's CLIs ──────────────────────────────────────────────
// GUI apps launch with a minimal PATH and version managers (nvm) only set up
// their PATH in *interactive* shells. So we resolve the binary three ways:
// a saved manual override, the user's interactive login shell, then a scan of
// common install locations.

const CONFIG_DIR = join(homedir(), ".gtmgrid");
const AGENTS_CONFIG = join(CONFIG_DIR, "agents.json");
const resolveCache: Partial<Record<AgentKind, string | null>> = {};

function loadOverrides(): Partial<Record<AgentKind, string>> {
  try {
    return JSON.parse(readFileSync(AGENTS_CONFIG, "utf8"));
  } catch {
    return {};
  }
}

export function setAgentPath(kind: AgentKind, path: string | null): void {
  const cfg = loadOverrides();
  if (path) cfg[kind] = path;
  else delete cfg[kind];
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(AGENTS_CONFIG, JSON.stringify(cfg, null, 2));
  resolveCache[kind] = undefined;
}

let cachedLoginPath: string | null | undefined;
function loginPath(): string {
  // Windows GUI apps inherit the full user+system PATH (no interactive-shell
  // dance like nvm on macOS), and there's no POSIX login shell to query — so the
  // sniff below is macOS/Linux only.
  if (isWindows) return "";
  if (cachedLoginPath === undefined) {
    const shell = process.env.SHELL || "/bin/zsh";
    cachedLoginPath = (() => {
      for (const flags of [["-lic", "echo $PATH"], ["-ic", "echo $PATH"], ["-lc", "echo $PATH"]]) {
        try {
          const out = execFileSync(shell, flags, { encoding: "utf8", timeout: 6000, stdio: ["ignore", "pipe", "ignore"] });
          const line = out.split("\n").map((l) => l.trim()).filter((l) => l.includes("/"))[0];
          if (line) return line;
        } catch {
          /* try next */
        }
      }
      return null;
    })();
  }
  return cachedLoginPath ?? "";
}

/** Common install locations, including all nvm node versions. */
function candidateDirs(): string[] {
  const home = homedir();
  if (isWindows) {
    // Documented Windows install targets:
    //  - %USERPROFILE%\.local\bin → native installers (claude.exe, cursor-agent)
    //  - %APPDATA%\npm            → `npm i -g` cmd-shims (claude.cmd, codex.cmd…)
    //  - %LOCALAPPDATA%\Microsoft\WinGet\Links → winget shims (codex via winget)
    // The native-installer dir is frequently NOT on PATH (a known claude-code
    // issue), which is exactly why the `where` lookup alone misses it.
    const dirs = [join(home, ".local", "bin")];
    if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, "npm"));
    if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"));
    return dirs;
  }
  const dirs = ["/opt/homebrew/bin", "/usr/local/bin", join(home, ".local/bin"), join(home, ".npm-global/bin"), join(home, "Library/pnpm")];
  const nvm = join(home, ".nvm/versions/node");
  try {
    for (const v of readdirSync(nvm)) dirs.push(join(nvm, v, "bin"));
  } catch {
    /* no nvm */
  }
  return dirs;
}

/** macOS/Linux: resolve via the user's interactive login shell (picks up nvm &
 *  friends, whose PATH only exists in interactive shells). */
function whichPosix(bin: string): string | null {
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const out = execFileSync(shell, ["-lic", `command -v ${bin} 2>/dev/null`], {
      encoding: "utf8",
      timeout: 6000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("/") && existsSync(l))[0] ?? null;
  } catch {
    return null;
  }
}

/** Windows: resolve via `where.exe`, which searches PATH (and applies PATHEXT).
 *  We probe each ext-qualified name in preference order so an `.exe` wins over a
 *  `.cmd` shim. `windowsHide` keeps a console window from flashing. */
function whichWindows(names: string[]): string | null {
  for (const name of names) {
    if (!name) continue; // skip the bare "" entry; PATHEXT handles extensionless lookup
    try {
      const out = execFileSync("where", [name], {
        encoding: "utf8",
        timeout: 6000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      const hit = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && existsSync(l))[0];
      if (hit) return hit;
    } catch {
      /* not on PATH under this name — try the next */
    }
  }
  return null;
}

/** Resolve a CLI's absolute path (override → PATH lookup → common dirs). */
export function resolveAgentPath(kind: AgentKind): string | null {
  if (resolveCache[kind] !== undefined) return resolveCache[kind]!;
  let found: string | null = null;
  const override = loadOverrides()[kind];
  if (override && existsSync(override)) {
    found = override;
  } else {
    const names = binCandidates(kind);
    found = isWindows ? whichWindows(names) : whichPosix(AGENT_BIN[kind]);
    if (!found) {
      scan: for (const dir of candidateDirs()) {
        for (const name of names) {
          if (!name) continue;
          const p = join(dir, name);
          if (existsSync(p)) {
            found = p;
            break scan;
          }
        }
      }
    }
  }
  resolveCache[kind] = found;
  return found;
}

/** The PATH env-var key. Windows env names are case-insensitive but a plain
 *  object spread is NOT, so reuse the existing key (usually `Path`) to avoid
 *  ending up with both `Path` and `PATH` (ambiguous for the child). */
const PATH_KEY = isWindows
  ? (Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "Path")
  : "PATH";

/** Environment for spawning an agent: PATH includes the binary's dir (so its
 *  sibling `node` is found) plus the user's login PATH. */
function agentSpawnEnv(binPath: string): NodeJS.ProcessEnv {
  const parts = [dirname(binPath), loginPath(), process.env[PATH_KEY] ?? ""].filter(Boolean);
  return { ...process.env, [PATH_KEY]: parts.join(delimiter) };
}

// ── Agent isolation (intentionally OFF) ────────────────────────────────────────
// We previously isolated the agent from the user's personal Claude/Codex config
// (claude `--setting-sources project --disable-slash-commands`, codex
// `--ignore-user-config`) to stop a `deepline-gtm` skill from being used instead of
// gtmgrid's tools. But that treated a SYMPTOM. The ROOT cause was that the agent had
// NO gtmgrid tools when no table was open — the cloud context required an active
// tableId, so the MCP failed to start and the agent improvised with whatever skill
// was lying around. Now that tableId is optional (the MCP connects on sign-in +
// cloud project alone — see packages/mcp/cloud-context.ts), the gtmgrid tools are
// ALWAYS available, so the agent uses THEM. We therefore RE-ENABLE the user's +
// built-in skills — notably the native `/goal`, whose Stop-hook loop runs a goal to
// completion (which `--disable-slash-commands` had broken). The "use ONLY GTM Grid
// tools" ground rule in the preamble keeps it on the grid. Re-add a flag here only
// if the deepline fallback ever returns despite tools being available.
const CLAUDE_ISOLATION_ARGS: string[] = [];
const CODEX_ISOLATION_ARGS: string[] = [];

/** Spawn an agent CLI cross-platform. A Windows `.cmd`/`.bat` shim cannot be
 *  launched without a shell (EINVAL), so route those through one; native `.exe`
 *  / POSIX binaries spawn directly. `windowsHide` suppresses a console flash. */
function spawnAgent(binPath: string, args: string[], opts: SpawnOptions): ChildProcessWithoutNullStreams {
  // We never override stdio, so stdout/stderr/stdin are always piped (non-null);
  // the cast restores the precise type `spawn` infers from a literal options arg.
  if (needsShell(binPath)) {
    // shell:true runs `cmd.exe /c "<bin>" <args>`; quote the path for spaces.
    return spawn(`"${binPath}"`, args, { ...opts, shell: true, windowsHide: true }) as ChildProcessWithoutNullStreams;
  }
  return spawn(binPath, args, { ...opts, windowsHide: true }) as ChildProcessWithoutNullStreams;
}

function versionOf(kind: AgentKind): { installed: boolean; version: string | null; path: string | null } {
  const path = resolveAgentPath(kind);
  if (!path) return { installed: false, version: null, path: null };
  try {
    // First line only — some CLIs print a multi-line report; claude/codex/cursor are single-line.
    const opts = { encoding: "utf8" as const, timeout: 5000, env: agentSpawnEnv(path), windowsHide: true };
    // A `.cmd`/`.bat` shim needs a shell; `--version` has no spaces so quoting the path is enough.
    const out = needsShell(path)
      ? execSync(`"${path}" --version`, opts)
      : execFileSync(path, ["--version"], opts);
    const v = out.toString().split("\n")[0].trim();
    return { installed: true, version: v || null, path };
  } catch {
    return { installed: false, version: null, path };
  }
}

export function detectAgents() {
  return { claude: versionOf("claude"), codex: versionOf("codex"), cursor: versionOf("cursor") };
}

/** Clear caches so the next detect re-resolves (after install / manual connect). */
export function rescanAgents(): void {
  resolveCache.claude = undefined;
  resolveCache.codex = undefined;
  resolveCache.cursor = undefined;
  cachedLoginPath = undefined;
}

interface SseClient {
  write: (event: Record<string, unknown>) => void;
  end: () => void;
}

// ── Process-group lifecycle (TRI-3305) ────────────────────────────────────
// Agent turns spawn the CLI (`claude`/`codex`), which in turn spawns the gtmgrid
// MCP server + its own subprocesses. Killing only the direct child orphans that
// whole tree, which accumulates to multiple GB. We spawn each child `detached`
// so it becomes its own process-group/session leader, then on cleanup signal the
// ENTIRE group (negative pid) — SIGTERM, then SIGKILL after a grace if it ignores
// the term — using only native `process.kill` (no `tree-kill` dependency).

/** How long to wait after SIGTERM before escalating to SIGKILL. */
export const KILL_GRACE_MS = 3000;
/**
 * IDLE timeout: terminate a turn only after this long with NO output from the
 * CLI. Reset on every chunk the child streams (see `manageChildLifecycle.touch`),
 * so a task that's actively streaming tool calls is never killed — only a
 * genuinely STALLED/hung process (which is what leaks the multi-GB process tree)
 * trips it. This is the fix for "the agent stops mid-task": a long cloud table
 * build streams continuously and so never goes idle, where the old fixed
 * wall-clock cap (5 min since spawn) killed it routinely (TRI-3305).
 */
export const MAX_IDLE_MS = 5 * 60_000;
/**
 * Absolute ceiling on a single turn regardless of activity — a backstop against
 * a child that streams forever (e.g. a runaway loop that never goes idle). Armed
 * once at spawn and never reset.
 */
export const MAX_RUN_MS = 60 * 60_000;
/** Keep only the last ~32KB of stderr so a chatty/looping child can't grow the heap. */
export const STDERR_CAP = 32 * 1024;

/** User-facing SSE error text when a turn is force-terminated by a timeout. */
export function turnTimeoutMessage(agent: string, reason: "idle" | "ceiling"): string {
  return reason === "idle"
    ? `${agent} turn was terminated after ${Math.round(MAX_IDLE_MS / 1000)}s with no output (it looked hung)`
    : `${agent} turn hit the ${Math.round(MAX_RUN_MS / 60_000)}-minute limit and was terminated`;
}

/** Minimal slice of a spawned child the lifecycle manager needs (so tests can fake it). */
export interface ManagedChild {
  readonly pid?: number;
  on(event: "close", listener: () => void): unknown;
}

/** Injectable seam for the OS calls, so the lifecycle is unit-testable offline. */
export interface ProcessControl {
  kill: (pid: number, signal: NodeJS.Signals) => void;
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

const defaultProcessControl: ProcessControl = {
  kill: (pid, signal) => process.kill(pid, signal),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/**
 * Wire group-kill cleanup + two turn timeouts to a detached child. Returns a
 * `terminate()` to invoke on `res.on("close")` (panel unmount / Stop / new send),
 * a `dispose()` the `child.on("close")` handler calls so timers are cleared, and
 * a `touch()` to call on every chunk of child output so the IDLE timer resets.
 *
 * Two independent timeouts protect against two different failures:
 *  - IDLE ({@link MAX_IDLE_MS}): re-armed on each `touch()`. Fires only after the
 *    child has produced NO output for the whole window — i.e. it's genuinely
 *    hung (and leaking its process tree). A turn that streams continuously, like
 *    a long cloud table build, keeps touching it and so is never killed. This is
 *    the fix for turns dying mid-task.
 *  - CEILING ({@link MAX_RUN_MS}): armed once at spawn, never reset. A backstop
 *    for a child that streams forever without ever going idle.
 *
 * Guarantees (the regression-test contract):
 *  - `terminate()` signals the whole GROUP: `kill(-pid, "SIGTERM")`, then
 *    `kill(-pid, "SIGKILL")` after {@link KILL_GRACE_MS} if the child hasn't closed.
 *  - Once the child closes, `exited` is set and the escalation timer is cleared —
 *    so NO signal is ever sent after exit (avoids killing a recycled pid).
 *  - Whichever turn timeout fires first cancels the other, terminates the group,
 *    and invokes `onTimeout(reason)` (to emit an SSE error+end) exactly once.
 *  - Every `kill` is wrapped so an already-dead group (`ESRCH`) is a no-op.
 */
export function manageChildLifecycle(
  child: ManagedChild,
  opts: {
    onTimeout: (reason: "idle" | "ceiling") => void;
    control?: ProcessControl;
    graceMs?: number;
    idleMs?: number;
    maxRunMs?: number;
  },
): { terminate: () => void; dispose: () => void; touch: () => void } {
  const ctrl = opts.control ?? defaultProcessControl;
  const graceMs = opts.graceMs ?? KILL_GRACE_MS;
  const idleMs = opts.idleMs ?? MAX_IDLE_MS;
  const maxRunMs = opts.maxRunMs ?? MAX_RUN_MS;

  let exited = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let ceilingTimer: ReturnType<typeof setTimeout> | null = null;

  const signalGroup = (signal: NodeJS.Signals): void => {
    const pid = child.pid;
    if (exited || pid === undefined) return;
    try {
      // Negative pid → the whole process group (CLI + MCP server + grandchildren).
      ctrl.kill(-pid, signal);
    } catch {
      /* ESRCH: the group is already gone — nothing to kill. */
    }
  };

  function terminate(): void {
    if (exited) return;
    signalGroup("SIGTERM");
    if (killTimer === null) {
      killTimer = ctrl.setTimeout(() => {
        killTimer = null;
        signalGroup("SIGKILL");
      }, graceMs);
    }
  }

  // A turn timeout tripped: cancel BOTH turn timers so the sibling can't also
  // fire, then terminate the group and surface it exactly once.
  function fireTimeout(reason: "idle" | "ceiling"): void {
    if (idleTimer !== null) {
      ctrl.clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (ceilingTimer !== null) {
      ctrl.clearTimeout(ceilingTimer);
      ceilingTimer = null;
    }
    terminate();
    opts.onTimeout(reason);
  }

  const armIdle = (): void => {
    idleTimer = ctrl.setTimeout(() => {
      idleTimer = null;
      fireTimeout("idle");
    }, idleMs);
  };

  /** Reset the idle countdown — call on every sign of life from the child. */
  function touch(): void {
    if (exited || idleTimer === null) return;
    ctrl.clearTimeout(idleTimer);
    armIdle();
  }

  ceilingTimer = ctrl.setTimeout(() => {
    ceilingTimer = null;
    fireTimeout("ceiling");
  }, maxRunMs);
  armIdle();

  function dispose(): void {
    exited = true;
    if (killTimer !== null) {
      ctrl.clearTimeout(killTimer);
      killTimer = null;
    }
    if (idleTimer !== null) {
      ctrl.clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (ceilingTimer !== null) {
      ctrl.clearTimeout(ceilingTimer);
      ceilingTimer = null;
    }
  }

  child.on("close", dispose);
  return { terminate, dispose, touch };
}

/** Append `chunk` to `buf` but keep only the trailing {@link STDERR_CAP} bytes. */
export function appendCapped(buf: string, chunk: string, cap = STDERR_CAP): string {
  const next = buf + chunk;
  return next.length > cap ? next.slice(next.length - cap) : next;
}

// The agent SSE stream is the most privileged route (it spawns the user's CLI),
// so it carries the SAME allowlisted CORS as the JSON routes — NEVER `*` (#22).
// A disallowed Origin gets no `access-control-allow-origin` header (and is
// already 403'd before we get here); `origin` undefined = non-browser caller.
function sseClient(res: ServerResponse, origin?: string): SseClient {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...corsHeadersFor(origin),
  });
  return {
    write: (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
    end: () => res.end(),
  };
}

/** Test-only handle to the real SSE writer so the #22 CORS tests exercise the
 *  shipped header logic (allowlisted `access-control-allow-origin`, never `*`)
 *  rather than a reconstruction. Not used by the server itself. */
export const __sseClientForTest = sseClient;

/**
 * How to launch the gtmgrid MCP server for a spawned agent CLI: the bundled
 * `node` binary run directly with `mcp.mjs` as a script argument.
 *
 * This is deliberately NOT a shell-script launcher. A `#!/bin/bash` launcher
 * (or an extensionless one) cannot be executed on Windows, and a `.cmd`/`.bat`
 * shim would need per-CLI shell handling that claude/codex/cursor do not all
 * provide — so on Windows the grid tools silently never load. Spawning
 * `node <script>` directly is the one shape every MCP client launches the same
 * way on macOS, Linux AND Windows.
 *
 * - Packaged: the Rust shell exports `GTMGRID_MCP_NODE` + `GTMGRID_MCP_SCRIPT`
 *   (both absolute and de-verbatim'd — see the `dunce::simplified` fix).
 * - Dev: run the TS entry through `tsx` with the server's own `node`.
 * - Legacy: an explicit `GTMGRID_MCP_LAUNCHER` (a single command, no args) is
 *   still honoured for back-compat / manual override.
 */
export function mcpLaunch(repoRoot: string): { command: string; args: string[] } {
  const node = process.env.GTMGRID_MCP_NODE;
  const script = process.env.GTMGRID_MCP_SCRIPT;
  if (node && script) return { command: node, args: [script] };
  const legacy = process.env.GTMGRID_MCP_LAUNCHER;
  if (legacy) return { command: legacy, args: [] };
  return {
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "packages", "mcp", "src", "index.ts")],
  };
}

type ExtraMcpServer = { command: string; args?: string[]; env?: Record<string, string> };

/**
 * Cloud context threaded to the spawned MCP server (TRI-3296) so its table tools
 * operate on the user's CLOUD (Supabase) project instead of local SQLite. The
 * desktop forwards this only when a cloud project is active; in local mode it is
 * `undefined` and the MCP opens the local SQLite project exactly as before. The
 * `token` is the signed-in member's bearer — passed via the spawned process'
 * ENV (never a CLI arg) and never logged.
 */
export interface AgentCloud {
  readonly apiUrl: string;
  readonly token: string;
  readonly workspaceId: string;
  readonly projectId: string;
  /** The active table — OPTIONAL: the agent works with no table loaded. */
  readonly tableId?: string;
  /** The active pipeline canvas — OPTIONAL and independent of the active table. */
  readonly pipelineId?: string;
}

/**
 * Validate the `cloud` block of an `/api/agent/chat` body into an
 * {@link AgentCloud}, or `undefined` when it is absent/incomplete. A cloud
 * context requires apiUrl/token/workspaceId/projectId to be non-empty strings —
 * the user must be signed in with a cloud project — but `tableId` is OPTIONAL, so
 * the agent has its gtmgrid tools even with NO table loaded (it can list_tables /
 * create_table / operate by id). Any missing required field falls back to local
 * mode (so a half-populated block never half-activates cloud routing). Trims each value.
 */
export function parseAgentCloud(raw: unknown): AgentCloud | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  // Spread into a plain record so each field can be read without an `as` cast.
  const obj: Record<string, unknown> = { ...raw };
  const read = (key: string): string | undefined => {
    const value = obj[key];
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  };
  const apiUrl = read("apiUrl");
  const token = read("token");
  const workspaceId = read("workspaceId");
  const projectId = read("projectId");
  const tableId = read("tableId"); // optional — may be absent when no table is open
  const pipelineId = read("pipelineId"); // optional — may be absent when no pipeline is open
  if (apiUrl === undefined || token === undefined || workspaceId === undefined || projectId === undefined) {
    return undefined;
  }
  return { apiUrl, token, workspaceId, projectId, tableId, pipelineId };
}

/**
 * The env the MCP server is spawned with. LOCAL: only `GTMGRID_PROJECT`
 * (byte-identical to before). CLOUD: `GTMGRID_MODE=cloud` plus the threaded
 * apiUrl/token/workspace/project/table so `selectGridEnv` in the MCP resolves a
 * cloud data source. For claude/codex the token rides the ENV on an ephemeral
 * argv, never touching disk. (Cursor is the exception — it has no inline MCP flag,
 * so {@link writeCursorMcpConfig} writes this env to a 0600 file it deletes after
 * the turn.)
 */
/** A human-approved action, threaded into the resumed turn's MCP env (Phase 2). */
export interface AgentApproval {
  readonly tool: string;
  readonly argsHash: string;
}

/**
 * The essential Windows OS env vars forwarded to the spawned MCP server. The agent
 * CLI (claude) hands the MCP an EXPLICIT env map; if it does NOT merge the OS
 * defaults, the Electron-as-Node MCP child can't even start on Windows — without
 * `SystemRoot`/`PATH` the process fails to load its DLLs before `mcp.mjs` ever runs
 * (the telemetry shows the MCP process never starts there, while macOS is fine).
 * No-op off Windows; never overrides our `GTMGRID_*` keys (no collisions).
 */
function windowsBaseEnv(): Record<string, string> {
  if (process.platform !== "win32") return {};
  const keys = [
    "SystemRoot", "SYSTEMROOT", "windir", "PATH", "Path", "PATHEXT", "TEMP", "TMP",
    "SystemDrive", "HOMEDRIVE", "HOMEPATH", "USERPROFILE", "USERNAME", "APPDATA",
    "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "COMSPEC",
    "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
  ];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  return out;
}

export function mcpEnv(
  project: string,
  cloud?: AgentCloud,
  mode?: string,
  approval?: AgentApproval,
): Record<string, string> {
  // The sidecar's own HTTP port — lets the MCP delegate a large run to the
  // PERSISTENT server (which outlives the 5-min agent turn) instead of blocking.
  const port = process.env.GTMGRID_PORT ?? "8787";
  // Permission mode + (on a resumed-after-approval turn) the human's approval.
  // Setting GTMGRID_PERMISSION_MODE is what activates the MCP's mode gate; the
  // approval vars are the model-inaccessible channel that unlocks a confirm.
  const perm: Record<string, string> = {};
  if (mode) perm.GTMGRID_PERMISSION_MODE = mode;
  if (approval) {
    perm.GTMGRID_APPROVED_TOOL = approval.tool;
    perm.GTMGRID_APPROVED_ARGS_HASH = approval.argsHash;
  }
  // Forward the PostHog config so the spawned MCP can deliver its own startup
  // beacon (mcp_started). The CLI gives the MCP an EXPLICIT env map (Codex even
  // replaces it wholesale), so without this the child has no key and silently
  // no-ops. (The MCP tags itself "mcp" via installProcessHandlers, so no source
  // var needed.) Conditional on the keys being set — absent in tests / unconfigured.
  const obs: Record<string, string> = {};
  if (process.env.GTMGRID_POSTHOG_KEY) obs.GTMGRID_POSTHOG_KEY = process.env.GTMGRID_POSTHOG_KEY;
  if (process.env.GTMGRID_POSTHOG_HOST) obs.GTMGRID_POSTHOG_HOST = process.env.GTMGRID_POSTHOG_HOST;
  // Under Electron the MCP launcher is the Electron binary (GTMGRID_MCP_NODE =
  // process.execPath); ELECTRON_RUN_AS_NODE makes it run `mcp.mjs` as plain Node.
  // It is set ONLY here (the MCP's own spawn env), never on the engine — the engine
  // is an Electron utilityProcess that crashes if ELECTRON_RUN_AS_NODE is present.
  if (process.env.GTMGRID_MCP_ELECTRON_NODE) obs.ELECTRON_RUN_AS_NODE = "1";
  if (!cloud) return { ...windowsBaseEnv(), GTMGRID_PROJECT: project, GTMGRID_PORT: port, ...obs, ...perm };
  return {
    ...windowsBaseEnv(),
    GTMGRID_PROJECT: project,
    GTMGRID_PORT: port,
    GTMGRID_MODE: "cloud",
    GTMGRID_API_URL: cloud.apiUrl,
    GTMGRID_TOKEN: cloud.token,
    GTMGRID_WORKSPACE_ID: cloud.workspaceId,
    GTMGRID_CLOUD_PROJECT: cloud.projectId,
    // Only when a table is actually open — the MCP treats it as optional.
    ...(cloud.tableId ? { GTMGRID_CLOUD_TABLE: cloud.tableId } : {}),
    // Lets pipeline tools target the canvas the user is currently viewing.
    ...(cloud.pipelineId ? { GTMGRID_CLOUD_PIPELINE: cloud.pipelineId } : {}),
    ...obs,
    ...perm,
  };
}

/**
 * Build the MCP config for claude. The gtmgrid server's env is resolved via
 * {@link mcpEnv} so it carries the cloud context (TRI-3296) when `cloud` is set;
 * `extra` merges in any additional servers (none today — kept for extensibility).
 * Exported for tests.
 */
export function mcpConfig(
  repoRoot: string,
  project: string,
  extra?: Record<string, ExtraMcpServer>,
  cloud?: AgentCloud,
  mode?: string,
  approval?: AgentApproval,
): string {
  const { command, args } = mcpLaunch(repoRoot);
  return JSON.stringify({
    mcpServers: {
      gtmgrid: { command, args, env: mcpEnv(project, cloud, mode, approval) },
      ...extra,
    },
  });
}

/** What we read off Claude Code's `{type:"system", subtype:"init", mcp_servers,
 *  tools}` event to tell whether gtmgrid's MCP server actually connected for this
 *  turn — the key signal for debugging "tools not connected" on Windows. Returns
 *  null for any other event. Pure; exported for tests. */
export function parseClaudeInit(
  e: unknown,
): { mcpConnected: boolean; gtmgridTools: number; mcpServersRaw: string } | null {
  if (!e || typeof e !== "object") return null;
  const ev = e as { type?: string; subtype?: string; mcp_servers?: unknown; tools?: unknown };
  if (ev.type !== "system" || ev.subtype !== "init") return null;
  const servers = Array.isArray(ev.mcp_servers) ? ev.mcp_servers : [];
  const gtm = servers.find((s) => (s as { name?: string } | null)?.name === "gtmgrid") as
    | { status?: string }
    | undefined;
  const tools = Array.isArray(ev.tools) ? ev.tools : [];
  const gtmgridTools = tools.filter(
    (t) => typeof t === "string" && t.startsWith("mcp__gtmgrid__"),
  ).length;
  // Capture EXACTLY what Claude reported about the MCP servers (status, and any
  // error/reason fields it includes) so a remote "tools not connected" turn — esp.
  // on Windows, where the MCP process never even starts — tells us WHY, not just
  // that it failed. Capped to keep the event small.
  return {
    mcpConnected: gtm?.status === "connected",
    gtmgridTools,
    mcpServersRaw: JSON.stringify(servers).slice(0, 800),
  };
}

/** Per-turn observability accumulator (one per agent stream). */
interface AgentTurnStats {
  startedAt: number;
  toolCalls: number;
  mcpConnected?: boolean;
  gtmgridTools?: number;
  /** Raw `mcp_servers` from Claude's init — the "why didn't it connect" detail. */
  mcpServersRaw?: string;
}

/**
 * Emit one `agent_turn_completed` event to PostHog — server-side, the only path
 * that reliably delivers (the Tauri webview blocks posthog-js in packaged builds).
 * Records which provider/model/mode ran, WHETHER gtmgrid's MCP tools connected and
 * how many, the tool-call count, exit status, platform/arch and cloud identity — so
 * a remote Windows user's "tools not connected" turn is visible and filterable in
 * PostHog. Best-effort: never throws into a turn.
 */
function captureAgentTurn(
  provider: AgentKind,
  opts: { model?: string; mode?: string; cloud?: AgentCloud },
  stats: AgentTurnStats,
  exitCode: number | null,
  cwd: string,
  stderrTail?: string,
): void {
  try {
    // When the MCP DIDN'T connect, attach the why: Claude's raw mcp_servers status
    // + the agent CLI's stderr tail (where a spawn failure — ENOENT, the spaced
    // 'C:\Program Files\GTM Grid' path, an ELECTRON_RUN_AS_NODE issue — surfaces).
    // Only on failure, to keep healthy turns small and avoid shipping stderr noise.
    const mcpFailed = stats.mcpConnected === false;
    captureServerEvent("agent_turn_completed", {
      provider,
      model: opts.model ?? null,
      mode: opts.mode ?? null,
      cloud: !!opts.cloud,
      workspace_id: opts.cloud?.workspaceId ?? null,
      project_id: opts.cloud?.projectId ?? null,
      table_id: opts.cloud?.tableId ?? null,
      platform: process.platform,
      arch: process.arch,
      // The ACTUAL spawn cwd the agent ran from — so a remote (esp. Windows) user's
      // turn shows whether it ran inside our defined ~/.gtmgrid/workspace or drifted
      // into some other dir (the old "agent working out of a random repo" bug).
      cwd,
      mcp_connected: stats.mcpConnected ?? null,
      gtmgrid_tools: stats.gtmgridTools ?? null,
      mcp_servers_raw: mcpFailed ? (stats.mcpServersRaw ?? null) : null,
      mcp_stderr_tail: mcpFailed && stderrTail ? stderrTail.slice(-1200) : null,
      tool_calls: stats.toolCalls,
      exit_code: exitCode,
      is_error: exitCode !== 0 && exitCode !== null,
      duration_ms: Date.now() - stats.startedAt,
    });
  } catch {
    /* observability is best-effort — never break a turn */
  }
}

/** Stream a Claude Code turn over SSE, driving gtmgrid via MCP. */
export function streamClaude(
  res: ServerResponse,
  opts: { message: string; project: string; repoRoot: string; sessionId?: string; newChat?: boolean; context?: AgentContext; origin?: string; model?: string; mode?: string; cloud?: AgentCloud; providerEnv?: Record<string, string>; approval?: AgentApproval },
): void {
  const sse = sseClient(res, opts.origin);
  const taskMessage = claudeTaskMessage(opts.message, opts.context);
  const args = [
    "-p",
    taskMessage,
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    mcpConfig(opts.repoRoot, opts.project, undefined, opts.cloud, opts.mode, opts.approval),
    // Use ONLY gtmgrid's MCP server — ignore the user's other Claude Code MCP
    // servers (Trigify/Clay/etc.) so the agent drives gtmgrid's own tools instead
    // of reaching for an external MCP (auth walls). The gtmgrid server's env
    // carries cloud context (TRI-3296) when in cloud mode.
    "--strict-mcp-config",
    // Isolate from the user's personal Claude config (skills/plugins/hooks/CLAUDE.md)
    // while keeping their login — see CLAUDE_ISOLATION_ARGS.
    ...CLAUDE_ISOLATION_ARGS,
    "--allowedTools",
    ...GTM_TOOLS.map((t) => `mcp__gtmgrid__${t}`),
  ];
  const preamble = contextPreamble(opts.context, opts.mode, !!opts.cloud);
  if (preamble) args.push("--append-system-prompt", preamble);
  if (opts.model) args.push("--model", opts.model);
  // Permission posture (the composer's mode picker). Default to bypass — it
  // matches the codex/cursor bridges and stops non-grid tools (Bash, grep) being
  // denied in headless `-p`, where an "ask" prompt can't be surfaced anyway. PLAN
  // mode also runs at bypass (see claudePermissionMode) so research tools aren't
  // denied; the PLAN_MODE_NOTE preamble keeps it from executing. The gtmgrid
  // tools stay pre-approved via --allowedTools regardless of the mode.
  args.push("--permission-mode", claudePermissionMode(opts.mode));
  // Bind to the user's OWN session, not a client-stored id: an explicit id (a
  // History pick) wins; otherwise — unless they asked for a New chat — resume the
  // latest native session for this project. So continuity survives a Stop or app
  // restart (we re-read the CLI's transcript store) with nothing persisted by us.
  const resumeId = opts.sessionId ?? (opts.newChat ? null : latestSessionId("claude", opts.repoRoot));
  if (resumeId) args.push("--resume", resumeId);

  const bin = resolveAgentPath("claude");
  if (!bin) {
    sse.write({ type: "error", message: "Claude Code not found. Connect it in the panel or install @anthropic-ai/claude-code." });
    sse.write({ type: "end" });
    return sse.end();
  }
  // `detached` makes the child its own process-group leader so we can later
  // signal the WHOLE tree (CLI + MCP server + grandchildren) via `-pid` (TRI-3305).
  // Saved provider keys (TRIGIFY_API_KEY etc.) fill in UNDER process.env so an
  // explicitly exported var still wins; values never appear in args or logs.
  const child = spawnAgent(bin, args, { env: { ...opts.providerEnv, ...agentSpawnEnv(bin) }, cwd: opts.repoRoot, detached: true });
  child.stdin?.end(); // we pass the prompt via `-p`; close stdin so claude doesn't wait on it (the "no stdin data in 3s" warning)
  let sessionId = resumeId ?? null;
  let buf = "";
  let gridDirty = false;
  const stats: AgentTurnStats = { startedAt: Date.now(), toolCalls: 0 };
  const lifecycle = manageChildLifecycle(child, {
    onTimeout: (reason) => {
      sse.write({ type: "error", message: turnTimeoutMessage("claude", reason) });
      sse.write({ type: "end", sessionId });
      sse.end();
    },
  });

  child.stdout.on("data", (chunk) => {
    lifecycle.touch(); // the child is alive and streaming — defer the idle timeout
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      // DON'T capture the session id from the init/intermediate messages: in
      // `-p` mode the init message can carry a transient id that is never saved
      // as a resumable conversation (`--resume` on it → "No conversation
      // found"). Only the id on the final `result` event is durable (captured in
      // the `result` branch below). Continuity after a Stop/restart comes from
      // the on-disk latest-session fallback above, which is always a real
      // resumable transcript.

      // Observability: read the init event to learn whether gtmgrid's MCP server
      // connected this turn + how many tools it exposed (the Windows debug signal).
      const init = parseClaudeInit(e);
      if (init) {
        stats.mcpConnected = init.mcpConnected;
        stats.gtmgridTools = init.gtmgridTools;
        stats.mcpServersRaw = init.mcpServersRaw;
      }

      if (e.type === "assistant") {
        for (const block of e.message?.content ?? []) {
          if (block.type === "text" && block.text) sse.write({ type: "text", text: block.text });
          else if (block.type === "tool_use") {
            stats.toolCalls++;
            const short = String(block.name).replace(/^mcp__gtmgrid__/, "");
            sse.write({ type: "tool", name: short, raw: block.name, input: block.input ?? {} });
            // Claude's NATIVE AskUserQuestion: in headless `-p` the CLI stubs the
            // tool_result ("Answer questions?") and ends the turn, so we intercept
            // the tool_use itself and surface the questions as answer cards. The
            // native input shape ({questions:[{header,question,multiSelect,options}]})
            // matches the desktop's AskRequest exactly. (Codex/Cursor have no native
            // tool and instead call mcp__gtmgrid__ask_user_question — caught below.)
            if (block.name === "AskUserQuestion" && Array.isArray(block.input?.questions)) {
              sse.write({ type: "ask_user", questions: block.input.questions });
            }
            if (block.name?.startsWith("mcp__gtmgrid__") && MUTATING.has(short)) gridDirty = true;
          }
        }
      } else if (e.type === "user") {
        // Tool results come back as a user message with tool_result blocks.
        for (const block of e.message?.content ?? []) {
          if (block.type === "tool_result") {
            const text = Array.isArray(block.content)
              ? block.content.map((c: any) => (c?.type === "text" ? c.text : "")).join("")
              : typeof block.content === "string"
                ? block.content
                : "";
            if (text) sse.write({ type: "tool_result", result: text.slice(0, 600) });
            const pe = text ? permissionEventFromToolResult(text) : null;
            if (pe) sse.write(pe);
            const qe = text ? questionEventFromToolResult(text) : null;
            if (qe) sse.write(qe);
          }
        }
      } else if (e.type === "result") {
        // The `result` id is the durable, resumable one — surface it (falls back
        // to the resume id we started with if this event omits it).
        if (e.session_id) sessionId = e.session_id;
        sse.write({ type: "done", result: e.result ?? "", sessionId, isError: e.is_error ?? e.subtype !== "success" });
      }
      // Nudge the UI to refetch as soon as a mutating tool runs (not just at the end).
      if (gridDirty) {
        sse.write({ type: "grid" });
        gridDirty = false;
      }
    }
  });

  let stderr = "";
  child.stderr.on("data", (d) => {
    lifecycle.touch(); // stderr output is also a sign of life — only TRUE silence (no stdout AND no stderr) is "idle"
    stderr = appendCapped(stderr, d.toString());
  });

  child.on("error", (err) => {
    lifecycle.dispose();
    sse.write({ type: "error", message: `Failed to launch claude: ${err.message}` });
    sse.end();
  });
  child.on("close", (code) => {
    captureAgentTurn("claude", opts, stats, code, opts.repoRoot, stderr);
    if (code !== 0 && code !== null) {
      sse.write({ type: "error", message: stderr.slice(-400) || `claude exited ${code}` });
    }
    sse.write({ type: "end", sessionId });
    sse.end();
  });

  // Panel unmount / Stop / new send closes the response → kill the whole group.
  res.on("close", () => lifecycle.terminate());
}

function resultText(result: any): string {
  const content = result?.content;
  if (Array.isArray(content)) return content.map((c: any) => (c?.type === "text" ? c.text : "")).join("");
  return typeof result === "string" ? result : JSON.stringify(result ?? "");
}

/** Stream a Codex turn over SSE. Wires gtmgrid's MCP server per-exec (dynamic
 *  project) and bypasses approval prompts for headless tool use. */
/**
 * Render an MCP env map as a Codex inline-TOML table (`{ KEY = "value", ... }`),
 * escaping each value's backslashes and double-quotes so a token containing
 * those characters cannot break out of the string or inject extra TOML. Keys are
 * fixed `GTMGRID_*` identifiers, so only the values need escaping.
 */
/** A single TOML basic-string value, with backslashes and quotes escaped. This
 *  matters on Windows, where the MCP `command`/`args` are absolute paths full of
 *  `\` separators (`C:\…\node.exe`) — emitting them unescaped produces invalid
 *  TOML and Codex fails to mount the gtmgrid server. */
export function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A TOML array of basic strings (each escaped via {@link tomlString}). */
export function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

export function codexEnvToml(env: Record<string, string>): string {
  const entries = Object.entries(env).map(([k, v]) => `${k} = ${tomlString(v)}`);
  return `{ ${entries.join(", ")} }`;
}

/**
 * Codex `exec` sandbox/approval flags for the composer's permission mode.
 *
 * We use `--dangerously-bypass-approvals-and-sandbox` for EVERY mode because it's
 * the only sandbox flag accepted by BOTH `codex exec <msg>` AND the
 * `codex exec resume <id> <msg>` subcommand a follow-up turn uses — `-s/--sandbox`
 * exists on a fresh `exec` but is rejected by `resume` ("unexpected argument
 * '--sandbox'"), which broke multi-turn Codex chats. Mode differentiation for
 * Codex therefore comes from the PREAMBLE instead: PLAN mode injects
 * {@link PLAN_MODE_NOTE} (plan-only, don't execute), exactly as Claude's plan
 * mode does. `mode` is kept in the signature for symmetry with the Claude bridge.
 */
export function codexSandboxFlags(_mode?: string): string[] {
  return ["--dangerously-bypass-approvals-and-sandbox"];
}

/**
 * The user's default `model` and `model_reasoning_effort` from
 * `~/.codex/config.toml` (top-level keys only).
 *
 * `streamCodex` passes `--ignore-user-config` to stop Codex auto-loading the
 * user's other MCP servers (see there) — but that same flag also drops these
 * model defaults, so we read and re-inject them. Only the region BEFORE the first
 * `[table]` header is scanned, since `model` also appears under `[profiles.*]` /
 * `[model_providers.*]` and must not be picked up. Returns `{}` when the file is
 * absent/unreadable. Custom `[model_providers]` are NOT restored — those rare
 * setups aren't supported by the embedded agent.
 */
export function codexUserModelDefaults(
  home = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
): { model?: string; reasoningEffort?: string } {
  try {
    const top = readFileSync(join(home, "config.toml"), "utf8").split(/^\s*\[/m)[0];
    const grab = (k: string) => top.match(new RegExp(`^\\s*${k}\\s*=\\s*"([^"]*)"`, "m"))?.[1]?.trim() || undefined;
    return { model: grab("model"), reasoningEffort: grab("model_reasoning_effort") };
  } catch {
    return {};
  }
}

export interface AgentModelOption {
  value: string;
  label: string;
}

export interface CodexModelOptions {
  models: AgentModelOption[];
  defaultModel?: string;
  source: "cache" | "default";
  fetchedAt?: string;
}

/**
 * Models currently available to the authenticated Codex CLI.
 *
 * Codex refreshes `models_cache.json` from the user's plan, so reading that file
 * keeps the desktop picker current without maintaining another static model
 * list or requiring an OpenAI API key. Hidden/internal entries are excluded.
 */
export function codexModelOptions(
  home = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
): CodexModelOptions {
  const defaultModel = codexUserModelDefaults(home).model;
  try {
    const raw = JSON.parse(readFileSync(join(home, "models_cache.json"), "utf8")) as {
      fetched_at?: unknown;
      models?: unknown;
    };
    if (!Array.isArray(raw.models)) throw new Error("models must be an array");
    const seen = new Set<string>();
    const models: AgentModelOption[] = [];
    for (const entry of raw.models) {
      if (!entry || typeof entry !== "object") continue;
      const model = entry as {
        slug?: unknown;
        display_name?: unknown;
        visibility?: unknown;
      };
      const value = typeof model.slug === "string" ? model.slug.trim() : "";
      if (!value || seen.has(value) || model.visibility === "hide") continue;
      seen.add(value);
      models.push({
        value,
        label:
          typeof model.display_name === "string" && model.display_name.trim()
            ? model.display_name.trim()
            : value,
      });
    }
    if (models.length > 0) {
      return {
        models,
        ...(defaultModel ? { defaultModel } : {}),
        source: "cache",
        ...(typeof raw.fetched_at === "string" ? { fetchedAt: raw.fetched_at } : {}),
      };
    }
  } catch {
    // A fresh install may not have a cache until Codex has run once. Default is
    // still usable because streamCodex passes the configured model explicitly.
  }
  return {
    models: [],
    ...(defaultModel ? { defaultModel } : {}),
    source: "default",
  };
}

export function streamCodex(
  res: ServerResponse,
  opts: { message: string; project: string; repoRoot: string; threadId?: string; newChat?: boolean; context?: AgentContext; origin?: string; model?: string; mode?: string; cloud?: AgentCloud; providerEnv?: Record<string, string>; approval?: AgentApproval },
): void {
  const sse = sseClient(res, opts.origin);
  const { command: mcpCommand, args: mcpArgs } = mcpLaunch(opts.repoRoot);
  const preamble = contextPreamble(opts.context, opts.mode, !!opts.cloud);
  const message = preamble ? `${preamble}\n\n${opts.message}` : opts.message;
  // Isolate Codex to ONLY the gtmgrid MCP server. `-c mcp_servers={…}` on its own
  // is NOT enough: Codex deep-merges `-c` overrides into the loaded config, so the
  // user's own servers stay live — both the `[mcp_servers.*]` from config.toml
  // (Trigify/exa/…) AND the bundled plugin servers (linear/computer-use). Codex
  // then connects to all of them at exec startup, and any OAuth-walled HTTP server
  // makes rmcp's transport worker quit fatally ("Transport channel closed, when
  // AuthRequired"), taking the whole turn down. Codex has no --strict-mcp-config
  // flag; --ignore-user-config is the only switch that drops BOTH the config.toml
  // servers and the plugin servers — we then re-add only gtmgrid. (The Claude
  // bridge gets the same isolation from --strict-mcp-config.)
  //
  // --ignore-user-config also drops the user's model + reasoning-effort defaults
  // (auth still rides CODEX_HOME, and `exec resume` still accepts the flag), so we
  // re-inject them from config.toml. Without this the panel's "Default" model picks
  // nothing and Codex falls back to its built-in gpt-5.x-codex, which 400s on
  // ChatGPT-auth accounts. A panel-picked model (opts.model) still wins.
  const userDefaults = codexUserModelDefaults();
  const resolvedModel = opts.model || userDefaults.model;
  const flags = [
    "--json",
    "--skip-git-repo-check",
    // Isolate from the user's personal Codex config (~/.codex/config.toml: global
    // instructions + MCP servers) while keeping their login — see CODEX_ISOLATION_ARGS.
    ...CODEX_ISOLATION_ARGS,
    ...codexSandboxFlags(opts.mode),
    "--ignore-user-config",
    "-c",
    `mcp_servers={ gtmgrid = { command = ${tomlString(mcpCommand)}, args = ${tomlStringArray(mcpArgs)}, env = ${codexEnvToml(mcpEnv(opts.project, opts.cloud, opts.mode, opts.approval))} } }`,
    ...(userDefaults.reasoningEffort ? ["-c", `model_reasoning_effort="${userDefaults.reasoningEffort}"`] : []),
    ...(resolvedModel ? ["-m", resolvedModel] : []),
  ];
  // Same binding as Claude: an explicit threadId (History pick) wins, else resume
  // the latest native Codex thread for this project unless a New chat was asked for.
  const resumeThread = opts.threadId ?? (opts.newChat ? null : latestSessionId("codex", opts.repoRoot));
  const args = resumeThread
    ? ["exec", "resume", resumeThread, ...flags, message]
    : ["exec", ...flags, message];

  const bin = resolveAgentPath("codex");
  if (!bin) {
    sse.write({ type: "error", message: "Codex not found. Connect it in the panel or install @openai/codex." });
    sse.write({ type: "end" });
    return sse.end();
  }
  // `detached` → own process group, so cleanup can kill the CLI + the gtmgrid
  // MCP server + their subprocesses as one group, not just the codex parent.
  // Saved provider keys fill in UNDER process.env — an exported var still wins.
  const child = spawnAgent(bin, args, { env: { ...opts.providerEnv, ...agentSpawnEnv(bin) }, cwd: opts.repoRoot, detached: true });
  child.stdin?.end(); // codex exec otherwise waits on stdin

  let threadId = resumeThread ?? null;
  let buf = "";
  const stats: AgentTurnStats = { startedAt: Date.now(), toolCalls: 0 };
  const lifecycle = manageChildLifecycle(child, {
    onTimeout: (reason) => {
      sse.write({ type: "error", message: turnTimeoutMessage("codex", reason) });
      sse.write({ type: "end", sessionId: threadId });
      sse.end();
    },
  });
  child.stdout.on("data", (chunk) => {
    lifecycle.touch(); // the child is alive and streaming — defer the idle timeout
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === "thread.started") {
        threadId = e.thread_id ?? e.thread?.id ?? threadId;
        sse.write({ type: "session", sessionId: threadId });
      } else if (e.type === "item.completed") {
        const item = e.item ?? {};
        if (item.type === "mcp_tool_call") {
          stats.toolCalls++;
          const short = String(item.tool ?? "");
          sse.write({ type: "tool", name: short, raw: `mcp__${item.server}__${short}`, input: item.arguments ?? {} });
          if (!item.error && item.result) {
            const rtext = resultText(item.result);
            sse.write({ type: "tool_result", name: short, result: rtext.slice(0, 600) });
            const pe = permissionEventFromToolResult(rtext);
            if (pe) sse.write(pe);
            const qe = questionEventFromToolResult(rtext);
            if (qe) sse.write(qe);
          }
          if (MUTATING.has(short)) sse.write({ type: "grid" });
        } else if (item.type === "agent_message" && item.text) {
          sse.write({ type: "text", text: item.text });
        }
      }
    }
  });

  let stderr = "";
  child.stderr.on("data", (d) => {
    lifecycle.touch(); // stderr output is also a sign of life — only TRUE silence (no stdout AND no stderr) is "idle"
    stderr = appendCapped(stderr, d.toString());
  });
  child.on("error", (err) => {
    lifecycle.dispose();
    sse.write({ type: "error", message: `Failed to launch codex: ${err.message}` });
    sse.end();
  });
  child.on("close", (code) => {
    captureAgentTurn("codex", opts, stats, code, opts.repoRoot);
    if (code !== 0 && code !== null) {
      sse.write({ type: "error", message: stderr.split("\n").filter((l) => /error|fatal/i.test(l)).slice(-1)[0] || `codex exited ${code}` });
    }
    sse.write({ type: "done", result: "", sessionId: threadId, isError: false });
    sse.write({ type: "end", sessionId: threadId });
    sse.end();
  });
  // Panel unmount / Stop / new send closes the response → kill the whole group.
  res.on("close", () => lifecycle.terminate());
}

/**
 * One-shot, NON-streaming text generation through the connected coding agent CLI
 * (Claude Code preferred, then Codex) — NOT the engine's API AI provider. Used by
 * the formula / "only run if" generator so it reuses whatever model the user has
 * already authenticated in Claude Code / Codex. No MCP servers / tools are loaded:
 * this is a pure prompt → text call. Returns the model's answer, or an `error`
 * string telling the user to connect an agent when neither CLI is available.
 */
export async function generateWithAgent(
  prompt: string,
  system: string,
): Promise<{ text: string } | { error: string }> {
  const claude = resolveAgentPath("claude");
  if (claude) return runClaudeOneShot(claude, prompt, system);
  const codex = resolveAgentPath("codex");
  if (codex) return runCodexOneShot(codex, prompt, system);
  return { error: "Connect Claude Code or Codex to use AI generation." };
}

function runClaudeOneShot(bin: string, prompt: string, system: string): Promise<{ text: string } | { error: string }> {
  return new Promise((resolve) => {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--append-system-prompt",
      system,
      // No MCP servers / tools — a pure one-shot text generation.
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      // Isolate from the user's personal config (skills/plugins/hooks) here too.
      ...CLAUDE_ISOLATION_ARGS,
    ];
    // shell:true for a Windows .cmd/.bat shim (EINVAL otherwise); native .exe runs direct.
    execFile(bin, args, { env: agentSpawnEnv(bin), timeout: 90_000, maxBuffer: 8 << 20, shell: needsShell(bin), windowsHide: true }, (err, stdout, stderr) => {
      const out = (stdout || "").trim();
      if (!out) {
        resolve({ error: `claude: ${(stderr || err?.message || "no output").trim().slice(0, 300)}` });
        return;
      }
      try {
        const j = JSON.parse(out) as { result?: unknown; is_error?: boolean; subtype?: string };
        const text = typeof j.result === "string" ? j.result : resultText(j);
        if (j.is_error || j.subtype === "error_during_execution") {
          resolve({ error: (text || "claude returned an error").slice(0, 300) });
          return;
        }
        resolve({ text });
      } catch {
        resolve({ text: out });
      }
    });
  });
}

function runCodexOneShot(bin: string, prompt: string, system: string): Promise<{ text: string } | { error: string }> {
  return new Promise((resolve) => {
    const message = system ? `${system}\n\n${prompt}` : prompt;
    const child = spawnAgent(bin, ["exec", "--json", "--skip-git-repo-check", ...CODEX_ISOLATION_ARGS, message], { env: agentSpawnEnv(bin) });
    child.stdin?.end();
    let buf = "";
    let last = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 90_000);
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          if (e.type === "item.completed" && e.item?.type === "agent_message" && e.item.text) last = e.item.text;
        } catch {
          /* skip non-JSON */
        }
      }
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => { clearTimeout(timer); resolve({ error: `codex: ${e.message}` }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (last) resolve({ text: last });
      else resolve({ error: `codex: ${stderr.split("\n").filter((l) => /error|fatal/i.test(l)).slice(-1)[0] || `exited ${code}`}`.slice(0, 300) });
    });
  });
}

// ── Cursor (cursor-agent) bridge ───────────────────────────────────────────
// Cursor ships a headless CLI — `cursor-agent -p` — that drives the user's Cursor
// subscription (they run `cursor-agent login` once; no keys are stored here, same
// as the claude/codex bridges). Its `--output-format stream-json` emits the SAME
// Anthropic agent-SDK event shape as Claude (assistant/user/result envelopes with
// text / tool_use / tool_result blocks), so the stdout parser mirrors streamClaude.
//
// MCP wiring is the one real difference: cursor-agent has NO inline `--mcp-config`
// / `--strict-mcp-config` flag (unlike claude/codex). It discovers MCP servers from
// `.cursor/mcp.json` in its working directory (plus the user's global
// ~/.cursor/mcp.json). So we spawn it inside an app-owned workspace dir and write
// gtmgrid's server into that dir's `.cursor/mcp.json` before each turn. Caveat: we
// cannot suppress the user's OWN global MCP servers the way claude/codex do — the
// operating-manual preamble steers the agent to gtmgrid's tools instead.

/** App-owned working directory we run `cursor-agent` in, so the gtmgrid MCP config
 *  we drop never touches the user's real projects (or the app bundle). */
const CURSOR_WORKSPACE = join(CONFIG_DIR, "cursor");

/** Absolute path of the cursor MCP config file. */
const CURSOR_MCP_CONFIG = join(CURSOR_WORKSPACE, ".cursor", "mcp.json");

/**
 * Write the gtmgrid MCP server into the cursor workspace's `.cursor/mcp.json` so a
 * `cursor-agent` spawned with cwd={@link CURSOR_WORKSPACE} mounts the grid tools.
 * Reuses {@link mcpConfig} (the same `{ mcpServers: { gtmgrid } }` shape claude
 * gets), so the gtmgrid env carries cloud context / permission mode / approval
 * identically. Returns the workspace dir to use as the spawn cwd.
 *
 * SECURITY: unlike claude/codex — which pass the gtmgrid env (incl. the cloud
 * member bearer `GTMGRID_TOKEN`) on an EPHEMERAL argv — cursor-agent has no inline
 * MCP flag, so the env is written to THIS file on disk. It is therefore created
 * 0600 (owner-only) inside a 0700 dir, and {@link streamCursor} deletes it once the
 * turn's child exits, so the token never lingers world-readable.
 */
export function writeCursorMcpConfig(
  repoRoot: string,
  project: string,
  cloud?: AgentCloud,
  mode?: string,
  approval?: AgentApproval,
): string {
  const dir = join(CURSOR_WORKSPACE, ".cursor");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(CURSOR_MCP_CONFIG, mcpConfig(repoRoot, project, undefined, cloud, mode, approval), { mode: 0o600 });
  // `mode` on writeFileSync only applies on CREATE; force it in case the file
  // already existed (e.g. left 0644 by an older build) so the token is never
  // group/world-readable.
  chmodSync(CURSOR_MCP_CONFIG, 0o600);
  return CURSOR_WORKSPACE;
}

/** Remove the on-disk cursor MCP config (with the cloud token) after a turn. */
function cleanupCursorMcpConfig(): void {
  try {
    unlinkSync(CURSOR_MCP_CONFIG);
  } catch {
    /* already gone / never written — fine */
  }
}

/** Strip the MCP-server prefix cursor puts on a tool name (`mcp_gtmgrid_<tool>` /
 *  `mcp__gtmgrid__<tool>` / `gtmgrid_<tool>`) down to the bare gtmgrid tool name.
 *  Pure; exported for tests. */
export function cursorToolShort(name: string): string {
  return String(name)
    .replace(/^mcp__?gtmgrid__?/i, "")
    .replace(/^gtmgrid[:_]\s*/i, "")
    .trim();
}

/** Stream a Cursor turn over SSE, driving gtmgrid via MCP. */
export function streamCursor(
  res: ServerResponse,
  opts: { message: string; project: string; repoRoot: string; sessionId?: string; newChat?: boolean; context?: AgentContext; origin?: string; model?: string; mode?: string; cloud?: AgentCloud; providerEnv?: Record<string, string>; approval?: AgentApproval },
): void {
  const sse = sseClient(res, opts.origin);
  // cursor-agent has no `--append-system-prompt`; fold the operating manual into the
  // prompt instead (exactly as the codex bridge does). PLAN mode is enforced by the
  // preamble's PLAN_MODE_NOTE — there's no separate CLI plan flag.
  const preamble = contextPreamble(opts.context, opts.mode, !!opts.cloud);
  const message = preamble ? `${preamble}\n\n${opts.message}` : opts.message;

  // `--force` = "allow commands unless explicitly denied" — the bypass posture the
  // claude/codex bridges run with (the gtmgrid MCP gate still enforces the mode via
  // its env). The gtmgrid tool gating is the MCP layer's job, same as the others.
  const args = ["-p", message, "--output-format", "stream-json", "--force"];
  if (opts.model) args.push("--model", opts.model);
  // Resume the user's prior cursor chat for continuity unless they asked for a New
  // chat. The chat id rides back on the stream's `system`/`result` events (captured
  // below) and is what the panel stores + replays here next turn.
  const resumeId = opts.newChat ? null : opts.sessionId ?? null;
  if (resumeId) args.push("--resume", resumeId);

  const bin = resolveAgentPath("cursor");
  if (!bin) {
    sse.write({ type: "error", message: "Cursor not found. Install cursor-agent (cursor.com/cli) and run `cursor-agent login`, or set its path in the panel." });
    sse.write({ type: "end" });
    return sse.end();
  }
  // Mount gtmgrid's MCP server via a config in cursor's cwd (it has no inline flag).
  const cwd = writeCursorMcpConfig(opts.repoRoot, opts.project, opts.cloud, opts.mode, opts.approval);

  // `detached` → own process group, so cleanup can kill the CLI + the gtmgrid MCP
  // server + their subprocesses as one group (TRI-3305). Saved provider keys fill in
  // UNDER process.env so an explicitly exported var still wins.
  const child = spawnAgent(bin, args, { env: { ...opts.providerEnv, ...agentSpawnEnv(bin) }, cwd, detached: true });
  child.stdin?.end(); // prompt is passed via `-p`; close stdin so it doesn't wait on it.

  let sessionId = resumeId ?? null;
  let buf = "";
  let gridDirty = false;
  const stats: AgentTurnStats = { startedAt: Date.now(), toolCalls: 0 };
  const lifecycle = manageChildLifecycle(child, {
    onTimeout: (reason) => {
      sse.write({ type: "error", message: turnTimeoutMessage("cursor", reason) });
      sse.write({ type: "end", sessionId });
      sse.end();
    },
  });

  child.stdout.on("data", (chunk) => {
    lifecycle.touch(); // the child is alive and streaming — defer the idle timeout
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      // Capture cursor's chat id as soon as it appears (the `system` init carries it)
      // so the panel can resume THIS chat next turn; refreshed from `result` below.
      if (typeof e.session_id === "string" && e.session_id && e.session_id !== sessionId) {
        sessionId = e.session_id;
        sse.write({ type: "session", sessionId });
      }
      if (e.type === "assistant") {
        for (const block of e.message?.content ?? []) {
          if (block.type === "text" && block.text) sse.write({ type: "text", text: block.text });
          else if (block.type === "tool_use") {
            stats.toolCalls++;
            const short = cursorToolShort(block.name);
            sse.write({ type: "tool", name: short, raw: block.name, input: block.input ?? {} });
            // Only a gtmgrid MUTATING tool dirties the grid — mirror claude's
            // prefix guard so a coincidentally-named non-gtmgrid tool can't force
            // a spurious refetch. cursor prefixes gtmgrid tools `mcp_gtmgrid_` /
            // `mcp__gtmgrid__` / `gtmgrid_`.
            const isGtmgridTool = /^(mcp__?gtmgrid__?|gtmgrid[:_])/i.test(String(block.name));
            if (isGtmgridTool && MUTATING.has(short)) gridDirty = true;
          }
        }
      } else if (e.type === "user") {
        // Tool results come back as a user message with tool_result blocks.
        for (const block of e.message?.content ?? []) {
          if (block.type === "tool_result") {
            const text = Array.isArray(block.content)
              ? block.content.map((c: any) => (c?.type === "text" ? c.text : "")).join("")
              : typeof block.content === "string"
                ? block.content
                : "";
            if (text) sse.write({ type: "tool_result", result: text.slice(0, 600) });
            const pe = text ? permissionEventFromToolResult(text) : null;
            if (pe) sse.write(pe);
            const qe = text ? questionEventFromToolResult(text) : null;
            if (qe) sse.write(qe);
          }
        }
      } else if (e.type === "result") {
        if (e.session_id) sessionId = e.session_id;
        sse.write({ type: "done", result: e.result ?? "", sessionId, isError: e.is_error ?? e.subtype !== "success" });
      }
      // Nudge the UI to refetch as soon as a mutating tool runs (not just at the end).
      if (gridDirty) {
        sse.write({ type: "grid" });
        gridDirty = false;
      }
    }
  });

  let stderr = "";
  child.stderr.on("data", (d) => {
    lifecycle.touch(); // stderr output is also a sign of life — only TRUE silence (no stdout AND no stderr) is "idle"
    stderr = appendCapped(stderr, d.toString());
  });

  child.on("error", (err) => {
    lifecycle.dispose();
    cleanupCursorMcpConfig();
    sse.write({ type: "error", message: `Failed to launch cursor-agent: ${err.message}` });
    sse.end();
  });
  child.on("close", (code) => {
    captureAgentTurn("cursor", opts, stats, code, cwd);
    cleanupCursorMcpConfig(); // remove the on-disk token now the child has exited
    if (code !== 0 && code !== null) {
      sse.write({ type: "error", message: stderr.slice(-400) || `cursor-agent exited ${code}` });
    }
    sse.write({ type: "end", sessionId });
    sse.end();
  });

  // Panel unmount / Stop / new send closes the response → kill the whole group.
  res.on("close", () => lifecycle.terminate());
}
