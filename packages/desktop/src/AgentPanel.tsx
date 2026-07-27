// Right-side agent panel — the Revcode "Claude Code / Codex" tabs. Drives the
// gtmgrid grid by chatting with the user's already-authed local CLI (their Max /
// Codex plan) through the server's SSE agent bridge. Renders markdown, shows
// collapsible tool calls + results inline, a shimmering "thinking" indicator,
// supports stop + multi-turn, collapses to a slim logo rail, and refreshes the
// grid live as the agent calls mutating tools.

import { useCallback, useEffect, useRef, useState, type FC, type ReactNode, type MouseEvent as ReactMouseEvent } from "react";
import { Streamdown as StreamdownImpl } from "streamdown";

// Streamdown ships its own bundled React types; under this app's @types/react 18
// their JSX element types don't line up with ours (TS2786 "cannot be used as a
// JSX component"). Retype it to the props we actually pass.
const Streamdown = StreamdownImpl as unknown as FC<{ className?: string; children?: ReactNode }>;
import { api, API_BASE, type AgentModelOption, type AgentSession, type AgentStatus } from "./api";
import { onActivateKey } from "./lib/utils";
import { capture } from "./analytics";
import { abortAllRuns, abortRun, tableAbortKey, type AbortControllers } from "./agentAbort";

type AgentKind = "claude" | "codex" | "cursor";

interface ToolCallT {
  name: string;
  input: Record<string, unknown>;
  result?: string;
  error?: string;
}
/** An ordered segment of an assistant turn. The agent streams text and tool
 *  calls interleaved; recording them as a sequence (rather than one text blob +
 *  a separate tools array) is what lets the UI render them in the order they
 *  actually happened instead of bunching every tool call at the top. Tool parts
 *  reference `Message.tools` by index so a later tool_result can patch the tool
 *  in place without disturbing the sequence. */
type Part = { kind: "text"; text: string } | { kind: "tool"; ref: number };

/** A pending human-in-the-loop approval — the MCP gate paused on a destructive /
 *  credit-spending op and is waiting for the user to Approve/Deny in the chat. */
interface PermissionRequest {
  pendingId: string;
  tool: string;
  argsHash: string;
  mode?: string;
  action?: string;
  target?: string;
  willAffect?: number;
  estimatedCredits?: number;
}

/** One selectable option in an AskUserQuestion question. */
interface AskOption {
  label: string;
  description?: string;
}
/** A single structured question the agent posed via `ask_user_question`. */
interface AskQuestion {
  header: string;
  question: string;
  multiSelect?: boolean;
  options: AskOption[];
}
/** A pending AskUserQuestion — the agent called `ask_user_question` and is
 *  waiting for the user to pick (or type) answers in the chat. Drives the answer
 *  cards that replace the composer at the bottom of the stream. */
interface AskRequest {
  questions: AskQuestion[];
}

interface Message {
  role: "user" | "assistant";
  /** Full concatenated text of the turn (drives planBody, thinking label,
   *  fallbacks). Rendering uses `parts`; this stays in sync as a convenience. */
  text: string;
  tools: ToolCallT[];
  /** Chronological interleave of text + tool segments — the render source. */
  parts: Part[];
  error?: boolean;
  /** This assistant turn was produced in PLAN MODE — render the plan affordances. */
  plan?: boolean;
  /** A tool paused for human approval (HITL) — drives the Approve/Deny card. */
  permission?: PermissionRequest;
  /** The agent asked a structured multiple-choice question — drives the answer
   *  cards that replace the composer. */
  ask?: AskRequest;
}

/** Append streamed text to the open text segment, or start a new one — so text
 *  that arrives after a tool call lands below it instead of merging upward. */
function appendText(m: Message, chunk: string): Message {
  const parts = [...m.parts];
  const last = parts[parts.length - 1];
  if (last && last.kind === "text") parts[parts.length - 1] = { kind: "text", text: last.text + chunk };
  else parts.push({ kind: "text", text: chunk });
  return { ...m, parts, text: m.text + chunk };
}

/** Surface a turn failure even when the agent already streamed earlier text. */
export function appendErrorNotice(m: Message, message: string): Message {
  const notice = `\n\n⚠️ ${message}`;
  const tools = m.tools.map((tool) =>
    tool.result === undefined && tool.error === undefined ? { ...tool, error: message } : tool,
  );
  return { ...appendText(m, notice), tools, error: true };
}

export function incompleteStreamMessage(
  agent: AgentKind,
  state: { sawDone: boolean; sawEnd: boolean; sawError: boolean },
): string | null {
  if (state.sawDone || state.sawError) return null;
  return state.sawEnd
    ? `${AGENT_LABEL[agent]} stopped before returning a final result. You can safely retry or continue the same task.`
    : `Connection to ${AGENT_LABEL[agent]} ended unexpectedly. The last tool may still be incomplete.`;
}

/** Back-fill `parts` for messages loaded from a native transcript, which only
 *  carries flat text + tools. True order isn't recoverable there, so mirror the
 *  prior render (tool calls first, then text) for historical conversations. */
function withParts(m: Message): Message {
  if (m.parts?.length) return m;
  const tools = m.tools ?? [];
  const parts: Part[] = tools.map((_, i) => ({ kind: "tool", ref: i }));
  if (m.text) parts.push({ kind: "text", text: m.text });
  return { ...m, tools, parts };
}

const AGENT_LABEL: Record<AgentKind, string> = { claude: "Claude", codex: "Codex", cursor: "Cursor" };
/** The on-PATH binary name for each agent (Cursor's headless CLI is `cursor-agent`). */
const AGENT_BIN_NAME: Record<AgentKind, string> = { claude: "claude", codex: "codex", cursor: "cursor-agent" };
/** The subscription/plan name shown once an agent is connected. */
const AGENT_PLAN: Record<AgentKind, string> = { claude: "Max", codex: "Codex", cursor: "Cursor" };

/**
 * Slash commands the user can type in the chat. Typing `/` at the start of an
 * empty composer opens a menu of these; picking one inserts `/<name> ` so they
 * can type the argument. The command itself is interpreted by the AGENT (the
 * `## Slash commands` protocol in the server preamble, packages/server/src/agent.ts)
 * — the message is sent verbatim, so this is purely the discoverability surface.
 * Claude Code also expands its own user-invoked skills/commands in `-p` mode, so
 * anything the user has installed still works even if it's not listed here.
 */
interface SlashCommand {
  name: string;
  hint: string;
  description: string;
}
export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "goal",
    hint: "<objective>",
    description: "Hand the agent an objective — it plans, then works it end-to-end",
  },
  {
    name: "start",
    hint: "",
    description: "New here? A quick tour of GTM Grid and what to try first",
  },
];

/** The onboarding command GTM Grid answers ITSELF — never forwarded to the agent
 *  CLI (claude/codex/cursor would intercept `/start` as their OWN built-in slash
 *  command and reply "Unknown command: /start"). Matched on the leading word. */
export const ONBOARDING_COMMAND = /^\/start\b/i;

/** The canned onboarding reply rendered locally for `/help` and `/start`. Markdown
 *  (assistant messages render through <Markdown/>). */
