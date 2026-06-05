// Agent bridge — spawns the user's already-authenticated `claude` / `codex` CLI
// in headless streaming mode, wired to gtmgrid's MCP server for the active
// project, and forwards text / tool-call / grid-changed events as SSE.
// This is the Revcode "connect your Claude Code / Codex" mechanism: no OAuth,
// no key storage — the app drives the CLI the user already logged into.

import { spawn } from "node:child_process";
import type { ServerResponse } from "node:http";
import { join } from "node:path";

const GTM_TOOLS = [
  "list_functions",
  "list_tables",
  "create_table",
  "add_column",
  "add_rows",
  "run_column",
  "get_table",
  "upload_extension",
];
const MUTATING = new Set(["create_table", "add_column", "add_rows", "run_column", "upload_extension"]);

export type AgentKind = "claude" | "codex";

function versionCheck(cmd: string): Promise<{ installed: boolean; version: string | null }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, ["--version"], { env: process.env });
    let out = "";
    const done = (installed: boolean) => resolve({ installed, version: installed ? out.trim() || null : null });
    child.stdout?.on("data", (d) => (out += d));
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0));
    setTimeout(() => {
      child.kill();
      done(out.length > 0);
    }, 4000);
  });
}

export async function detectAgents() {
  const [claude, codex] = await Promise.all([versionCheck("claude"), versionCheck("codex")]);
  return { claude, codex };
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
    "--allowedTools",
    ...GTM_TOOLS.map((t) => `mcp__gtmgrid__${t}`),
  ];
  if (opts.sessionId) args.push("--resume", opts.sessionId);

  const child = spawn("claude", args, { env: process.env, cwd: opts.repoRoot });
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
    "-c",
    `mcp_servers.gtmgrid.command="${launcher}"`,
    "-c",
    `mcp_servers.gtmgrid.env={ GTMGRID_PROJECT = "${opts.project}" }`,
  ];
  const args = opts.threadId
    ? ["exec", "resume", opts.threadId, ...flags, opts.message]
    : ["exec", ...flags, opts.message];

  const child = spawn("codex", args, { env: process.env, cwd: opts.repoRoot });
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
