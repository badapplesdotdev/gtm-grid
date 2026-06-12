// Agent bridge — spawns the user's already-authenticated `claude` / `codex` CLI
// in headless streaming mode, wired to gtmgrid's MCP server for the active
// project, and forwards text / tool-call / grid-changed events as SSE.
// This is the Revcode "connect your Claude Code / Codex" mechanism: no OAuth,
// no key storage — the app drives the CLI the user already logged into.

import { spawn, execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import type { ServerResponse } from "node:http";
import { join, dirname } from "node:path";
import { corsHeadersFor } from "./cors.js";
import { latestSessionId } from "./agent-history.js";

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
  "get_table",
  "run_function",
  "upload_extension",
];
const MUTATING = new Set([
  "create_table", "rename_table", "delete_table",
  "add_column", "update_column", "delete_column",
  "add_rows", "update_cells", "delete_rows",
  "set_dedupe", "run_column", "upload_extension",
]);

export interface AgentContext {
  tableName?: string;
  columns?: string[];
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
export function contextPreamble(ctx?: AgentContext): string {
  const base = `# GTM Grid — operating manual

You are operating **GTM Grid**, a Clay-style local spreadsheet where every column is a function. Tables live in a local SQLite project. The user runs you to build GTM pipelines: source prospects, enrich them, score/personalize, push to outreach tools.

## Core model
- **Tables** = sheets. **Rows** = records. **Columns** = either MANUAL (user types values) or FUNCTION (runs an enrichment / AI / HTTP call per row).
- A function column is wired to one connector method: \`provider.method\` (e.g. \`trigify.enrichProfile\`, \`leadmagic.emailFinder\`, \`ai.generate\`, \`formatting.normalizeDomain\`).
- A function column's params can reference OTHER columns via \`{{Column Name}}\` templates — that's how data flows row-by-row. Example: an Email column with \`fn: 'leadmagic.emailFinder'\` and \`params: { first_name: "{{First Name}}", last_name: "{{Last Name}}", domain: "{{Domain}}" }\`.
- "Code" columns run a sandboxed JS body (\`function(inputs, sdk){ ... }\`) for custom transforms or to call \`sdk.<provider>.<method>(...)\` directly.

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
- When you see errors in \`get_table\` output:
  - **401/403** → the connector's API key is missing or invalid. Tell the user to connect it in the Extensions panel; do NOT silently retry.
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

  if (!ctx?.tableName) return base;
  const cols = ctx.columns?.length ? ` Its columns are: ${ctx.columns.join(", ")}.` : "";
  return (
    base +
    `\n\n## Active table\nThe user is viewing **"${ctx.tableName}"**.${cols} When they say "this table" or don't name one, operate on this one.`
  );
}

export type AgentKind = "claude" | "codex" | "hermes";

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
  const dirs = ["/opt/homebrew/bin", "/usr/local/bin", join(home, ".local/bin"), join(home, ".npm-global/bin"), join(home, "Library/pnpm")];
  const nvm = join(home, ".nvm/versions/node");
  try {
    for (const v of readdirSync(nvm)) dirs.push(join(nvm, v, "bin"));
  } catch {
    /* no nvm */
  }
  return dirs;
}

