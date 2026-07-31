// Typed client for the gtmgrid HTTP server (the engine sidecar).
// Default to 127.0.0.1 (NOT "localhost"): the sidecar binds IPv4 loopback only
// (server listens on 127.0.0.1), and on Windows "localhost" resolves to ::1
// (IPv6) first — so a "localhost" fetch hits [::1]:8787 where nothing listens and
// the engine reads as unreachable, even though the server is up. 127.0.0.1 is
// deterministic across platforms. (macOS resolved localhost→127.0.0.1, which is
// why this only bit Windows.)
export const API_BASE = (import.meta as any).env?.VITE_API ?? "http://127.0.0.1:8787";
const BASE = API_BASE;

import { getStoredAuthToken } from "./cloud/client";

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}

export type CellStatus = "empty" | "pending" | "running" | "done" | "error";
export interface Column {
  id: string;
  name: string;
  type: string;
  kind: "manual" | "function";
  provider: string | null;
  method: string | null;
  /**
   * Which account on the provider this column runs against — a Slack team id
   * when the workspace has connected several. Null/absent = the workspace's
   * only account on this connector, which is every other connector and every
   * column authored before multi-team Slack.
   */
  accountId?: string | null;
  fn: string | null;
  /** Custom QuickJS body for code columns (fn === "code"); null otherwise. */
  code?: string | null;
  params: Record<string, unknown>;
  /** Optional "only run if" expression gating per-row execution. */
  condition?: string | null;
  /**
   * Optional behaviour flags. CRM-synced columns carry
   * `{ synced: true, crmBindingId, attrSlug, attrType }` — the desktop reads
   * `synced` to render them read-only (updated automatically by the CRM sync).
   */
  config?: unknown;
}
/**
 * Whether a column is filled by a CRM sync (its `config.synced` flag is set).
 * Such columns are READ-ONLY in the grid — the sync owns their values, so inline
 * editing is blocked (see CellContent / GridCell). User columns return false.
 */
export function isSyncedColumn(col: Pick<Column, "config">): boolean {
  const c = col.config;
  return !!c && typeof c === "object" && (c as { synced?: unknown }).synced === true;
}
export interface Cell {
  value: unknown;
  status: CellStatus;
  error: string | null;
  /** When a run last wrote this cell (ms epoch); absent for cloud/manual cells. */
  ranAt?: number | null;
  /** Wall-clock duration of that run (ms). */
  runMs?: number | null;
}
export interface Row {
  id: string;
  cells: Record<string, Cell>;
}
export interface FullTable {
  id: string;
  name: string;
  columns: Column[];
  rows: Row[];
  dedupe?: { column: string; keep: "oldest" | "newest" } | null;
  /**
   * Auto-run policy (workspace-shared, persisted on the table). When off, a
   * BILLED function column is not re-run just because an upstream input changed
   * — the user presses play. Absent ⇒ on, the historical behaviour.
   */
  autoRun?: boolean;
}
/** A field whose value is picked from a live connector list (name → id). */
export interface FieldOptionSource {
  method: string;
  itemsPath?: string;
  labelKey?: string;
  valueKey?: string;
  sublabelKey?: string;
  args?: Record<string, unknown>;
}
/** One resolved choice for a pick-field dropdown. */
export interface FieldOption {
  label: string;
  value: string;
  sublabel?: string;
}
export interface FunctionMethod {
  method: string;
  label: string;
  description: string;
  /** Explicit gallery category for this method (null → listed under "All" only). */
  category?: string | null;
  credits: number;
  input?: Record<string, unknown> | null;
  /** Fields rendered as a live name-picker (field id → its option source). */
  options?: Record<string, FieldOptionSource> | null;
  source?: string | null;
  batchSize?: number;
  output?: string;
}
export interface ConnectorInfo {
  provider: string;
  name: string;
  category: string;
  requiresCredential: boolean;
  logo?: string | null;
  methods: FunctionMethod[];
}
export interface ExtensionInfo {
  id: string;
  name: string;
  category: string;
  description: string | null;
  featured: boolean;
  methods: number;
  connected: boolean;
  logo: string | null;
}
export interface ExtensionMethodDetail {
  id: string;
  label: string;
  description: string;
  credits: number;
  verb: string | null;
  path: string | null;
}
export type CredentialScope = "personal" | "team" | "local";
export interface ExtensionDetail {
  id: string;
  name: string;
  category: string;
  description: string | null;
  version: string | null;
  baseUrl: string | null;
  logo: string | null;
  auth: { type: string; header: string | null; secretKey: string; credentialLabel?: string } | null;
  connected: boolean;
  connectedScopes: CredentialScope[];
  methods: ExtensionMethodDetail[];
}
export interface AiProviderInfo {
  id: string;
  name: string;
  description: string;
  logo: string | null;
  models: string[];
  connected: boolean;
  viaEnv: boolean;
  /** Resolved base URL for OpenAI-compatible gateways (hermes); null otherwise. */
  baseUrl?: string | null;
  connectedScopes: CredentialScope[];
}
export interface SkillInfo {
  id: string;
  name: string;
  category: string;
  description: string | null;
  source: "tool" | "custom";
  connected: boolean;
  wordCount: number;
  logo: string | null;
  enabled: boolean;
}
export interface SkillDetail extends SkillInfo {
  body: string;
}
export interface SignalColumn { key: string; name: string; }
export interface SignalSource {
  id: string;
  label: string;
  group: string;
  kind: "search" | "profileEngagement";
  description: string;
  columns: SignalColumn[];
  inputSchema: { type?: string; required?: string[]; properties?: Record<string, any> } | null;
}

