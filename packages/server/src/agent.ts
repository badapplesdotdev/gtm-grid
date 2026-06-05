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

function sseClient(res: ServerResponse): SseClient {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });
  return {
    write: (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
    end: () => res.end(),
  };
}

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
  opts: { message: string; project: string; repoRoot: string; sessionId?: string },
): void {
  const sse = sseClient(res);
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
  opts: { message: string; project: string; repoRoot: string; threadId?: string },
): void {
  const sse = sseClient(res);
  const launcher = mcpLauncher(opts.repoRoot);
  const flags = [
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    // Replace Codex's whole MCP table with ONLY gtmgrid, so it ignores the
    // user's other registered servers (Trigify/exa/etc.) and drives gtmgrid.
    "-c",
    `mcp_servers={ gtmgrid = { command = "${launcher}", env = { GTMGRID_PROJECT = "${opts.project}" } } }`,
  ];
  const args = opts.threadId
    ? ["exec", "resume", opts.threadId, ...flags, opts.message]
    : ["exec", ...flags, opts.message];

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
