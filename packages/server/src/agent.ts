// Agent bridge — spawns the user's already-authenticated `claude` / `codex` CLI
// in headless streaming mode, wired to gtmgrid's MCP server for the active
// project, and forwards text / tool-call / grid-changed events as SSE.
// This is the Revcode "connect your Claude Code / Codex" mechanism: no OAuth,
// no key storage — the app drives the CLI the user already logged into.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import type { ServerResponse } from "node:http";
import { join, dirname } from "node:path";
import { corsHeadersFor } from "./cors.js";

const GTM_TOOLS = [
  "list_functions",
  "list_tables",
  "create_table",
  "add_column",
  "add_rows",
  "run_column",
  "get_table",
  "run_function",
  "upload_extension",
];
const MUTATING = new Set(["create_table", "add_column", "add_rows", "run_column", "upload_extension"]);

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
function contextPreamble(ctx?: AgentContext): string {
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
- **Enrich rows**: add a function column wired to an enrichment method (e.g. \`trigify.enrichProfile\` with \`params: { profileUrl: "{{LinkedIn URL}}" }\`), then \`run_column\` to fill it for all rows.
- **Personalize**: \`ai.generate\` columns with a prompt referencing other columns — e.g. prompt \`"Write a 2-sentence intro for {{First Name}} who works at {{Company}}"\`. Pass the model + system as params.
- **Format/Normalize**: the \`formatting\` connector has 12 free helpers — normalizeDomain, normalizePhoneNumber, splitFullName, formatDate, titleCase, etc. Use these BEFORE enrichment to clean inputs.
- **Promote JSON fields**: when an enrichment returns a JSON object, do NOT leave it raw. Add code columns to extract the useful fields. Example: \`add_column code="function(i){ var v=JSON.parse(i.src); return v.data && v.data.email; }" params={ src: "{{Enriched Profile}}" }\`.

## Working the table (operational best practices)

### Before you build
- **Read first, write second.** Call \`get_table\` to see what columns + rows already exist before adding new columns or running anything. Don't recreate what's there. Don't assume column names — they're case-sensitive in \`{{templates}}\`.
- **Plan the pipeline left-to-right.** Inputs on the left (LinkedIn URL, Email, Domain…), enrichments next, derived/formatted in the middle, AI personalization toward the right. Don't add a column whose params reference something that doesn't exist yet.
- **Pick clean, human-readable column names.** "Email" not "email_address_v2", "First Name" not "fname". These names ARE the API the user types into \`{{First Name}}\` later.

### Iterating safely (do NOT bulk-run cold)
- **Test on 1 row first.** When adding a new function column, after \`add_column\` add ONE row via \`add_rows\` and call \`run_column\` on it. Inspect the result with \`get_table\`. Only after it looks right do you bulk-run.
- **For sourcing**: when calling \`run_function\` to discover prospects, START SMALL — \`page_size: 10\`, \`max_results: 25\`. Show the user the sample, ask if it's the right cohort, then go wider.
- **Credits awareness.** Most paid connectors charge 1 credit per row. Before \`run_column\` on a column where \`credits > 0\` with more than ~25 rows, state the expected cost (\`rows × credits\`) and confirm. Free helpers (the \`formatting\` connector, \`ai.generate\` on a user-supplied key) don't need confirmation.

### Run controls (what the UI gives the user)
- The grid has **Auto-run**: when ON, editing/adding a manual cell that a function column depends on auto-recomputes the dependent cells. Don't fight it — when Auto-run is on, just \`add_rows\` and the function columns fill themselves.
- Users can run a **single cell** (hover, click ▶) or a **whole column** (the per-column run button in the header) or **everything** (Run all in the toolbar). \`run_column\` from your side is equivalent to clicking the column run button.
- Runs are **idempotent**: \`run_column\` skips cells already \`done\` unless you pass \`force: true\`. Re-running after a transient error is safe.

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

export type AgentKind = "claude" | "codex";

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
    const v = execFileSync(path, ["--version"], { encoding: "utf8", timeout: 5000, env: agentSpawnEnv(path) }).trim();
    return { installed: true, version: v || null, path };
  } catch {
    return { installed: false, version: null, path };
  }
}

export function detectAgents() {
  return { claude: versionOf("claude"), codex: versionOf("codex") };
}

/** Clear caches so the next detect re-resolves (after install / manual connect). */
export function rescanAgents(): void {
  resolveCache.claude = undefined;
  resolveCache.codex = undefined;
  cachedLoginPath = undefined;
}

interface SseClient {
  write: (event: Record<string, unknown>) => void;
  end: () => void;
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
function mcpLauncher(repoRoot: string): string {
  return process.env.GTMGRID_MCP_LAUNCHER ?? join(repoRoot, "bin", "gtmgrid-mcp");
}

function mcpConfig(repoRoot: string, project: string): string {
  return JSON.stringify({
    mcpServers: {
      gtmgrid: { command: mcpLauncher(repoRoot), env: { GTMGRID_PROJECT: project } },
    },
  });
}

/** Stream a Claude Code turn over SSE, driving gtmgrid via MCP. */
export function streamClaude(
  res: ServerResponse,
  opts: { message: string; project: string; repoRoot: string; sessionId?: string; context?: AgentContext; origin?: string; model?: string },
): void {
  const sse = sseClient(res, opts.origin);
  const args = [
    "-p",
    opts.message,
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    mcpConfig(opts.repoRoot, opts.project),
    // Use ONLY gtmgrid's MCP server — ignore the user's other Claude Code MCP
    // servers (Trigify/Clay/etc.) so the agent drives gtmgrid's own tools and
    // connectors instead of reaching for an external MCP (and hitting auth walls).
    "--strict-mcp-config",
    "--allowedTools",
    ...GTM_TOOLS.map((t) => `mcp__gtmgrid__${t}`),
  ];
  const preamble = contextPreamble(opts.context);
  if (preamble) args.push("--append-system-prompt", preamble);
  if (opts.model) args.push("--model", opts.model);
  if (opts.sessionId) args.push("--resume", opts.sessionId);

  const bin = resolveAgentPath("claude");
  if (!bin) {
    sse.write({ type: "error", message: "Claude Code not found. Connect it in the panel or install @anthropic-ai/claude-code." });
    sse.write({ type: "end" });
    return sse.end();
  }
  const child = spawn(bin, args, { env: agentSpawnEnv(bin), cwd: opts.repoRoot });
  let sessionId = opts.sessionId ?? null;
  let buf = "";
  let gridDirty = false;

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
      if (e.session_id) sessionId = e.session_id;

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
  child.stderr.on("data", (d) => (stderr += d.toString()));

  child.on("error", (err) => {
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

  res.on("close", () => child.kill());
}

function resultText(result: any): string {
  const content = result?.content;
  if (Array.isArray(content)) return content.map((c: any) => (c?.type === "text" ? c.text : "")).join("");
  return typeof result === "string" ? result : JSON.stringify(result ?? "");
}

/** Stream a Codex turn over SSE. Wires gtmgrid's MCP server per-exec (dynamic
 *  project) and bypasses approval prompts for headless tool use. */
export function streamCodex(
  res: ServerResponse,
  opts: { message: string; project: string; repoRoot: string; threadId?: string; context?: AgentContext; origin?: string; model?: string },
): void {
  const sse = sseClient(res, opts.origin);
  const launcher = mcpLauncher(opts.repoRoot);
  const preamble = contextPreamble(opts.context);
  const message = preamble ? `${preamble}\n\n${opts.message}` : opts.message;
  const flags = [
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    // Replace Codex's whole MCP table with ONLY gtmgrid, so it ignores the
    // user's other registered servers (Trigify/exa/etc.) and drives gtmgrid.
    "-c",
    `mcp_servers={ gtmgrid = { command = "${launcher}", env = { GTMGRID_PROJECT = "${opts.project}" } } }`,
    ...(opts.model ? ["-m", opts.model] : []),
  ];
  const args = opts.threadId
    ? ["exec", "resume", opts.threadId, ...flags, message]
    : ["exec", ...flags, message];

  const bin = resolveAgentPath("codex");
  if (!bin) {
    sse.write({ type: "error", message: "Codex not found. Connect it in the panel or install @openai/codex." });
    sse.write({ type: "end" });
    return sse.end();
  }
  const child = spawn(bin, args, { env: agentSpawnEnv(bin), cwd: opts.repoRoot });
  child.stdin?.end(); // codex exec otherwise waits on stdin

  let threadId = opts.threadId ?? null;
  let buf = "";
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
  child.stderr.on("data", (d) => (stderr += d.toString()));
  child.on("error", (err) => {
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
  res.on("close", () => child.kill());
}
