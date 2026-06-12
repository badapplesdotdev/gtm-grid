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

/** A per-cell progress event streamed from the local run SSE endpoint. */
export interface CellProgressEvent {
  rowId: string;
  columnId: string;
  cell: Cell;
}

/**
 * Run a function column on the LOCAL project, consuming the sidecar's SSE
 * progress stream and invoking `onCell` for each cell as it completes (running →
 * done/error). Resolves with the run summary once the stream's `done` event
 * arrives. The desktop uses this to patch only the changed cells in place
 * instead of refetching+replacing the whole grid after the run.
 */
async function runColumnStream(
  path: string,
  body: unknown,
  onCell: (e: CellProgressEvent) => void,
): Promise<{ ran: number; errors: number }> {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let summary = { ran: 0, errors: 0 };
  let streamError: string | null = null;

  const handle = (json: string) => {
    let evt: { type?: string; rowId?: string; columnId?: string; cell?: Cell; ran?: number; errors?: number; error?: string };
    try { evt = JSON.parse(json); } catch { return; }
    if (evt.type === "cell" && evt.rowId && evt.columnId && evt.cell) {
      onCell({ rowId: evt.rowId, columnId: evt.columnId, cell: evt.cell });
    } else if (evt.type === "done") {
      summary = { ran: evt.ran ?? 0, errors: evt.errors ?? 0 };
    } else if (evt.type === "error") {
      streamError = evt.error ?? "run failed";
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    // SSE frames are separated by a blank line; each `data: <json>` line is one event.
    while ((nl = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) handle(line.slice(5).trim());
      }
    }
  }
  if (streamError) throw new Error(streamError);
  return summary;
}

/**
 * An HTTP error from a cloud push (TRI-3295's `/api/cloud/tables/push`) carrying
 * the status + typed error code, so the UI can detect a 409 LinkConflictError
 * (overwrite-needs-confirmation) and route into the destructive-overwrite confirm
 * instead of treating it as a generic failure.
 */
export class CloudPushHttpError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "CloudPushHttpError";
    this.status = status;
    this.code = code;
  }
}

/** What a single table push did to the cloud project (mirrors the engine's PushResult). */
export type PushOutcome = "created" | "overwritten";
/** The structured result of a successful push (mirrors the engine's PushResult). */
export interface PushTableResult {
  outcome: PushOutcome;
  cloudTableId: string;
  rowCount: number;
  columnCount: number;
}
/** Inputs the desktop must supply to the sidecar push route. */
export interface PushTableArgs {
  apiUrl: string;
  token: string;
  projectId: string;
  localTableId: string;
  confirmOverwrite?: boolean;
}

/**
 * Push the named LOCAL table to the active cloud project via the sidecar's
 * TRI-3295 route. Resolves the structured {@link PushTableResult} on 200, and
 * throws a {@link CloudPushHttpError} (carrying status + code) otherwise — a 409
 * means the server demands explicit overwrite confirmation.
 */
async function pushTable(args: PushTableArgs): Promise<PushTableResult> {
  const res = await fetch(BASE + "/api/cloud/tables/push", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      apiUrl: args.apiUrl,
      token: args.token,
      projectId: args.projectId,
      localTableId: args.localTableId,
      confirmOverwrite: args.confirmOverwrite ?? false,
    }),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string | null;
    };
    throw new CloudPushHttpError(
      payload.error ?? res.statusText,
      res.status,
      payload.code ?? null,
    );
  }
  return res.json();
}

export type CellStatus = "empty" | "pending" | "running" | "done" | "error";

