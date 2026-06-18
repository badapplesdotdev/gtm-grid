// Typed client for the gtmgrid HTTP server (the engine sidecar).
export const API_BASE = (import.meta as any).env?.VITE_API ?? "http://localhost:8787";
const BASE = API_BASE;

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
  fn: string | null;
  /** Custom QuickJS body for code columns (fn === "code"); null otherwise. */
  code?: string | null;
  params: Record<string, unknown>;
  /** Optional "only run if" expression gating per-row execution. */
  condition?: string | null;
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
  auth: { type: string; header: string | null; secretKey: string } | null;
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
  fieldOptions: (body: { provider: string; method: string; field: string; search?: string }) =>
    http<{ options?: FieldOption[]; error?: string }>("/api/options", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  generateFormula: (description: string, columns: string[], mode: "formula" | "condition" = "formula") =>
    http<{ formula?: string; error?: string }>("/api/ai/generate-formula", {
      method: "POST",
      body: JSON.stringify({ description, columns, mode }),
    }),
  connect: (extId: string, secrets: Record<string, string>, scope?: CredentialScope) =>
    http<{ ok: boolean }>(`/api/extensions/${extId}/connect`, { method: "POST", body: JSON.stringify({ secrets, scope }) }),
  agents: () =>
    http<{ claude: AgentStatus; codex: AgentStatus; hermes: AgentStatus }>("/api/agents"),
  connectAgent: (agent: "claude" | "codex" | "hermes", path?: string) =>
    http<{ claude: AgentStatus; codex: AgentStatus; hermes: AgentStatus }>("/api/agents/connect", {
      method: "POST",
      body: JSON.stringify({ agent, path }),
    }),
  // Past conversations from the CLI's OWN native transcript store (current project).
  agentSessions: (agent: "claude" | "codex") =>
    http<{ sessions: AgentSession[] }>(`/api/agent/sessions/${agent}`),
  agentSession: (agent: "claude" | "codex", id: string) =>
    http<{ messages: AgentHistoryMessage[] }>(`/api/agent/sessions/${agent}/${encodeURIComponent(id)}`),
};

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
