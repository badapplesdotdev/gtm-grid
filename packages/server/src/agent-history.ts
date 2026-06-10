// Native agent chat-history reader. The desktop agent panel proxies the user's
// own `claude` / `codex` CLIs, which each persist full transcripts in their own
// stores — so the panel reads THOSE rather than keeping a local copy, and a
// resumed session continues the CLI's own native session (`--resume`).
//
//   - Claude Code: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl, one event
//     per line (user/assistant/ai-title …). The dir name is the project cwd with
//     every non-alphanumeric char replaced by '-'.
//   - Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl; the first
//     line is `session_meta` carrying the cwd + id, then event_msg / response_item
//     lines. We filter rollouts to the current project's cwd.
//
// Everything here is read-only and best-effort: a missing store / malformed line
// yields an empty result, never a throw.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AgentKind = "claude" | "codex";

/** A past conversation, newest first in a listing. */
export interface SessionSummary {
  id: string;
  title: string;
  /** Epoch ms of the transcript's last write (for sort + "x ago"). */
  updatedAt: number;
  messageCount: number;
}

export interface HistoryTool {
  name: string;
  input: Record<string, unknown>;
  result?: string;
}

/** One turn, matching the desktop panel's `Message` shape. */
export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
  tools: HistoryTool[];
}

/** Cap how many transcripts we parse for a listing (keeps it snappy). */
const LIST_LIMIT = 40;
/** Cap how many Codex rollout files we stat/scan (its store is global, not per-project). */
const CODEX_SCAN_CAP = 400;

const claudeProjectsRoot = () => join(homedir(), ".claude", "projects");
const codexSessionsRoot = () => join(homedir(), ".codex", "sessions");

/** Replicate Claude Code's cwd→dir encoding: every non-alphanumeric char → '-'. */
export function encodeClaudeDir(repoRoot: string): string {
  return repoRoot.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Skip the agent's injected system/instructions preamble when picking a title. */
function looksLikePreamble(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith("# AGENTS.md") ||
    t.startsWith("<INSTRUCTIONS") ||
    t.startsWith("<system") ||
    t.startsWith("Caveat:")
  );
}

function firstLine(text: string, max = 80): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * A human title from a user message, or `null` to skip it (preamble). A slash
 * command (`<command-name>/foo</command-name>`) becomes "/foo" rather than
 * leaking the raw tag soup; injected system preambles are skipped.
 */
function titleFromUserText(text: string): string | null {
  const cmd = text.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/);
  if (cmd) return firstLine(cmd[1]);
  const t = text.trimStart();
  if (looksLikePreamble(text) || t.startsWith("<command-") || t.startsWith("<local-command")) return null;
  return firstLine(text);
}

function parseJsonl(path: string): unknown[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

// ── Claude Code ──────────────────────────────────────────────────────────────

/** Extract plain text + tool calls from a Claude assistant `message.content[]`. */
function claudeAssistant(content: unknown): { text: string; tools: HistoryTool[] } {
  const tools: HistoryTool[] = [];
  let text = "";
  if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") text += block.text;
      else if (block.type === "tool_use") {
        tools.push({
          name: String(block.name ?? "").replace(/^mcp__gtmgrid__/, ""),
          input: (block.input as Record<string, unknown>) ?? {},
        });
      }
    }
  } else if (typeof content === "string") {
    text = content;
  }
  return { text, tools };
}

/** A Claude user `message.content` is a string, or blocks incl. tool_result. */
function claudeUser(content: unknown): { text: string; toolResults: string[] } {
  if (typeof content === "string") return { text: content, toolResults: [] };
  const toolResults: string[] = [];
  let text = "";
  if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") text += block.text;
      else if (block.type === "tool_result") {
        const c = block.content;
        const rt = Array.isArray(c)
          ? (c as Array<Record<string, unknown>>).map((x) => (x?.type === "text" ? String(x.text ?? "") : "")).join("")
          : typeof c === "string"
            ? c
            : "";
        if (rt) toolResults.push(rt);
      }
    }
  }
  return { text, toolResults };
}