const ONBOARDING_MESSAGE = [
  "### Welcome to GTM Grid 👋",
  "",
  "GTM Grid is a spreadsheet where **every column is a function**. You tell me what you want, and I build and fill the grid for you — watch the rows populate live.",
  "",
  "**Get data in**",
  "- Create a table from chat, or click **Import CSV…** in the left sidebar",
  "- Or just **drag a CSV** anywhere onto the window",
  "",
  "**What I can do per row**",
  "- Find work emails, enrich a LinkedIn profile or company, score & qualify leads, or draft personalized copy — using your connected providers and skills.",
  "",
  "**Try one of these**",
  "- `Enrich every row with their Trigify profile and company`",
  "- `Find a work email for each row, then draft a one-line opener`",
  "- `Create a table of 25 SaaS founders in London and enrich them`",
  "",
  "**Tip:** hand me a whole objective with `/goal <objective>` and I'll plan it, then run it end-to-end.",
  "",
  "What would you like to build first?",
].join("\n");

/**
 * Permission modes the user picks in the composer — mapped to the CLI's
 * `--permission-mode` on the server (packages/server/src/agent.ts). Only the
 * headless-safe modes are offered: in `-p` the "ask" mode can't surface a prompt
 * (stdin is closed), so it's omitted. Bypass is the default — it matches the
 * Codex/Cursor bridges' existing posture and stops non-grid tools (Bash, grep)
 * from being denied.
 */
type PermMode = "bypassPermissions" | "auto" | "acceptEdits" | "plan";
const MODE_OPTIONS: { value: PermMode; label: string; hint: string }[] = [
  { value: "bypassPermissions", label: "Bypass permissions", hint: "Run every tool without asking" },
  { value: "auto", label: "Auto", hint: "Auto-approve actions that match your request" },
  { value: "acceptEdits", label: "Accept edits", hint: "Auto-approve edits; deny the rest" },
  { value: "plan", label: "Plan mode", hint: "Draft a plan first — don't execute yet" },
];
const MODE_KEY = "gtmgrid.agentMode";
function loadMode(): PermMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v && MODE_OPTIONS.some((o) => o.value === v)) return v as PermMode;
  } catch {
    /* storage disabled — fall through */
  }
  // Default to "auto" (not bypass): destructive ops and credit spends ask for a
  // one-click approval, which is the safe default now that modes are enforced.
  return "auto";
}

function relativeTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Persist the per-agent model selection so it survives a relaunch (the rest of
// the conversation history is NOT stored here — the agents keep their own native
// transcripts; a follow-up surfaces those).
const MODELS_KEY = "gtmgrid:agentModels";
function loadModels(): Record<AgentKind, string> {
  try {
    const raw = localStorage.getItem(MODELS_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    return {
      claude: typeof obj?.claude === "string" ? obj.claude : "",
      codex: typeof obj?.codex === "string" ? obj.codex : "",
      cursor: typeof obj?.cursor === "string" ? obj.cursor : "",
    };
  } catch {
    return { claude: "", codex: "", cursor: "" };
  }
}

/** Static fallbacks for agents that don't expose a local model catalog. */
const MODEL_OPTIONS: Record<AgentKind, AgentModelOption[]> = {
  // Claude Code has no model cache to enumerate, but its CLI resolves family
  // ALIASES to the latest model in each family at run time — so we offer aliases
  // (not pinned versions) and the picker never goes stale. The live catalog is
  // fetched from the sidecar (`/api/agent/models/claude`) on open; this static
  // list is the pre-fetch fallback and mirrors it.
  claude: [
    { value: "", label: "Default" },
    { value: "opus", label: "Opus (latest)" },
    { value: "sonnet", label: "Sonnet (latest)" },
    { value: "haiku", label: "Haiku (latest)" },
    { value: "fable", label: "Fable (latest)" },
  ],
  codex: [
    { value: "", label: "Default" },
  ],
  // Cursor's model lineup, passed via `cursor-agent --model` (slugs follow
  // Cursor's documented kebab convention, e.g. `claude-4.6-sonnet`, `composer-2.5`).
  // "" = the model selected in the Cursor app / `cursor-agent` config (its default).
  cursor: [
    { value: "", label: "Default" },
    // Cursor's own models
    { value: "composer-2.5", label: "Composer 2.5" },
    { value: "composer-1.5", label: "Composer 1.5" },
    // Anthropic Claude
    { value: "claude-4.6-sonnet", label: "Claude 4.6 Sonnet" },
    { value: "claude-4.6-opus", label: "Claude 4.6 Opus" },
    { value: "claude-opus-4.8", label: "Claude Opus 4.8" },
    { value: "claude-fable-5", label: "Claude Fable 5" },
    { value: "claude-4.5-haiku", label: "Claude 4.5 Haiku" },
    // OpenAI
    { value: "gpt-5.2", label: "GPT-5.2" },
    { value: "gpt-5", label: "GPT-5" },
    { value: "gpt-5-codex", label: "GPT-5 Codex" },
    { value: "gpt-5-mini", label: "GPT-5 Mini" },
    // Google Gemini
    { value: "gemini-3-pro", label: "Gemini 3 Pro" },
    { value: "gemini-3-flash", label: "Gemini 3 Flash" },
    // xAI Grok
    { value: "grok-4.3", label: "Grok 4.3" },
  ],
};
const AGENT_SHORT: Record<AgentKind, string> = { claude: "Claude", codex: "Codex", cursor: "Cursor" };

const PROMPTS = [
  "Enrich every row with their Trigify profile and company",
  "Find a work email for each row, then draft a one-line opener",
];

/* ── Small inline icons (no network, ship offline) ── */
const IconCheck = ({ s = 10 }: { s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);
const IconChevronRight = ({ s = 11 }: { s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m9 18 6-6-6-6" />
  </svg>
);
const IconChevronsLeft = ({ s = 16 }: { s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m11 17-5-5 5-5M18 17l-5-5 5-5" />
  </svg>
);
const IconChevronsRight = ({ s = 15 }: { s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m6 17 5-5-5-5M13 17l5-5-5-5" />
  </svg>
);
const IconZap = ({ s = 11 }: { s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M13 2 4.5 13.5H11l-1 8.5 9.5-12H13z" />
  </svg>
);
const IconArrow = ({ s = 15 }: { s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);
const IconStop = ({ s = 13 }: { s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="2.5" />
  </svg>
);

// Brand logomarks for the agent tabs (inline SVG — no network, ships offline).
const AGENT_LOGO: Record<AgentKind, ReactNode> = {
  // Official Cursor logomark (the faceted cube), centered in a square viewBox so it
  // sits the same size as the Claude/Codex marks. `currentColor` so it themes.
  cursor: (
    <svg className="agent-logo" viewBox="-32.68 0 532.09 532.09" aria-hidden="true">
      <path
        fill="currentColor"
        d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z"
      />
    </svg>
  ),
  // Claude Code mark — the Claude sunburst (Anthropic's clay #D97757), not the
  // Anthropic angular-A wordmark.
  claude: (
    <svg className="agent-logo" viewBox="0 0 256 257" aria-hidden="true">
      <path
        fill="#D97757"
        d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z"
      />
    </svg>
  ),
  codex: (
    <svg className="agent-logo" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.1419.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
      />
    </svg>
  ),
};

const AGENT_MARK: Record<AgentKind, ReactNode> = {
  cursor: (
    <svg width="11" height="11" viewBox="-32.68 0 532.09 532.09" aria-hidden="true">
      <path
        fill="currentColor"
        d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z"
      />
    </svg>
  ),
  claude: (
    <svg width="11" height="11" viewBox="0 0 256 257" aria-hidden="true">
      <path fill="#D97757" d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z" />
    </svg>
  ),
  codex: (
    <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.1419.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  ),
};

/**
 * Agent markdown renderer. Streamdown handles GFM (tables, lists, code fences,
 * links) and — crucially for our SSE token stream — gracefully renders
 * *incomplete* markdown as it arrives (unterminated bold, half-written fences),
 * so the chat doesn't flicker through broken syntax. The `.agent-md` class scopes
 * our typography overrides in styles.css. Used by the chat, plan drawer (both in
 * AgentPanel) and the skill body (Panels.tsx).
 */
export function Markdown({ text }: { text: string }): ReactNode {
  return <Streamdown className="agent-md">{text}</Streamdown>;
}

/* ── Tool-call helpers ── */
function argsLabel(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (!entries.length) return "";
  return entries
    .map(([k, v]) => `${k}: ${typeof v === "string" ? `"${v}"` : JSON.stringify(v)}`)
    .join(", ");
}

// A short success chip derived from the tool result (best-effort, never throws).
function summarize(result: string): string {
  const trimmed = result.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return `${parsed.length} item${parsed.length !== 1 ? "s" : ""}`;
    if (parsed && typeof parsed === "object") {
      const o = parsed as Record<string, unknown>;
      if (Array.isArray(o.rows) && Array.isArray(o.columns))
        return `${o.columns.length} cols · ${o.rows.length} rows`;
      if (typeof o.done === "number" && typeof o.total === "number")
        return `${o.done}/${o.total} done${o.errors ? ` · ${o.errors} error${o.errors !== 1 ? "s" : ""}` : ""}`;
      const n = Object.keys(o).length;
      return `${n} field${n !== 1 ? "s" : ""}`;
    }
  } catch {
    /* not JSON */
  }
  const len = trimmed.length;
  return `${len} char${len !== 1 ? "s" : ""}`;
}

/**
 * If the message's most-recent tool result is a gtm-grid `confirmationRequired`
 * payload (a destructive/large op the agent paused on), return it so the UI can
 * render Approve/Deny buttons. The agent stops and waits after emitting one of
 * these, so the LAST resolved tool result is the pending confirmation. Returns
 * null otherwise.
 */
function pendingConfirm(
  m: Message,
): { action?: string; willAffect?: number; target?: string; message?: string; estimatedCredits?: number } | null {
  const last = [...m.tools].reverse().find((t) => t.result !== undefined);
  if (!last?.result) return null;
  try {
    const p = JSON.parse(last.result.trim());
    if (p && typeof p === "object" && p.confirmationRequired === true) {
      return { action: p.action, willAffect: p.willAffect, target: p.target, message: p.message, estimatedCredits: p.estimatedCredits };
    }
  } catch {
    /* not JSON — no confirmation */
  }
  return null;
}

/**
 * The plan markdown for a plan-mode assistant turn: the `ExitPlanMode` tool's
 * `plan` input if the agent used it, otherwise the message's own text (our PLAN
 * MODE preamble asks the agent to present the plan as plain text). Empty while
 * the turn is still streaming with nothing yet.
 */
function planBody(m: Message): string {
  for (let i = m.tools.length - 1; i >= 0; i--) {
    const t = m.tools[i];
    if (t.name === "ExitPlanMode" && typeof t.input?.plan === "string" && t.input.plan.trim()) {
      return t.input.plan;
    }
  }
  return m.text;
}

// Pretty-print JSON results; pass other text through unchanged.
function prettyResult(result: string): string {
  const trimmed = result.trim();
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return result;
  }
}

// A single tool call: a compact pill that expands to show its full result.
function ToolCall({ tool, running }: { tool: ToolCallT; running: boolean }) {
  const [open, setOpen] = useState(false);
  const expandable = tool.result !== undefined && tool.result.length > 0;
  const args = argsLabel(tool.input);
  return (
    <div className={`tc${running ? " running" : ""}${tool.error ? " failed" : ""}`}>
      <button className="tc-row" onClick={() => expandable && setOpen((o) => !o)} disabled={!expandable}>
        <span className="tc-status">{running ? <span className="tc-spin" /> : tool.error ? <span aria-label="Failed">×</span> : <IconCheck s={10} />}</span>
        <span className="tc-name">{tool.name}</span>
        {args && <span className="tc-args">{args}</span>}
        {tool.error && <span className="tc-error">Interrupted</span>}
        {tool.result !== undefined && !running && <span className="tc-summary">{summarize(tool.result)}</span>}
        {expandable && <span className={`tc-caret${open ? " open" : ""}`}><IconChevronRight s={11} /></span>}
      </button>
      {open && expandable && <pre className="tc-json">{prettyResult(tool.result!)}</pre>}
    </div>
  );
}

/** Bottom-of-composer model picker — a pill button that opens a menu UPWARD (Claude-Code style). */
function ModelPicker({ agent, value, options, onChange, onOpen }: { agent: AgentKind; value: string; options: AgentModelOption[]; onChange: (v: string) => void; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const opts = options.some((o) => o.value === value) || !value
    ? options
    : [...options, { value, label: `${value} (saved)` }];
  const current = opts.find((o) => o.value === value) ?? opts[0];
  return (
    <div className="agent-model-picker" ref={ref}>
      {open && (
        <div className="agent-model-menu">
          <div className="agent-model-menu-head">Model · {AGENT_LABEL[agent]}</div>
          {opts.map((o) => (
            <button
              key={o.value || "default"}
              className={`agent-model-opt ${o.value === value ? "active" : ""}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              <span>{o.label}</span>
              {o.value === value && <IconCheck s={12} />}
            </button>
          ))}
        </div>
      )}
      <button className="agent-model-btn" onClick={() => setOpen((o) => { if (!o) onOpen?.(); return !o; })} title="Choose model">
        {current.label}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
    </div>
  );
}

/** Permission-mode picker — a small shield button + dropdown beside History. */
function ModePicker({ value, onChange }: { value: PermMode; onChange: (v: PermMode) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const current = MODE_OPTIONS.find((o) => o.value === value) ?? MODE_OPTIONS[0];
  return (
    <div className="agent-model-picker" ref={ref}>
      {open && (
        <div className="agent-model-menu agent-mode-menu">
          <div className="agent-model-menu-head">Permission mode</div>
          {MODE_OPTIONS.map((o) => (
            <button
              key={o.value}
              className={`agent-model-opt agent-mode-opt ${o.value === value ? "active" : ""}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              <span className="agent-mode-opt-text">
                <span className="agent-mode-opt-label">{o.label}</span>
                <span className="agent-mode-opt-hint">{o.hint}</span>
              </span>
              {o.value === value && <IconCheck s={12} />}
            </button>
          ))}
        </div>
      )}
      <button className="agent-model-btn" onClick={() => setOpen((o) => !o)} title="Permission mode">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l8 4v6c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V6z" /></svg>
        {current.label}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
    </div>
  );
}

/**
 * The CLOUD context forwarded to the agent so its MCP table tools operate on the
 * user's CLOUD (Supabase) project instead of local SQLite (TRI-3296). `null`
 * whenever a cloud project is NOT active (local mode, or signed-out / no
 * `VITE_API_URL`), in which case the agent keeps its local SQLite behaviour.
 */
export interface AgentCloudContext {
  readonly apiUrl: string;
  readonly token: string;
  readonly workspaceId: string;
  readonly projectId: string;
  /** The active table — OPTIONAL: the agent works with no table loaded. */
  readonly tableId?: string;
  /** The pipeline currently open on the workflow canvas. */
  readonly pipelineId?: string;
}

/** Agent activity forwarded to the host (drives agent presence in the grid). */
export type AgentActivityEvent =
  | { readonly type: "tool"; readonly name: string; readonly input: Record<string, unknown> }
  | { readonly type: "turn-end" };

/** Build the reply text sent back to the agent. A single question sends the bare
 *  answer (the session already has context); multiple questions are mapped by
 *  header so the model can tell which answer goes with which question. */
function buildAskAnswer(questions: AskQuestion[], answers: string[]): string {
  if (questions.length === 1) return answers[0] ?? "";
  return questions.map((q, i) => `${q.header}: ${answers[i] ?? ""}`).join("\n");
}

/** AskUserQuestion answer cards — render at the bottom of the chat IN PLACE OF the
 *  composer. Steps through the agent's questions one at a time; the user picks an
 *  option (click or hotkey 1–9) or chooses "Other" to type a custom answer. On the
 *  last question the combined answer resumes the conversation via `onSubmit`. */
function AskCards({ request, onSubmit }: { request: AskRequest; onSubmit: (answer: string) => void }) {
  const questions = request.questions;
  const [qi, setQi] = useState(0);
  const [answers, setAnswers] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [otherOpen, setOtherOpen] = useState(false);
  const [other, setOther] = useState("");
  const otherRef = useRef<HTMLInputElement>(null);

  const q = questions[qi];
  const isLast = qi === questions.length - 1;
  const otherNum = q.options.length + 1; // hotkey number for the "Other" card

  function advance(answer: string) {
    const next = [...answers];
    next[qi] = answer;
    if (isLast) {
      onSubmit(buildAskAnswer(questions, next));
    } else {
      setAnswers(next);
      setQi(qi + 1);
      setSelected(new Set());
      setOther("");
      setOtherOpen(false);
    }
  }

  function pickOption(i: number) {
    // Single-select commits immediately; multi-select toggles and waits for Enter.
    if (q.multiSelect) {
      setSelected((s) => {
        const n = new Set(s);
        if (n.has(i)) n.delete(i);
        else n.add(i);
        return n;
      });
    } else {
      advance(q.options[i].label);
    }
  }

  function openOther() {
    setOtherOpen(true);
    setTimeout(() => otherRef.current?.focus(), 0);
  }

  function confirmMulti() {
    const labels = [...selected].sort((a, b) => a - b).map((i) => q.options[i].label);
    if (other.trim()) labels.push(other.trim());
    if (labels.length === 0) return;
    advance(labels.join(", "));
  }

  function submitOther() {
    if (q.multiSelect) confirmMulti();
    else if (other.trim()) advance(other.trim());
  }

  // Global hotkeys 1–9 / Enter, active only while the cards are mounted. Skipped
  // when focus is in any text field (incl. our own Other input + grid cells) so we
  // never hijack typing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        if (e.key === "Enter" && q.multiSelect && el === otherRef.current) {
          // handled by the Other input's own onKeyDown
        }
        return;
      }
      if (e.key >= "1" && e.key <= "9") {
        const num = Number(e.key);
        if (num <= q.options.length) {
          e.preventDefault();
          pickOption(num - 1);
        } else if (num === otherNum) {
          e.preventDefault();
          openOther();
        }
      } else if (e.key === "Enter" && q.multiSelect) {
        e.preventDefault();
        confirmMulti();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [qi, q, otherNum, selected, other, answers]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="agent-ask">
      <div className="agent-ask-head">
        <span className="agent-ask-chip">{q.header}</span>
        {questions.length > 1 && (
          <span className="agent-ask-step">
            Question {qi + 1} of {questions.length}
          </span>
        )}
      </div>
      <div className="agent-ask-q">{q.question}</div>
      <div className="agent-ask-options">
        {q.options.map((o, i) => {
          const sel = !!q.multiSelect && selected.has(i);
          return (
            <button key={i} className={`agent-ask-option${sel ? " sel" : ""}`} onClick={() => pickOption(i)}>
              <kbd className="agent-ask-key">{i + 1}</kbd>
              <span className="agent-ask-option-body">
                <span className="agent-ask-option-label">{o.label}</span>
                {o.description && <span className="agent-ask-option-desc">{o.description}</span>}
              </span>
              {q.multiSelect && <span className="agent-ask-check">{sel ? "✓" : ""}</span>}
            </button>
          );
        })}
        {otherOpen ? (
          <div className="agent-ask-other">
            <kbd className="agent-ask-key">{otherNum}</kbd>
            <input
              ref={otherRef}
              className="agent-ask-other-input"
              value={other}
              placeholder="Type your answer…"
              onChange={(e) => setOther(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitOther();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setOtherOpen(false);
                  setOther("");
                }
              }}
            />
            <button className="agent-ask-other-send" onClick={submitOther} disabled={!q.multiSelect && !other.trim()}>
              <IconArrow s={14} />
            </button>
          </div>
        ) : (
          <button className="agent-ask-option agent-ask-option-other" onClick={openOther}>
            <kbd className="agent-ask-key">{otherNum}</kbd>
            <span className="agent-ask-option-body">
              <span className="agent-ask-option-label">Other…</span>
              <span className="agent-ask-option-desc">Type a custom answer</span>
            </span>
          </button>
        )}
      </div>
      {q.multiSelect && (
        <div className="agent-ask-foot">
          <span className="agent-ask-hint">Pick one or more, then Enter</span>
          <button className="agent-ask-confirm" onClick={confirmMulti} disabled={selected.size === 0 && !other.trim()}>
            {isLast ? "Submit" : "Next"}
          </button>
        </div>
      )}
    </div>
  );
}

export default function AgentPanel({
  onGridChange,
  activeTable,
  activePipeline,
  cloud,
  onAgentEvent,
  onResizeStart,
}: {
  onGridChange: () => void;
  activeTable: { name: string; columns: string[] } | null;
  activePipeline: { id: string; name: string } | null;
  /** Cloud context when a cloud project is active; `null` in local mode. */
  cloud?: AgentCloudContext | null;
  /** Tool-call / turn-end notifications (drives the grid's agent presence). */
  onAgentEvent?: (e: AgentActivityEvent) => void;
  /** Begin a drag-resize of the panel width (left-edge handle); omit to disable. */
  onResizeStart?: (e: ReactMouseEvent) => void;
}) {
  const [agent, setAgent] = useState<AgentKind>("claude");
  // Which model each agent's CLI runs with ("" = the plan's default). Persisted.
  const [models, setModels] = useState<Record<AgentKind, string>>(loadModels);
  const [codexModelOptions, setCodexModelOptions] = useState<AgentModelOption[]>(
    MODEL_OPTIONS.codex,
  );
  const [claudeModelOptions, setClaudeModelOptions] = useState<AgentModelOption[]>(
    MODEL_OPTIONS.claude,
  );
  // Permission mode (global across agents), persisted. Maps to --permission-mode.
  const [mode, setMode] = useState<PermMode>(loadMode);
  const [status, setStatus] = useState<{ claude?: AgentStatus; codex?: AgentStatus; cursor?: AgentStatus }>({});
  const [threads, setThreads] = useState<Record<AgentKind, Message[]>>({ claude: [], codex: [], cursor: [] });
  const [input, setInput] = useState("");
  // Slash-command menu: open while the composer holds just `/word` (the command
  // name being typed, before any space/argument). `index` is the keyboard cursor.
  const [slash, setSlash] = useState<{ query: string; index: number } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // The plan currently open in the slide-out drawer (null = closed).
  const [planView, setPlanView] = useState<string | null>(null);
  // Busy is PER AGENT: a Claude run doesn't disable the Codex composer, and
  // switching tabs shows the busy state of the tab you're viewing.
  const [busyByAgent, setBusyByAgent] = useState<Record<AgentKind, boolean>>({ claude: false, codex: false, cursor: false });
  const busy = busyByAgent[agent];
  const [collapsed, setCollapsed] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [connecting, setConnecting] = useState(false);
  const sessionRef = useRef<Record<AgentKind, string | undefined>>({ claude: undefined, codex: undefined, cursor: undefined });
  // "Start fresh" intent for the next turn. The server resumes the latest native
  // session by default (so continuity survives a Stop/restart with nothing stored
  // here), so a New chat must be signalled explicitly — otherwise an empty
  // sessionRef would just resume the latest thread.
  const newChatRef = useRef<Record<AgentKind, boolean>>({ claude: false, codex: false, cursor: false });
  // One in-flight controller PER agent so runs are independent — switching tabs
  // never aborts another agent's live turn (only an unmount / table switch does).
  const abortRefs = useRef<AbortControllers>({ claude: null, codex: null, cursor: null });
  const scrollRef = useRef<HTMLDivElement>(null);
  // History dropdown: past conversations from the agent's OWN native transcript
  // store (read via the sidecar), NOT a local copy. Opening one loads its messages
  // and reuses the native session id so the next turn resumes with full context.
  const [showHistory, setShowHistory] = useState(false);
  const [sessions, setSessions] = useState<AgentSession[] | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  const messages = threads[agent];

  const refreshCodexModels = useCallback(() => {
    void api.agentModels("codex").then((result) => {
      const defaultLabel = result.defaultModel
        ? `Default · ${result.models.find((m) => m.value === result.defaultModel)?.label ?? result.defaultModel}`
        : "Default";
      setCodexModelOptions([
        { value: "", label: defaultLabel },
        ...result.models,
      ]);
    }).catch(() => {
      // Codex may not have run yet; Default remains valid through config.toml.
    });
  }, []);

  const refreshClaudeModels = useCallback(() => {
    void api.agentModels("claude").then((result) => {
      const defaultLabel = result.defaultModel
        ? `Default · ${result.models.find((m) => m.value === result.defaultModel)?.label ?? result.defaultModel}`
        : "Default";
      setClaudeModelOptions([
        { value: "", label: defaultLabel },
        ...result.models,
      ]);
    }).catch(() => {
      // Sidecar not reachable yet; the static alias fallback stays valid.
    });
  }, []);

  useEffect(() => {
    refreshCodexModels();
    refreshClaudeModels();
  }, [refreshCodexModels, refreshClaudeModels]);

  // The agent asked a structured question on its last turn — surface answer cards
  // in place of the composer until the user replies (which appends a new message).
  const lastMessage = messages[messages.length - 1];
  const pendingAsk =
    !busy && lastMessage?.role === "assistant" && lastMessage.ask && lastMessage.ask.questions.length > 0
      ? lastMessage.ask
      : null;

  // Persist the model selection per agent (survives relaunch).
  useEffect(() => {
    try {
      localStorage.setItem(MODELS_KEY, JSON.stringify(models));
    } catch {
      /* quota / disabled storage — ignore */
    }
  }, [models]);

  // Persist the permission mode (survives relaunch).
  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* storage disabled — ignore */
    }
  }, [mode]);

  // Load the native session list when the dropdown opens (refetch per open so it
  // reflects conversations the CLI wrote since last time). Close on outside click.
  useEffect(() => {
    if (!showHistory) return;
    setSessions(null);
    let live = true;
    if (agent === "cursor") setSessions([]); // Cursor's transcript store isn't parsed here (in-session resume only)
    else api.agentSessions(agent).then((r) => live && setSessions(r.sessions)).catch(() => live && setSessions([]));
    const onDoc = (e: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) setShowHistory(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => { live = false; document.removeEventListener("mousedown", onDoc); };
  }, [showHistory, agent]);

  /** Start a fresh conversation for the current agent (drops the in-session CLI
   * session id so the next turn starts a new native transcript). */
  const newChat = () => {
    sessionRef.current[agent] = undefined;
    newChatRef.current[agent] = true; // next turn starts a fresh native session
    setThreads((t) => ({ ...t, [agent]: [] }));
  };

  /** Reopen a past conversation: load its messages from the native transcript and
   * adopt its session id so the next turn resumes the CLI's own session. */
  const openSession = async (s: AgentSession) => {
    setShowHistory(false);
    if (agent === "cursor") return; // Cursor's transcript store isn't parsed here
    try {
      const { messages: msgs } = await api.agentSession(agent, s.id);
      setThreads((t) => ({ ...t, [agent]: (msgs as Message[]).map(withParts) }));
      sessionRef.current[agent] = s.id;
      newChatRef.current[agent] = false; // resuming a specific thread, not starting fresh
    } catch {
      /* transcript unreadable — leave the current thread as-is */
    }
  };

  useEffect(() => {
    api.agents().then(setStatus).catch(() => setStatus({}));
  }, []);

  // Re-detect (after install) or connect a manually-specified CLI path.
  async function connect(path?: string) {
    setConnecting(true);
    try {
      setStatus(await api.connectAgent(agent, path));
      setPathInput("");
    } catch {
      /* ignore */
    } finally {
      setConnecting(false);
    }
  }
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [threads, agent, busy]);

  const current = status[agent];
  const ready = current?.installed;

  function stop() {
    abortRun(abortRefs.current, agent);
  }

  // Abort EVERY agent's in-flight turn when the panel UNMOUNTS (closing it) or
  // when the active TABLE changes — otherwise the SSE fetches keep streaming and
  // the server keeps the spawned CLIs (+ MCP trees) alive, leaking memory
  // (TRI-3305). The empty effect body means the abort only runs on cleanup.
  //
  // An AGENT switch is deliberately NOT a trigger: each agent's run is tracked in
  // its own `abortRefs` slot and keeps streaming into its own thread, so flipping
  // tabs just changes which thread is rendered. TRI-3306: key off the STABLE
  // SCALAR table name (not the `activeTable` object identity, which App.tsx
  // churns every re-render) so unrelated re-renders never tear down a live turn.
  const tableKey = tableAbortKey(activeTable);
  const contextKey = `${tableKey}:${activePipeline?.id ?? ""}`;
  useEffect(() => {
    const refs = abortRefs.current;
    return () => abortAllRuns(refs);
  }, [contextKey]);

  async function send(preset?: string, modeOverride?: PermMode, approval?: { tool: string; argsHash: string }) {
    // Bind this turn to the agent it was started on. Everything below uses `a`,
    // not the live `agent` state, so the run keeps writing to ITS OWN thread and
    // toggling ITS OWN busy flag even after the user switches tabs mid-stream.
    const a = agent;
    const text = (preset ?? input).trim();
    if (!text || busyByAgent[a]) return;
    // `modeOverride` lets "Approve & run" resume a plan in an execute mode; it
    // also becomes the new sticky mode so follow-ups keep executing.
    const effMode = modeOverride ?? mode;
    if (modeOverride && modeOverride !== mode) setMode(modeOverride);
    setInput("");
    setSlash(null);
    setPlanView(null);
    // Thread updaters scoped to `a` (not the current `agent`), so streaming into
    // a backgrounded tab lands in the right conversation.
    const setMsgs = (fn: (m: Message[]) => Message[]) =>
      setThreads((t) => ({ ...t, [a]: fn(t[a]) }));

    // The onboarding command is answered locally by GTM Grid — NEVER sent to the
    // agent CLI. `/start` collides with claude/codex/cursor BUILT-IN slash commands,
    // so the CLI would intercept it ("Unknown command: /start") and our prompt would
    // never reach the model. Render the canned tour and stop here.
    if (ONBOARDING_COMMAND.test(text)) {
      setMsgs((m) => [
        ...m,
        { role: "user", text, tools: [], parts: [{ kind: "text", text }] },
        { role: "assistant", text: ONBOARDING_MESSAGE, tools: [], parts: [{ kind: "text", text: ONBOARDING_MESSAGE }] },
      ]);
      return;
    }

    setMsgs((m) => [
      ...m,
      { role: "user", text, tools: [], parts: text ? [{ kind: "text", text }] : [] },
      { role: "assistant", text: "", tools: [], parts: [], plan: effMode === "plan" },
    ]);
    setBusyByAgent((b) => ({ ...b, [a]: true }));
    const controller = new AbortController();
    abortRefs.current[a] = controller;

    const updateLast = (fn: (m: Message) => Message) =>
      setMsgs((msgs) => msgs.map((m, i) => (i === msgs.length - 1 ? fn(m) : m)));

    // Consume the one-shot "start fresh" intent for this turn. Without it, the
    // server resumes the latest native session — which is exactly what we want
    // after a Stop or app restart (no client-stored id required).
    const fresh = newChatRef.current[a];
    newChatRef.current[a] = false;

    try {
      const res = await fetch(`${API_BASE}/api/agent/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: a,
          message: text,
          model: models[a] || undefined,
          mode: effMode,
          // HITL: carry the human-approved action so the gated tool runs this turn
          // (the server threads it into the model-inaccessible MCP env).
          approval: approval || undefined,
          sessionId: sessionRef.current[a],
          newChat: fresh || undefined,
          context: activeTable || activePipeline ? {
            ...(activeTable ? { tableName: activeTable.name, columns: activeTable.columns } : {}),
            ...(activePipeline ? { pipelineId: activePipeline.id, pipelineName: activePipeline.name } : {}),
          } : undefined,
          // CLOUD context (TRI-3296): forwarded only when a cloud project is
          // active so the agent's table tools operate on Supabase; omitted in
          // local mode so the agent keeps local-SQLite behaviour.
          cloud: cloud ?? undefined,
        }),
        signal: controller.signal,
      });
      if (!res.body) throw new Error("no stream");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let sawDone = false;
      let sawEnd = false;
      let sawError = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, i).replace(/^data: /, "");
          buf = buf.slice(i + 2);
          if (!raw) continue;
          let e: any;
          try {
            e = JSON.parse(raw);
          } catch {
            continue;
          }
          if (e.type === "text") updateLast((m) => appendText(m, e.text));
          else if (e.type === "tool") {
            updateLast((m) => {
              const tools = [...m.tools, { name: e.name, input: e.input ?? {} }];
              return { ...m, tools, parts: [...m.parts, { kind: "tool", ref: tools.length - 1 }] };
            });
            onAgentEvent?.({ type: "tool", name: e.name, input: e.input ?? {} });
          }
          else if (e.type === "tool_result")
            updateLast((m) => {
              const tools = [...m.tools];
              for (let j = tools.length - 1; j >= 0; j--)
                if (tools[j].result === undefined) {
                  tools[j] = { ...tools[j], result: e.result };
                  break;
                }
              return { ...m, tools };
            });
          else if (e.type === "permission_request")
            updateLast((m) => ({
              ...m,
              permission: {
                pendingId: e.pendingId,
                tool: e.tool,
                argsHash: e.argsHash,
                mode: e.mode,
                action: e.action,
                target: e.target,
                willAffect: e.willAffect,
                estimatedCredits: e.estimatedCredits,
              },
            }));
          else if (e.type === "ask_user")
            updateLast((m) => ({ ...m, ask: { questions: e.questions ?? [] } }));
          else if (e.type === "grid") onGridChange();
          else if (e.type === "session") sessionRef.current[a] = e.sessionId;
          else if (e.type === "done") {
            sawDone = true;
            if (e.sessionId) sessionRef.current[a] = e.sessionId;
            if (e.isError) updateLast((m) => ({ ...m, error: true }));
            capture("agent_turn_completed", { agent: a, mode: effMode, outcome: e.isError ? "error" : "completed" });
          } else if (e.type === "end") {
            sawEnd = true;
            if (e.sessionId) sessionRef.current[a] = e.sessionId;
          } else if (e.type === "error") {
            sawError = true;
            updateLast((m) => appendErrorNotice(m, e.message));
          }
        }
      }
      const incomplete = incompleteStreamMessage(a, { sawDone, sawEnd, sawError });
      if (incomplete) throw new Error(incomplete);
    } catch (err) {
      if ((err as any)?.name === "AbortError") updateLast((m) => appendErrorNotice(m, "Stopped"));
      else updateLast((m) => appendErrorNotice(m, err instanceof Error ? err.message : "Stream failed"));
    } finally {
      setBusyByAgent((b) => ({ ...b, [a]: false }));
      // Only clear our own slot — a fresh turn for this agent may have already
      // installed a new controller.
      if (abortRefs.current[a] === controller) abortRefs.current[a] = null;
      onGridChange();
      // Turn over (done, error, or aborted) — clear the agent's grid presence.
      onAgentEvent?.({ type: "turn-end" });
    }
  }

  // Commands matching the slash query (empty query → all), bounded for display.
  const slashMatches = slash
    ? SLASH_COMMANDS.filter((c) => c.name.startsWith(slash.query.toLowerCase())).slice(0, 8)
    : [];

  /** Recompute the slash menu from the composer value: open only while it's a
   *  lone `/word` (no space yet), reset the cursor to the top on every keystroke. */
  function onComposerChange(v: string) {
    setInput(v);
    const m = /^\/(\w*)$/.exec(v);
    setSlash(m ? { query: m[1], index: 0 } : null);
  }

  /** Accept a command: fill `/<name> ` and keep focus so the user types the arg. */
  function acceptSlash(cmd: SlashCommand) {
    setInput(`/${cmd.name} `);
    setSlash(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  // Derive the thinking-indicator label from the live stream state.
  const lastMsg = messages[messages.length - 1];
  const runningTool = lastMsg?.tools.find((t) => t.result === undefined && t.error === undefined);
  const thinkLabel = runningTool
    ? `Running ${runningTool.name}`
    : lastMsg && lastMsg.role === "assistant" && lastMsg.text
      ? "Responding"
      : "Thinking";

  /* ── Collapsed: slim vertical rail of agent logos ── */
  if (collapsed) {
    return (
      <aside className="agent-panel collapsed">
        <div className="agent-rail">
          <div className="agent-rail-top">
            <button className="agent-rail-btn expand" title="Expand panel" onClick={() => setCollapsed(false)}>
              <IconChevronsLeft s={16} />
            </button>
          </div>
          <div className="agent-rail-sep" />
          {(["claude", "codex", "cursor"] as AgentKind[]).map((k) => (
            <button
              key={k}
              className={`agent-rail-btn tab ${status[k]?.installed ? "on" : "off"}${agent === k ? " active" : ""}`}
              title={AGENT_LABEL[k]}
              onClick={() => { setAgent(k); setCollapsed(false); }}
            >
              <span className="agent-logo-wrap">{AGENT_LOGO[k]}</span>
            </button>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside className="agent-panel">
      {onResizeStart && (
        <div className="agent-resize" onMouseDown={onResizeStart} title="Drag to resize" />
      )}
      <div className="agent-tabs">
        {(["claude", "codex", "cursor"] as AgentKind[]).map((k) => (
          <button key={k} className={`agent-tab ${agent === k ? "active" : ""}`} onClick={() => setAgent(k)}>
            <span
              className={`agent-logo-wrap ${status[k]?.installed ? "on" : "off"}`}
              title={status[k]?.installed ? `${AGENT_LABEL[k]} connected` : `${AGENT_LABEL[k]} not detected`}
            >
              {AGENT_LOGO[k]}
            </span>
            {AGENT_LABEL[k]}
          </button>
        ))}
        <span style={{ marginLeft: "auto", display: "flex", gap: 4, alignItems: "center" }}>
          {messages.length > 0 && (
            <button className="agent-clear" title="New chat" onClick={() => { if (!busy) newChat(); }}>
              New
            </button>
          )}
          <button className="agent-collapse" title="Collapse panel" onClick={() => setCollapsed(true)}>
            <IconChevronsRight s={15} />
          </button>
        </span>
      </div>

      {!ready ? (
        <div className="agent-empty">
          <div className="agent-empty-mark"><IconZap s={20} /></div>
          <div className="agent-empty-title">Connect {AGENT_LABEL[agent]}</div>
          <p>
            {agent === "cursor"
              ? "Sign in to your Cursor plan with `cursor-agent login` — gtmgrid drives the CLI you've already authed and mounts the grid's tools over MCP. No keys stored."
              : `Sign in to your ${AGENT_PLAN[agent]} plan in the ${AGENT_LABEL[agent]} CLI — gtmgrid drives the CLI you've already authed. No keys stored.`}
          </p>
          <button className="agent-connect-btn" onClick={() => connect()} disabled={connecting}>
            {connecting ? "Detecting…" : `Detect ${AGENT_LABEL[agent]}`}
          </button>

          <div className="agent-connect-divider">not found automatically?</div>
          <div className="agent-connect-manual">
            <input
              value={pathInput}
              placeholder={`Path to ${AGENT_BIN_NAME[agent]} binary`}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && pathInput.trim() && connect(pathInput.trim())}
              spellCheck={false}
            />
            <button onClick={() => connect(pathInput.trim())} disabled={connecting || !pathInput.trim()}>
              Connect
            </button>
          </div>
          <p className="agent-connect-hint">
            Find it with <code>which {AGENT_BIN_NAME[agent]}</code> in your terminal.{" "}
            {agent === "cursor" ? (
              <>
                Or install:{" "}
                <code>curl https://cursor.com/install -fsS | bash</code>, then <code>cursor-agent login</code>.
              </>
            ) : (
              <>
                Or install:{" "}
                <code>{agent === "claude" ? "npm i -g @anthropic-ai/claude-code" : "npm i -g @openai/codex"}</code>
              </>
            )}
          </p>
        </div>
      ) : (
        <>
          {messages.length === 0 ? (
            <div className="agent-empty">
              <div className="agent-empty-mark"><IconZap s={20} /></div>
              <div className="agent-empty-title">Build your grid by chat</div>
              <p>
                Chat with your already-authed <strong>{AGENT_LABEL[agent]}</strong> CLI. It drives the grid through
                gtmgrid's MCP server — watch rows fill as it runs.
              </p>
              <div className="agent-prompts">
                {PROMPTS.map((p) => (
                  <button key={p} className="agent-prompt" onClick={() => send(p)}>
                    <span className="q">›</span>{p}
                  </button>
                ))}
              </div>
              <span className="agent-plan">Using your {AGENT_PLAN[agent]} plan · {current?.version}</span>
            </div>
          ) : (
          <div className="agent-stream" ref={scrollRef}>
            {messages.map((m, mi) => {
              const isLast = mi === messages.length - 1;
              return (
                <div key={mi} className={`agent-msg ${m.role} ${m.error ? "error" : ""}`}>
                  {m.role === "assistant" && (
                    <span className="agent-role">
                      <span className="agent-role-mark">{AGENT_MARK[agent]}</span>
                      {AGENT_SHORT[agent]}
                    </span>
                  )}
                  {m.parts.map((part, pi) => {
                    if (part.kind === "tool") {
                      const t = m.tools[part.ref];
                      return t ? <ToolCall key={`t${pi}`} tool={t} running={t.result === undefined && t.error === undefined && busy && isLast} /> : null;
                    }
                    if (!part.text) return null;
                    return m.role === "assistant"
                      ? <div key={`x${pi}`} className="agent-text"><Markdown text={part.text} /></div>
                      : <div key={`x${pi}`} className="agent-text">{part.text}</div>;
                  })}
                  {m.role === "assistant" && m.plan && planBody(m).trim() !== "" && (
                    <div className="agent-plan-bar">
                      <span className="agent-plan-label">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" /><rect x="9" y="3" width="6" height="4" rx="1" /></svg>
                        Plan
                      </span>
                      <div className="agent-plan-actions">
                        <button className="agent-plan-view" onClick={() => setPlanView(planBody(m))}>View plan</button>
                        {isLast && !busy && (
                          <button className="agent-plan-approve" onClick={() => send("Approved — execute this plan now, step by step.", "bypassPermissions")}>Approve &amp; run</button>
                        )}
                      </div>
                    </div>
                  )}
                  {isLast && m.role === "assistant" && !busy && (() => {
                    // Prefer the ENFORCED permission_request (carries an approval
                    // the server unlocks); fall back to the legacy in-band confirm
                    // payload (old server with no permission_request event).
                    const p = m.permission;
                    const c = p
                      ? { action: p.action, willAffect: p.willAffect, target: p.target, estimatedCredits: p.estimatedCredits }
                      : pendingConfirm(m);
                    if (!c) return null;
                    const detail = [
                      typeof c.willAffect === "number" ? `${c.willAffect} item${c.willAffect !== 1 ? "s" : ""}` : null,
                      c.target,
                      typeof c.estimatedCredits === "number" && c.estimatedCredits > 0 ? `~${c.estimatedCredits} credits` : null,
                    ].filter(Boolean).join(" · ");
                    const modeLabel = p?.mode ? MODE_OPTIONS.find((o) => o.value === p.mode)?.label : undefined;
                    const onApprove = p
                      ? () => send("Approved — proceed.", undefined, { tool: p.tool, argsHash: p.argsHash })
                      : () => send("Approved — proceed, calling the same tool with confirm: true.");
                    const onDeny = p
                      ? () => send("Denied — do not perform that action; continue or stop.")
                      : () => send("Cancel — do NOT perform that action.");
                    return (
                      <div className="agent-confirm">
                        <div className="agent-confirm-head">
                          <strong>{c.action ?? "Confirm action"}</strong>
                          {detail && <span className="agent-confirm-detail">{detail}</span>}
                        </div>
                        {modeLabel && <div className="agent-confirm-mode">{modeLabel} mode — your approval is required</div>}
                        <div className="agent-confirm-actions">
                          <button className="agent-confirm-deny" onClick={onDeny}>Deny</button>
                          <button className="agent-confirm-approve" onClick={onApprove}>Approve</button>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              );
            })}
            {busy && (
              <div className="agent-think">
                <span className="agent-think-spark"><IconZap s={11} /></span>
                <span className="agent-think-label">{thinkLabel}</span>
                <span className="agent-think-dots"><span /><span /><span /></span>
              </div>
            )}
          </div>
          )}

          {planView !== null && (
            <aside className="plan-drawer">
              <div className="plan-drawer-head">
                <span className="plan-drawer-title">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" /><rect x="9" y="3" width="6" height="4" rx="1" /></svg>
                  Plan
                </span>
                <button className="plan-drawer-close" onClick={() => setPlanView(null)} title="Close">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
              </div>
              <div className="plan-drawer-body agent-text">
                <Markdown text={planView} />
              </div>
              {!busy && (
                <div className="plan-drawer-foot">
                  <button className="agent-plan-approve" onClick={() => send("Approved — execute this plan now, step by step.", "bypassPermissions")}>Approve &amp; run</button>
                </div>
              )}
            </aside>
          )}

          {(activePipeline || activeTable) && (
            <div className="agent-context-chip" title={activePipeline ? "The agent can inspect and edit this pipeline" : "The agent operates on this table by default"}>
              <span className="agent-context-dot" /> on <strong>{activePipeline?.name ?? activeTable?.name}</strong>
            </div>
          )}
          {pendingAsk ? (
            <AskCards
              request={pendingAsk}
              onSubmit={(answer) => {
                capture("ask_user_question_answered", { agent, questions: pendingAsk.questions.length });
                send(answer);
              }}
            />
          ) : (
          <div className="agent-input">
            {slash && slashMatches.length > 0 && (
              <div className="agent-slash-menu">
                <div className="agent-slash-head">Commands</div>
                {slashMatches.map((c, i) => (
                  <button
                    key={c.name}
                    className={`agent-slash-item${i === slash.index ? " sel" : ""}`}
                    onMouseEnter={() => setSlash((s) => (s ? { ...s, index: i } : s))}
                    onMouseDown={(e) => {
                      e.preventDefault(); // keep focus in the textarea
                      acceptSlash(c);
                    }}
                  >
                    <span className="agent-slash-name">/{c.name}</span>
                    <span className="agent-slash-arg">{c.hint}</span>
                    <span className="agent-slash-desc">{c.description}</span>
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={inputRef}
              value={input}
              placeholder={
                activePipeline || activeTable
                  ? `Message ${AGENT_LABEL[agent]} about "${activePipeline?.name ?? activeTable?.name}"… (/ for commands)`
                  : `Message ${AGENT_LABEL[agent]}… (/ for commands)`
              }
              onChange={(e) => onComposerChange(e.target.value)}
              onKeyDown={(e) => {
                // Slash menu open: arrows move the cursor, Enter/Tab accept the
                // highlighted command, Escape closes it — none of these send.
                if (slash && slashMatches.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSlash((s) => (s ? { ...s, index: (s.index + 1) % slashMatches.length } : s));
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSlash((s) => (s ? { ...s, index: (s.index - 1 + slashMatches.length) % slashMatches.length } : s));
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    acceptSlash(slashMatches[slash.index] ?? slashMatches[0]);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setSlash(null);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              disabled={busy}
            />
            {busy ? (
              <button className="agent-send agent-stop" onClick={stop} title="Stop"><IconStop s={13} /></button>
            ) : (
              <button className="agent-send" onClick={() => send()} disabled={!input.trim()}>
                <IconArrow s={15} />
              </button>
            )}
          </div>
          )}
          {/* Composer footer: chat history + model picker, both open upward. History
              is read from the agent's OWN native transcript store (sidecar). */}
          <div className="agent-composer-foot">
            <div className="agent-history-picker" ref={historyRef}>
              {showHistory && (
                <div className="agent-history">
                  <div className="agent-history-head">Recent {AGENT_LABEL[agent]} chats · this project</div>
                  {sessions === null ? (
                    <div className="agent-history-empty">Loading…</div>
                  ) : sessions.length === 0 ? (
                    <div className="agent-history-empty">No past conversations for this project yet.</div>
                  ) : (
                    sessions.map((s) => (
                      <div key={s.id} className="agent-history-row" onClick={() => openSession(s)} onKeyDown={onActivateKey(() => openSession(s))} role="button" tabIndex={0}>
                        <span className="agent-history-logo">{AGENT_LOGO[agent]}</span>
                        <span className="agent-history-title" title={s.title}>{s.title}</span>
                        <span className="agent-history-time">{relativeTime(s.updatedAt)}</span>
                      </div>
                    ))
                  )}
                </div>
              )}
              <button className="agent-model-btn" onClick={() => setShowHistory((s) => !s)} title="Chat history">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></svg>
                History
              </button>
            </div>
            <ModePicker value={mode} onChange={setMode} />
            <span style={{ marginLeft: "auto" }} />
            <ModelPicker
              agent={agent}
              value={models[agent]}
              options={agent === "codex" ? codexModelOptions : agent === "claude" ? claudeModelOptions : MODEL_OPTIONS[agent]}
              onOpen={agent === "codex" ? refreshCodexModels : agent === "claude" ? refreshClaudeModels : undefined}
              onChange={(v) => setModels((p) => ({ ...p, [agent]: v }))}
            />
          </div>
        </>
      )}
    </aside>
  );
}