/** Resolve a CLI's absolute path (override → login shell → common dirs). */
export function resolveAgentPath(kind: AgentKind): string | null {
  if (resolveCache[kind] !== undefined) return resolveCache[kind]!;
  let found: string | null = null;
  const override = loadOverrides()[kind];
  if (override && existsSync(override)) {
    found = override;
  } else {
    // interactive login shell (matches the user's terminal)
    const shell = process.env.SHELL || "/bin/zsh";
    try {
      const out = execFileSync(shell, ["-lic", `command -v ${kind} 2>/dev/null`], {
        encoding: "utf8",
        timeout: 6000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const p = out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("/") && existsSync(l))[0];
      if (p) found = p;
    } catch {
      /* fall through to scan */
    }
    if (!found) {
      for (const dir of candidateDirs()) {
        const p = join(dir, kind);
        if (existsSync(p)) {
          found = p;
          break;
        }
      }
    }
  }
  resolveCache[kind] = found;
  return found;
}

/** Environment for spawning an agent: PATH includes the binary's dir (so its
 *  sibling `node` is found) plus the user's login PATH. */
function agentSpawnEnv(binPath: string): NodeJS.ProcessEnv {
  const parts = [dirname(binPath), loginPath(), process.env.PATH ?? ""].filter(Boolean);
  return { ...process.env, PATH: parts.join(":") };
}

function versionOf(kind: AgentKind): { installed: boolean; version: string | null; path: string | null } {
  const path = resolveAgentPath(kind);
  if (!path) return { installed: false, version: null, path: null };
  try {
    // First line only — `hermes --version` prints a multi-line report; claude/codex are single-line.
    const v = execFileSync(path, ["--version"], { encoding: "utf8", timeout: 5000, env: agentSpawnEnv(path) }).split("\n")[0].trim();
    return { installed: true, version: v || null, path };
  } catch {
    return { installed: false, version: null, path };
  }
}

export function detectAgents() {
  return { claude: versionOf("claude"), codex: versionOf("codex"), hermes: versionOf("hermes") };
}

/** Clear caches so the next detect re-resolves (after install / manual connect). */
export function rescanAgents(): void {
  resolveCache.claude = undefined;
  resolveCache.codex = undefined;
  resolveCache.hermes = undefined;
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
/** Hard ceiling on a single turn; a hung agent is terminated and surfaced. */
export const MAX_RUN_MS = 5 * 60_000;
/** Keep only the last ~32KB of stderr so a chatty/looping child can't grow the heap. */
export const STDERR_CAP = 32 * 1024;

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
 * Wire group-kill cleanup + a max-run timeout to a detached child. Returns a
 * `terminate()` to invoke on `res.on("close")` (panel unmount / Stop / new send)
 * and a `dispose()` the `child.on("close")` handler calls so timers are cleared.
 *
 * Guarantees (the regression-test contract):
 *  - `terminate()` signals the whole GROUP: `kill(-pid, "SIGTERM")`, then
 *    `kill(-pid, "SIGKILL")` after {@link KILL_GRACE_MS} if the child hasn't closed.
 *  - Once the child closes, `exited` is set and the escalation timer is cleared —
 *    so NO signal is ever sent after exit (avoids killing a recycled pid).
 *  - The max-run timeout terminates the group and invokes `onTimeout` (to emit an
 *    SSE error+end) exactly once.
 *  - Every `kill` is wrapped so an already-dead group (`ESRCH`) is a no-op.
 */
export function manageChildLifecycle(
  child: ManagedChild,
  opts: { onTimeout: () => void; control?: ProcessControl; graceMs?: number; maxRunMs?: number },
): { terminate: () => void; dispose: () => void } {
  const ctrl = opts.control ?? defaultProcessControl;
  const graceMs = opts.graceMs ?? KILL_GRACE_MS;
  const maxRunMs = opts.maxRunMs ?? MAX_RUN_MS;

  let exited = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let runTimer: ReturnType<typeof setTimeout> | null = ctrl.setTimeout(() => {
    runTimer = null;
    terminate();
    opts.onTimeout();
  }, maxRunMs);

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

  function dispose(): void {
    exited = true;
    if (killTimer !== null) {
      ctrl.clearTimeout(killTimer);
      killTimer = null;
    }
    if (runTimer !== null) {
      ctrl.clearTimeout(runTimer);
      runTimer = null;
    }
  }

  child.on("close", dispose);
  return { terminate, dispose };
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

/** Path to the gtmgrid MCP launcher — bundled in the packaged app, repo/bin in dev. */
export function mcpLauncher(repoRoot: string): string {
  return process.env.GTMGRID_MCP_LAUNCHER ?? join(repoRoot, "bin", "gtmgrid-mcp");
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
  readonly tableId: string;
}

/**
 * Validate the `cloud` block of an `/api/agent/chat` body into an
 * {@link AgentCloud}, or `undefined` when it is absent/incomplete. A cloud
 * context requires EVERY field (apiUrl/token/workspaceId/projectId/tableId) to
 * be a non-empty string; any missing/blank field falls back to local mode (so a
 * half-populated block never half-activates cloud routing). Trims each value.
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
  const tableId = read("tableId");
  if (
    apiUrl === undefined ||
    token === undefined ||
    workspaceId === undefined ||
    projectId === undefined ||
    tableId === undefined
  ) {
    return undefined;
  }
  return { apiUrl, token, workspaceId, projectId, tableId };
}

/**
 * The env the MCP server is spawned with. LOCAL: only `GTMGRID_PROJECT`
 * (byte-identical to before). CLOUD: `GTMGRID_MODE=cloud` plus the threaded
 * apiUrl/token/workspace/project/table so `selectGridEnv` in the MCP resolves a
 * cloud data source. The token rides the ENV, not the config string, so it
 * never appears in a logged command line.
 */
export function mcpEnv(project: string, cloud?: AgentCloud): Record<string, string> {
  // The sidecar's own HTTP port — lets the MCP delegate a large run to the
  // PERSISTENT server (which outlives the 5-min agent turn) instead of blocking.
  const port = process.env.GTMGRID_PORT ?? "8787";
  if (!cloud) return { GTMGRID_PROJECT: project, GTMGRID_PORT: port };
  return {
    GTMGRID_PROJECT: project,
    GTMGRID_PORT: port,
    GTMGRID_MODE: "cloud",
    GTMGRID_API_URL: cloud.apiUrl,
    GTMGRID_TOKEN: cloud.token,
    GTMGRID_WORKSPACE_ID: cloud.workspaceId,
    GTMGRID_CLOUD_PROJECT: cloud.projectId,
    GTMGRID_CLOUD_TABLE: cloud.tableId,
  };
}

/**
 * Build the MCP config for claude. The gtmgrid server's env is resolved via
 * {@link mcpEnv} so it carries the cloud context (TRI-3296) when `cloud` is set;
 * `extra` merges in additional servers (e.g. Hermes-as-a-tool when enabled).
 * Exported for tests.
 */
export function mcpConfig(
  repoRoot: string,
  project: string,
  extra?: Record<string, ExtraMcpServer>,
  cloud?: AgentCloud,
): string {
  return JSON.stringify({
    mcpServers: {
      gtmgrid: { command: mcpLauncher(repoRoot), env: mcpEnv(project, cloud) },
      ...extra,
    },
  });
}

/** Stream a Claude Code turn over SSE, driving gtmgrid via MCP. */
export function streamClaude(
  res: ServerResponse,
  opts: { message: string; project: string; repoRoot: string; sessionId?: string; newChat?: boolean; context?: AgentContext; origin?: string; model?: string; cloud?: AgentCloud; providerEnv?: Record<string, string> },
): void {
  const sse = sseClient(res, opts.origin);
  // Optionally also expose the user's Hermes agent as an MCP tool (off unless
  // `hermesAsTool` is set in ~/.gtmgrid/agents.json) so Claude can delegate to it.
  const hermesTool = hermesToolServer();
  const args = [
    "-p",
    opts.message,
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    mcpConfig(opts.repoRoot, opts.project, hermesTool ? { hermes: hermesTool } : undefined, opts.cloud),
    // Use ONLY gtmgrid's MCP server (+ Hermes when enabled) — ignore the user's
    // other Claude Code MCP servers (Trigify/Clay/etc.) so the agent drives
    // gtmgrid's own tools instead of reaching for an external MCP (auth walls).
    // The gtmgrid server's env carries cloud context (TRI-3296) when in cloud mode.
    "--strict-mcp-config",
    "--allowedTools",
    ...GTM_TOOLS.map((t) => `mcp__gtmgrid__${t}`),
    ...(hermesTool ? ["mcp__hermes"] : []),
  ];
  const preamble = contextPreamble(opts.context);
  if (preamble) args.push("--append-system-prompt", preamble);
  if (opts.model) args.push("--model", opts.model);
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
  const child = spawn(bin, args, { env: { ...opts.providerEnv, ...agentSpawnEnv(bin) }, cwd: opts.repoRoot, detached: true });
  child.stdin?.end(); // we pass the prompt via `-p`; close stdin so claude doesn't wait on it (the "no stdin data in 3s" warning)
  let sessionId = resumeId ?? null;
  let buf = "";
  let gridDirty = false;
  const lifecycle = manageChildLifecycle(child, {
    onTimeout: () => {
      sse.write({ type: "error", message: `claude turn exceeded ${Math.round(MAX_RUN_MS / 1000)}s and was terminated` });
      sse.write({ type: "end", sessionId });
      sse.end();
    },
  });

  child.stdout.on("data", (chunk) => {
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

      if (e.type === "assistant") {
        for (const block of e.message?.content ?? []) {
          if (block.type === "text" && block.text) sse.write({ type: "text", text: block.text });
          else if (block.type === "tool_use") {
            const short = String(block.name).replace(/^mcp__gtmgrid__/, "");
            sse.write({ type: "tool", name: short, raw: block.name, input: block.input ?? {} });
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
  child.stderr.on("data", (d) => (stderr = appendCapped(stderr, d.toString())));

  child.on("error", (err) => {
    lifecycle.dispose();
    sse.write({ type: "error", message: `Failed to launch claude: ${err.message}` });
    sse.end();
  });
  child.on("close", (code) => {
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
export function codexEnvToml(env: Record<string, string>): string {
  const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const entries = Object.entries(env).map(([k, v]) => `${k} = "${esc(v)}"`);
  return `{ ${entries.join(", ")} }`;
}

export function streamCodex(
  res: ServerResponse,
  opts: { message: string; project: string; repoRoot: string; threadId?: string; newChat?: boolean; context?: AgentContext; origin?: string; model?: string; cloud?: AgentCloud; providerEnv?: Record<string, string> },
): void {
  const sse = sseClient(res, opts.origin);
  const launcher = mcpLauncher(opts.repoRoot);
  const preamble = contextPreamble(opts.context);
  const message = preamble ? `${preamble}\n\n${opts.message}` : opts.message;
  // Optionally also expose the user's Hermes agent as an MCP tool (off unless
  // `hermesAsTool` is set in ~/.gtmgrid/agents.json).
  const hermesTool = hermesToolServer();
  const hermesToml = hermesTool
    ? `, hermes = { command = "${hermesTool.command}", args = [${(hermesTool.args ?? []).map((a) => `"${a}"`).join(", ")}] }`
    : "";
  const flags = [
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    // Replace Codex's whole MCP table with ONLY gtmgrid (+ Hermes when enabled),
    // so it ignores the user's other registered servers (Trigify/exa/etc.) and
    // drives gtmgrid. The gtmgrid env (incl. cloud context in cloud mode) is
    // rendered as TOML with every value safely quoted — see `codexEnvToml`.
    "-c",
    `mcp_servers={ gtmgrid = { command = "${launcher}", env = ${codexEnvToml(mcpEnv(opts.project, opts.cloud))} }${hermesToml} }`,
    ...(opts.model ? ["-m", opts.model] : []),
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
  const child = spawn(bin, args, { env: { ...opts.providerEnv, ...agentSpawnEnv(bin) }, cwd: opts.repoRoot, detached: true });
  child.stdin?.end(); // codex exec otherwise waits on stdin

  let threadId = resumeThread ?? null;
  let buf = "";
  const lifecycle = manageChildLifecycle(child, {
    onTimeout: () => {
      sse.write({ type: "error", message: `codex turn exceeded ${Math.round(MAX_RUN_MS / 1000)}s and was terminated` });
      sse.write({ type: "end", sessionId: threadId });
      sse.end();
    },
  });
  child.stdout.on("data", (chunk) => {
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
          const short = String(item.tool ?? "");
          sse.write({ type: "tool", name: short, raw: `mcp__${item.server}__${short}`, input: item.arguments ?? {} });
          if (!item.error && item.result) sse.write({ type: "tool_result", name: short, result: resultText(item.result).slice(0, 600) });
          if (MUTATING.has(short)) sse.write({ type: "grid" });
        } else if (item.type === "agent_message" && item.text) {
          sse.write({ type: "text", text: item.text });
        }
      }
    }
  });

  let stderr = "";
  child.stderr.on("data", (d) => (stderr = appendCapped(stderr, d.toString())));
  child.on("error", (err) => {
    lifecycle.dispose();
    sse.write({ type: "error", message: `Failed to launch codex: ${err.message}` });
    sse.end();
  });
  child.on("close", (code) => {
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
    ];
    execFile(bin, args, { env: agentSpawnEnv(bin), timeout: 90_000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
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
    const child = spawn(bin, ["exec", "--json", "--skip-git-repo-check", message], { env: agentSpawnEnv(bin) });
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

// ── Hermes (ACP) bridge ────────────────────────────────────────────────────
// Hermes speaks the Agent Client Protocol — JSON-RPC 2.0 over stdio with
// newline-delimited framing. We `hermes acp`, `initialize`, open a session with
// the gtmgrid MCP server mounted INLINE (so the agent drives the same grid tools
// claude/codex get), then `session/prompt`. The agent's `session/update`
// notifications (assistant text, tool_call / tool_call_update) map onto the
// exact SSE shape the panel already renders. Runs the local `hermes` binary.

interface AgentsConfig {
  claude?: string;
  codex?: string;
  hermes?: string;
  /** When set, also expose Hermes (`hermes mcp serve`) as a tool to claude/codex. */
  hermesAsTool?: boolean;
}

function loadAgentsConfig(): AgentsConfig {
  try {
    return JSON.parse(readFileSync(AGENTS_CONFIG, "utf8"));
  } catch {
    return {};
  }
}

type AcpMcpServer = { name: string; command: string; args: string[]; env: { name: string; value: string }[] };
export interface HermesTransport {
  argv: string[];
  gtmgridMcp: AcpMcpServer;
  label: string;
}

/** Resolve how to launch the local Hermes (ACP) and how its session reaches the
 *  gtmgrid MCP server. Returns null if there's no local `hermes` binary. */
function resolveHermesTransport(repoRoot: string, project: string): HermesTransport | null {
  const bin = resolveAgentPath("hermes");
  if (!bin) return null;
  return {
    argv: [bin, "acp"],
    gtmgridMcp: { name: "gtmgrid", command: mcpLauncher(repoRoot), args: [], env: [{ name: "GTMGRID_PROJECT", value: project }] },
    label: "local",
  };
}

/** When `hermesAsTool` is set, expose the local Hermes agent as an MCP server
 *  (`hermes mcp serve`) to the claude/codex grid agent. */
function hermesToolServer(): ExtraMcpServer | null {
  const cfg = loadAgentsConfig();
  if (!cfg.hermesAsTool) return null;
  const bin = resolveAgentPath("hermes") || "hermes";
  return { command: bin, args: ["mcp", "serve"] };
}

function acpToolName(u: Record<string, any>): string {
  const t = String(u?.title ?? u?.kind ?? "tool").trim();
  // Hermes titles MCP tools "mcp_<server>_<tool>" (and sometimes "gtmgrid: <tool>").
  return t.replace(/^mcp_[a-z0-9-]+_/i, "").replace(/^gtmgrid[:_\s]*/i, "").trim() || "tool";
}
function acpToolResultText(u: Record<string, any>): string {
  if (typeof u?.rawOutput === "string" && u.rawOutput) return u.rawOutput.slice(0, 600);
  const blocks = Array.isArray(u?.content) ? u.content : [];
  const txt = blocks
    .map((b: any) => (typeof b?.content?.text === "string" ? b.content.text : typeof b?.text === "string" ? b.text : ""))
    .join("");
  return String(txt).slice(0, 600);
}

/** Map one ACP `session/update` payload onto SSE events. Pure; exported for tests. */
export function mapAcpUpdate(update: Record<string, any> | undefined | null): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  switch (update?.sessionUpdate) {
    case "agent_message_chunk": {
      const text = update?.content?.text;
      if (typeof text === "string" && text) out.push({ type: "text", text });
      break;
    }
    case "tool_call":
      out.push({ type: "tool", name: acpToolName(update), raw: update?.toolCallId, input: update?.rawInput ?? {} });
      break;
    case "tool_call_update":
      if (update?.status === "completed" || update?.status === "failed") {
        out.push({ type: "tool_result", result: acpToolResultText(update) });
        out.push({ type: "grid" }); // a tool finished — nudge the UI to refetch
      }
      break;
    // available_commands_update / usage_update / plan / current_mode_update: ignored.
  }
  return out;
}

/** Choose a permission option that allows the action (headless auto-run, mirrors
 *  the bypass posture of the claude/codex bridges). */
export function pickAllowOption(options: unknown): string | null {
  if (!Array.isArray(options)) return null;
  const byKind = (k: string) => options.find((o: any) => o?.kind === k)?.optionId;
  return (
    byKind("allow_once") ??
    byKind("allow_always") ??
    options.find((o: any) => /allow/i.test(String(o?.optionId ?? o?.kind ?? "")))?.optionId ??
    null
  );
}

/** Minimal child surface the Hermes bridge drives (so tests can inject a fake).
 *  A superset of {@link ManagedChild} that also exposes the stdio the JSON-RPC
 *  client reads/writes. */
export interface HermesChild extends ManagedChild {
  stdin: { write(chunk: string): unknown } | null;
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

/** Injectable spawn seam for the Hermes child — defaults to a detached `spawn`
 *  so the bridge can group-kill the CLI + its MCP/grandchildren (TRI-3305). */
export type SpawnHermes = (cmd: string, args: string[], cwd: string) => HermesChild;

const defaultSpawnHermes: SpawnHermes = (cmd, args, cwd) =>
  // `detached` → own process group, so cleanup can kill the CLI + the gtmgrid
  // MCP server + their subprocesses as one group, not just the hermes parent.
  // The real `ChildProcess` structurally satisfies HermesChild (pid + stdio + on).
  spawn(cmd, args, { env: agentSpawnEnv(cmd), cwd, detached: true });

/** Stream a Hermes turn over SSE via the Agent Client Protocol. */
export function streamHermes(
  res: ServerResponse,
  opts: { message: string; project: string; repoRoot: string; sessionId?: string; context?: AgentContext; origin?: string; model?: string },
  deps: {
    spawn?: SpawnHermes;
    control?: ProcessControl;
    resolveTransport?: (repoRoot: string, project: string) => HermesTransport | null;
  } = {},
): void {
  const sse = sseClient(res, opts.origin);
  const transport = (deps.resolveTransport ?? resolveHermesTransport)(opts.repoRoot, opts.project);
  if (!transport) {
    sse.write({
      type: "error",
      message:
        "Hermes not found. Install the `hermes` binary, or set its path in the panel.",
    });
    sse.write({ type: "end" });
    return sse.end();
  }

  const [cmd, ...args] = transport.argv;
  const child = (deps.spawn ?? defaultSpawnHermes)(cmd, args, opts.repoRoot);

  let sessionId = opts.sessionId ?? null;
  // Suppress `session/update` events until our prompt is in flight — this drops
  // setup notifications AND the history replay that session/load streams back.
  let forwarding = false;
  // The async driver and the timeout both finish the SSE stream — guard so only
  // the first one writes the terminal `end` and ends the response.
  let ended = false;
  const finish = (): void => {
    if (ended) return;
    ended = true;
    sse.write({ type: "end", sessionId });
    sse.end();
  };

  // Group-kill cleanup + max-run ceiling, mirroring the claude/codex bridges.
  // `terminate()` signals the whole process group (negative pid: SIGTERM→SIGKILL);
  // `dispose()` (on child close/error) clears the timers so no signal lands after exit.
  const lifecycle = manageChildLifecycle(child, {
    control: deps.control,
    onTimeout: () => {
      sse.write({ type: "error", message: `hermes turn exceeded ${Math.round(MAX_RUN_MS / 1000)}s and was terminated` });
      finish();
    },
  });

  // ── Minimal JSON-RPC 2.0 client over the child's stdio (NDJSON) ──
  let nextId = 1;
  const pending = new Map<number, (msg: any) => void>();
  const sendRaw = (obj: unknown) => child.stdin?.write(JSON.stringify(obj) + "\n");
  const request = (method: string, params: unknown) =>
    new Promise<any>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      sendRaw({ jsonrpc: "2.0", id, method, params });
    });
  const respond = (id: number, result: unknown) => sendRaw({ jsonrpc: "2.0", id, result });
  const respondError = (id: number, message: string) => sendRaw({ jsonrpc: "2.0", id, error: { code: -32601, message } });
  const failAllPending = (message: string) => {
    for (const [, resolve] of pending) resolve({ error: { message } });
    pending.clear();
  };

  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      // Response to one of our requests (has id + result/error, no method).
      if (m.id !== undefined && m.method === undefined && pending.has(m.id)) {
        pending.get(m.id)!(m);
        pending.delete(m.id);
        continue;
      }
      // Agent → client request. Auto-allow permission; reject anything else so
      // Hermes never hangs waiting on us.
      if (m.method && m.id !== undefined) {
        if (m.method === "session/request_permission") {
          const optId = pickAllowOption(m.params?.options);
          respond(m.id, { outcome: optId ? { outcome: "selected", optionId: optId } : { outcome: "cancelled" } });
        } else {
          respondError(m.id, `unsupported: ${m.method}`);
        }
        continue;
      }
      // Notifications.
      if (m.method === "session/update" && forwarding) {
        for (const ev of mapAcpUpdate(m.params?.update)) sse.write(ev);
      }
    }
  });

  let stderr = "";
  child.stderr.on("data", (d) => (stderr = appendCapped(stderr, d.toString())));
  child.on("error", (err) => {
    lifecycle.dispose();
    failAllPending(`failed to launch hermes (${transport.label}): ${err.message}`);
  });
  child.on("close", () => failAllPending("hermes exited"));

  (async () => {
    try {
      const init = await request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      if (init?.error) throw new Error(init.error.message ?? "initialize failed");

      const mcpServers = [transport.gtmgridMcp];
      // Resume the prior session when we have one (re-registering gtmgrid); fall
      // back to a fresh session if it's unknown/expired.
      let sess: any = null;
      if (sessionId) {
        sess = await request("session/load", { sessionId, cwd: opts.repoRoot, mcpServers });
        if (sess?.error) sess = null;
      }
      if (!sess) sess = await request("session/new", { cwd: opts.repoRoot, mcpServers });
      if (sess?.error) throw new Error(sess.error.message ?? "session failed");
      sessionId = sess.result?.sessionId ?? sessionId;
      if (sessionId) sse.write({ type: "session", sessionId });

      // Best-effort model switch (panel passes an ACP modelId); keep default on failure.
      if (opts.model) await request("session/set_model", { sessionId, modelId: opts.model });

      const preamble = contextPreamble(opts.context);
      const text = preamble ? `${preamble}\n\n${opts.message}` : opts.message;
      forwarding = true;
      const result = await request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
      const stop = result?.result?.stopReason;
      const isError = !!result?.error || (typeof stop === "string" && stop !== "end_turn");
      if (result?.error) sse.write({ type: "error", message: result.error.message ?? "prompt failed" });
      sse.write({ type: "done", result: "", sessionId, isError });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      sse.write({ type: "error", message: detail + (stderr ? ` — ${stderr.slice(-300)}` : "") });
    } finally {
      finish();
      // Turn done (or failed) → tear down the whole group, not just the parent.
      lifecycle.terminate();
    }
  })();

  // Panel unmount / Stop / new send closes the response → kill the whole group.
  res.on("close", () => lifecycle.terminate());
}