export const api = {
  health: () => http<{ ok: boolean; project: string }>("/api/health"),
  functions: () => http<ConnectorInfo[]>("/api/functions"),
  extensions: () => http<ExtensionInfo[]>("/api/extensions"),
  extension: (id: string) => http<ExtensionDetail>(`/api/extensions/${id}`),
  skills: () => http<SkillInfo[]>("/api/skills"),
  skill: (id: string) => http<SkillDetail>(`/api/skills/${id}`),
  saveSkill: (body: { id?: string; name: string; description?: string; body: string; enabled?: boolean }) =>
    http<{ ok: boolean; id: string }>("/api/skills", { method: "POST", body: JSON.stringify(body) }),
  toggleSkill: (id: string, enabled: boolean) =>
    http<{ ok: boolean; enabled: boolean }>(`/api/skills/${id}/toggle`, { method: "POST", body: JSON.stringify({ enabled }) }),
  deleteSkill: (id: string) => http<{ ok: boolean }>(`/api/skills/${id}`, { method: "DELETE" }),
  aiProviders: () => http<AiProviderInfo[]>("/api/ai-providers"),
  connectAiProvider: (
    id: string,
    body: { apiKey?: string; baseURL?: string; scope?: CredentialScope },
  ) => http<{ ok: boolean }>(`/api/ai-providers/${id}/connect`, { method: "POST", body: JSON.stringify(body) }),
  /**
   * Copy a LOCAL connector/AI key up to the shared CLOUD (workspace) key. The
   * sidecar decrypts the local key in-process and posts the plaintext to the
   * cloud over TLS (member-authenticated) — the plaintext never reaches the
   * renderer. Throws (so the panel can surface it) when no local key exists or
   * the cloud save fails. `credId` is the local credential id; `extensionId` the
   * shared cloud key id (identical in practice: `ai:<id>` for AI providers, the
   * extension id for connectors).
   */
  copyLocalKeyToCloud: async (body: {
    credId: string;
    extensionId: string;
    name: string;
    apiUrl: string;
    token: string;
    workspaceId: string;
  }): Promise<void> => {
    const r = await http<{ ok?: boolean; error?: string }>(
      "/api/credentials/copy-to-cloud",
      { method: "POST", body: JSON.stringify(body) },
    );
    if (r.error || !r.ok) throw new Error(r.error ?? "Failed to copy local key");
  },
  // Live options for a pick-field: resolves the field's declared option source
  // (e.g. listCampaigns) using the connector's stored key and returns the
  // name→id choices for the column-editor dropdown. `search` filters server-side
  // when the source endpoint supports it.
  // CLOUD-AWARE. When `tableId` names a cloud table AND a signed-in session
  // exists, the apps/web url + bearer token ride along so the sidecar resolves
  // the option source with the WORKSPACE credential (Postgres) instead of the
  // local SQLite one. Both are read here rather than threaded through React:
  // `getStoredAuthToken` is a module accessor and VITE_API_URL is build-time, so
  // the picker needs no new props beyond the table it belongs to.
  //
  // Omitting them (local project, or signed out) leaves the server on its
  // existing local-credential path — this widens behaviour, it does not change
  // the local one.
  fieldOptions: (body: { provider: string; method: string; field: string; search?: string; values?: Record<string, string>; tableId?: string }) => {
    const apiUrl = ((import.meta as any).env?.VITE_API_URL as string | undefined) ?? "";
    const token = getStoredAuthToken();
    const cloud =
      body.tableId && apiUrl !== "" && token
        ? { apiUrl, token, tableId: body.tableId }
        : {};
    return http<{ options?: FieldOption[]; error?: string }>("/api/options", {
      method: "POST",
      body: JSON.stringify({ ...body, ...cloud }),
    });
  },
  generateFormula: (description: string, columns: string[], mode: "formula" | "condition" = "formula") =>
    http<{ formula?: string; error?: string }>("/api/ai/generate-formula", {
      method: "POST",
      body: JSON.stringify({ description, columns, mode }),
    }),
  connect: (extId: string, secrets: Record<string, string>, scope?: CredentialScope) =>
    http<{ ok: boolean }>(`/api/extensions/${extId}/connect`, { method: "POST", body: JSON.stringify({ secrets, scope }) }),
  agents: () =>
    http<{ claude: AgentStatus; codex: AgentStatus; cursor: AgentStatus }>("/api/agents"),
  agentModels: (agent: "codex") =>
    http<AgentModelsResponse>(`/api/agent/models/${agent}`),
  connectAgent: (agent: "claude" | "codex" | "cursor", path?: string) =>
    http<{ claude: AgentStatus; codex: AgentStatus; cursor: AgentStatus }>("/api/agents/connect", {
      method: "POST",
      body: JSON.stringify({ agent, path }),
    }),
  // Past conversations from the CLI's OWN native transcript store (current project).
  agentSessions: (agent: "claude" | "codex") =>
    http<{ sessions: AgentSession[] }>(`/api/agent/sessions/${agent}`),
  agentSession: (agent: "claude" | "codex", id: string) =>
    http<{ messages: AgentHistoryMessage[] }>(`/api/agent/sessions/${agent}/${encodeURIComponent(id)}`),
};

export interface AgentModelOption {
  value: string;
  label: string;
}

export interface AgentModelsResponse {
  models: AgentModelOption[];
  defaultModel?: string;
  source: "cache" | "default";
  fetchedAt?: string;
}

/** A past conversation summary (from the agent's native transcript store). */
export interface AgentSession {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}
/** One parsed turn from a native transcript. */
export interface AgentHistoryMessage {
  role: "user" | "assistant";
  text: string;
  tools: { name: string; input: Record<string, unknown>; result?: string }[];
}

export interface AgentStatus {
  installed: boolean;
  version: string | null;
  path?: string | null;
}