export interface ProjectInfo {
  name: string;
  path: string;
  mtimeMs: number;
  current: boolean;
}
export interface TableSummary {
  id: string;
  name: string;
  columns: number;
  rows: number;
  favorite: boolean;
  /** Sort position within the sidebar list (fractional after drag-reorders). */
  position: number;
  /** Sidebar folder this table is filed under (null = root). */
  folderId: string | null;
}
/** A sidebar folder grouping tables (local project; mirrors engine `Folder`). */
export interface FolderSummary {
  id: string;
  name: string;
  position: number;
  created_at: number;
}
export interface Column {
  id: string;
  name: string;
  type: string;
  kind: "manual" | "function";
  provider: string | null;
  method: string | null;
  fn: string | null;
  params: Record<string, unknown>;
  /** Optional "only run if" expression gating per-row execution. */
  condition?: string | null;
}
export interface Cell {
  value: unknown;
  status: CellStatus;
  error: string | null;
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
export interface FunctionMethod {
  method: string;
  label: string;
  description: string;
  credits: number;
  input?: Record<string, unknown> | null;
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
export interface SignalSourcesResponse {
  trigifyConnected: boolean;
  sources: SignalSource[];
}
export interface SignalBinding {
  id: string;
  tableId: string;
  provider: "trigify";
  sourceId: string;
  label: string;
  kind: string;
  searchId: string | null;
  config: Record<string, unknown>;
  schedule: "manual" | "hourly" | "daily" | "weekly";
  columns: SignalColumn[];
  lastSyncedAt: number | null;
  lastError: string | null;
  rowsPulled: number;
  enabled: boolean;
  createdAt: number;
}
export interface CreateSignalResult {
  tableId?: string;
  bindingId?: string;
  searchId?: string | null;
  added?: number;
  error?: string | null;
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
  signalSources: () => http<SignalSourcesResponse>("/api/signals/sources"),
  signals: () => http<SignalBinding[]>("/api/signals"),
  createSignal: (body: { sourceId: string; name: string; config: Record<string, unknown>; schedule: string }) =>
    http<CreateSignalResult>("/api/signals", { method: "POST", body: JSON.stringify(body) }),
  syncSignal: (id: string) => http<{ ok: boolean; added: number; error: string | null }>(`/api/signals/${id}/sync`, { method: "POST" }),
  toggleSignal: (id: string, enabled: boolean) =>
    http<{ ok: boolean; enabled: boolean }>(`/api/signals/${id}/toggle`, { method: "POST", body: JSON.stringify({ enabled }) }),
  deleteSignal: (id: string) => http<{ ok: boolean }>(`/api/signals/${id}`, { method: "DELETE" }),
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
  projects: () => http<ProjectInfo[]>("/api/projects"),
  createProject: (name: string) =>
    http<{ ok: boolean; project: string }>("/api/projects", { method: "POST", body: JSON.stringify({ name }) }),
  switchProject: (name: string) =>
    http<{ ok: boolean; project: string }>("/api/projects/switch", { method: "POST", body: JSON.stringify({ name }) }),
  tables: () => http<TableSummary[]>("/api/tables"),
  createTable: (name: string, folderId?: string | null) =>
    http<TableSummary>("/api/tables", { method: "POST", body: JSON.stringify({ name, folderId: folderId ?? null }) }),
  table: (id: string) => http<FullTable>(`/api/tables/${id}`),
  moveTable: (id: string, folderId: string | null, position?: number) =>
    http<{ ok: boolean }>(`/api/tables/${id}/move`, { method: "POST", body: JSON.stringify({ folderId, position }) }),
  folders: () => http<FolderSummary[]>("/api/folders"),
  createFolder: (name: string) =>
    http<FolderSummary>("/api/folders", { method: "POST", body: JSON.stringify({ name }) }),
  renameFolder: (id: string, name: string) =>
    http<{ ok: boolean }>(`/api/folders/${id}/update`, { method: "POST", body: JSON.stringify({ name }) }),
  deleteFolder: (id: string) => http<{ ok: boolean }>(`/api/folders/${id}/delete`, { method: "POST" }),
  renameTable: (id: string, name: string) =>
    http<{ ok: boolean }>(`/api/tables/${id}/update`, { method: "POST", body: JSON.stringify({ name }) }),
  deleteTable: (id: string) => http<{ ok: boolean }>(`/api/tables/${id}/delete`, { method: "POST" }),
  favoriteTable: (id: string, favorite: boolean) =>
    http<{ ok: boolean; favorite: boolean }>(`/api/tables/${id}/favorite`, { method: "POST", body: JSON.stringify({ favorite }) }),
  // Deduplication: set the key column + keep mode (column:null to disable). Enabling
  // also sweeps existing duplicates; returns how many were removed.
  setDedupe: (id: string, body: { column: string | null; keep?: "oldest" | "newest" }) =>
    http<{ dedupe: { column: string; keep: string } | null; deleted: number }>(`/api/tables/${id}/dedupe-config`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  dedupeTable: (id: string) =>
    http<{ deleted: number }>(`/api/tables/${id}/dedupe`, { method: "POST" }),
  addColumn: (
    tableId: string,
    body: { name: string; type?: string; fn?: string; code?: string; params?: Record<string, unknown>; condition?: string | null },
  ) => http<{ id: string }>(`/api/tables/${tableId}/columns`, { method: "POST", body: JSON.stringify(body) }),
  addRow: (tableId: string, cells?: Record<string, unknown>) =>
    http<{ id: string }>(`/api/tables/${tableId}/rows`, { method: "POST", body: JSON.stringify({ cells }) }),
  addRowsBulk: (tableId: string, rows: Array<Record<string, unknown>>) =>
    http<{ rowIds: string[] }>(`/api/tables/${tableId}/rows/bulk`, { method: "POST", body: JSON.stringify({ rows }) }),
  setCell: (rowId: string, columnId: string, value: unknown) =>
    http<{ ok: boolean }>("/api/cells", { method: "POST", body: JSON.stringify({ rowId, columnId, value }) }),
  runColumn: (columnId: string, opts: { force?: boolean; rowIds?: string[] } = {}) =>
    http<{ ran: number; errors: number }>(`/api/columns/${columnId}/run`, {
      method: "POST",
      body: JSON.stringify({ force: opts.force ?? false, rowIds: opts.rowIds }),
    }),
  // "Try on N rows": dry-run an unsaved function column against the first `limit`
  // rows; returns per-row results without persisting anything.
  previewFunction: (
    tableId: string,
    body: { provider: string; method: string; params: Record<string, unknown>; limit?: number },
  ) =>
    http<{ results: Array<{ rowId: string; value?: unknown; error?: string }> }>(
      `/api/tables/${tableId}/preview-function`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  // Streaming run: emits per-cell progress (SSE) so the UI patches changed cells
  // as they complete, with no full-grid refetch afterwards. LOCAL projects only.
  runColumnStream: (
    columnId: string,
    onCell: (e: CellProgressEvent) => void,
    opts: { force?: boolean; rowIds?: string[] } = {},
  ) =>
    runColumnStream(
      `/api/columns/${columnId}/run/stream`,
      { force: opts.force ?? false, rowIds: opts.rowIds },
      onCell,
    ),
  updateColumn: (
    columnId: string,
    patch: { name?: string; type?: string; kind?: string; provider?: string | null; method?: string | null; code?: string | null; params?: Record<string, unknown>; condition?: string | null },
  ) => http<{ ok: boolean; tableId?: string; id?: string }>(`/api/columns/${columnId}/update`, { method: "POST", body: JSON.stringify(patch) }),
  generateFormula: (description: string, columns: string[], mode: "formula" | "condition" = "formula") =>
    http<{ formula?: string; error?: string }>("/api/ai/generate-formula", {
      method: "POST",
      body: JSON.stringify({ description, columns, mode }),
    }),
  deleteColumn: (columnId: string) => http<{ ok: boolean }>(`/api/columns/${columnId}/delete`, { method: "POST" }),
  deleteRow: (rowId: string) => http<{ ok: boolean }>(`/api/rows/${rowId}/delete`, { method: "POST" }),
  clearCell: (rowId: string, columnId: string) =>
    http<{ ok: boolean }>("/api/cells/delete", { method: "POST", body: JSON.stringify({ rowId, columnId }) }),
  connect: (extId: string, secrets: Record<string, string>, scope?: CredentialScope) =>
    http<{ ok: boolean }>(`/api/extensions/${extId}/connect`, { method: "POST", body: JSON.stringify({ secrets, scope }) }),
  // Local→cloud one-way table push (TRI-3295). Throws CloudPushHttpError on a
  // non-2xx (409 = overwrite-needs-confirmation) so the UI can warn before a
  // destructive re-push.
  pushTable,
  // Server-backed sync links (TRI-3311): the authoritative `{ [localTableId]:
  // cloudTableId }` map from the CURRENT project's SQLite meta. The desktop
  // hydrates its synced-table status from this on load / project change instead
  // of the (drift-prone) localStorage mirror — server wins on conflict.
  cloudTableLinks: () => http<Record<string, string>>("/api/cloud/tables/links"),
  // Auto-sync global setting (TRI-3298). Default OFF; reads/writes the global
  // meta flag via the sidecar. Enabling is gated behind a confirm in the UI.
  getAutoSync: () => http<{ enabled: boolean }>("/api/settings/auto-sync"),
  setAutoSync: (enabled: boolean) =>
    http<{ ok: boolean; enabled: boolean }>("/api/settings/auto-sync", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
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