function readClaudeSession(repoRoot: string, id: string, root = claudeProjectsRoot()): HistoryMessage[] {
  const path = join(root, encodeClaudeDir(repoRoot), `${id}.jsonl`);
  const events = parseJsonl(path) as Array<Record<string, unknown>>;
  const messages: HistoryMessage[] = [];
  let pendingTools: HistoryTool[] = []; // tools awaiting their results (next user turn)
  for (const e of events) {
    const msg = e.message as Record<string, unknown> | undefined;
    if (e.type === "assistant" && msg) {
      const { text, tools } = claudeAssistant(msg.content);
      if (!text && tools.length === 0) continue;
      messages.push({ role: "assistant", text, tools });
      pendingTools = tools;
    } else if (e.type === "user" && msg) {
      const { text, toolResults } = claudeUser(msg.content);
      // Attach tool_results to the previous assistant turn's tool calls.
      toolResults.forEach((r, i) => {
        if (pendingTools[i]) pendingTools[i].result = r.slice(0, 600);
      });
      if (text) messages.push({ role: "user", text, tools: [] });
    }
  }
  return messages;
}

function listClaudeSessions(repoRoot: string, root = claudeProjectsRoot()): SessionSummary[] {
  const dir = join(root, encodeClaudeDir(repoRoot));
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const byMtime = files
    .map((f) => {
      try {
        return { f, mtime: statSync(join(dir, f)).mtimeMs };
      } catch {
        return { f, mtime: 0 };
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, LIST_LIMIT);

  const out: SessionSummary[] = [];
  for (const { f, mtime } of byMtime) {
    const events = parseJsonl(join(dir, f)) as Array<Record<string, unknown>>;
    let title = "";
    let messageCount = 0;
    let firstUser = "";
    for (const e of events) {
      if (e.type === "ai-title" && typeof e.title === "string" && !title) title = e.title;
      if (e.type === "user" || e.type === "assistant") {
        const content = (e.message as Record<string, unknown> | undefined)?.content;
        const text = e.type === "user" ? claudeUser(content).text : claudeAssistant(content).text;
        if (text) messageCount += 1;
        if (e.type === "user" && text && !firstUser) {
          const t = titleFromUserText(text);
          if (t) firstUser = t;
        }
      }
    }
    if (messageCount === 0) continue; // empty/meta-only transcript
    out.push({
      id: f.replace(/\.jsonl$/, ""),
      title: title || firstUser || "Conversation",
      updatedAt: mtime,
      messageCount,
    });
  }
  return out;
}

// ── Codex ────────────────────────────────────────────────────────────────────

/** Recursively collect rollout files under the Codex sessions root (mtime-sorted). */
function codexRollouts(root: string): Array<{ path: string; mtime: number }> {
  const out: Array<{ path: string; mtime: number }> = [];
  const walk = (d: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.startsWith("rollout-") && ent.name.endsWith(".jsonl")) {
        try {
          out.push({ path: p, mtime: statSync(p).mtimeMs });
        } catch {
          /* skip */
        }
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, CODEX_SCAN_CAP);
}

function codexMeta(path: string): { id: string; cwd: string } | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const nl = raw.indexOf("\n");
  const head = nl >= 0 ? raw.slice(0, nl) : raw;
  try {
    const j = JSON.parse(head) as Record<string, unknown>;
    const p = j.payload as Record<string, unknown> | undefined;
    if (j.type === "session_meta" && p && typeof p.id === "string" && typeof p.cwd === "string") {
      return { id: p.id, cwd: p.cwd };
    }
  } catch {
    /* not a meta header */
  }
  return null;
}

function listCodexSessions(repoRoot: string, root = codexSessionsRoot()): SessionSummary[] {
  const out: SessionSummary[] = [];
  for (const { path, mtime } of codexRollouts(root)) {
    if (out.length >= LIST_LIMIT) break;
    const meta = codexMeta(path);
    if (!meta || meta.cwd !== repoRoot) continue;
    const events = parseJsonl(path) as Array<Record<string, unknown>>;
    let title = "";
    let messageCount = 0;
    for (const e of events) {
      const p = e.payload as Record<string, unknown> | undefined;
      const ptype = p?.type;
      if (ptype === "user_message" || ptype === "agent_message") {
        const text = typeof p?.message === "string" ? p.message : "";
        if (text) messageCount += 1;
        if (ptype === "user_message" && text && !title) {
          const t = titleFromUserText(text);
          if (t) title = t;
        }
      }
    }
    if (messageCount === 0) continue;
    out.push({ id: meta.id, title: title || "Conversation", updatedAt: mtime, messageCount });
  }
  return out;
}

function readCodexSession(repoRoot: string, id: string, root = codexSessionsRoot()): HistoryMessage[] {
  // Locate the rollout whose meta id matches (filename ends with the uuid too).
  const match = codexRollouts(root).find((r) => r.path.endsWith(`${id}.jsonl`) || codexMeta(r.path)?.id === id);
  if (!match) return [];
  const events = parseJsonl(match.path) as Array<Record<string, unknown>>;
  const messages: HistoryMessage[] = [];
  for (const e of events) {
    const p = e.payload as Record<string, unknown> | undefined;
    const ptype = p?.type;
    if (ptype === "user_message") {
      const text = typeof p?.message === "string" ? p.message : "";
      if (text && !looksLikePreamble(text)) messages.push({ role: "user", text, tools: [] });
    } else if (ptype === "agent_message") {
      const text = typeof p?.message === "string" ? p.message : "";
      if (text) messages.push({ role: "assistant", text, tools: [] });
    }
  }
  return messages;
}

// ── Latest-session lookup (cheap: no full transcript parse) ──────────────────
// The CLI is the source of truth for "what session are we in" — its native store,
// keyed by cwd, holds the running conversation. Resolving the newest session here
// lets a turn resume the user's own latest thread WITHOUT us persisting an id, so
// continuity survives a Stop or an app restart (we just re-bind to their terminal).

/** Newest Claude session id for `repoRoot` by mtime (filename only — no parse). */
function latestClaudeSessionId(repoRoot: string, root = claudeProjectsRoot()): string | null {
  const dir = join(root, encodeClaudeDir(repoRoot));
  if (!existsSync(dir)) return null;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  let best: { id: string; mtime: number } | null = null;
  for (const f of files) {
    let mtime = 0;
    try {
      mtime = statSync(join(dir, f)).mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtime > best.mtime) best = { id: f.replace(/\.jsonl$/, ""), mtime };
  }
  return best?.id ?? null;
}

/** Newest Codex thread id whose rollout cwd matches `repoRoot` (rollouts are mtime-desc). */
function latestCodexSessionId(repoRoot: string, root = codexSessionsRoot()): string | null {
  for (const { path } of codexRollouts(root)) {
    const meta = codexMeta(path);
    if (meta && meta.cwd === repoRoot) return meta.id;
  }
  return null;
}

/** The most recently-touched native session id for this agent + project, or null. */
export function latestSessionId(agent: AgentKind, repoRoot: string): string | null {
  return agent === "codex" ? latestCodexSessionId(repoRoot) : latestClaudeSessionId(repoRoot);
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

export function listAgentSessions(agent: AgentKind, repoRoot: string): SessionSummary[] {
  return agent === "codex" ? listCodexSessions(repoRoot) : listClaudeSessions(repoRoot);
}

export function readAgentSession(agent: AgentKind, repoRoot: string, id: string): HistoryMessage[] {
  return agent === "codex" ? readCodexSession(repoRoot, id) : readClaudeSession(repoRoot, id);
}

// Exported for tests (point them at fixture dirs).
export const __test = {
  listClaudeSessions,
  readClaudeSession,
  listCodexSessions,
  readCodexSession,
  latestClaudeSessionId,
  latestCodexSessionId,
};
