// Typed client for the gtmgrid HTTP server (the engine sidecar).
export const API_BASE = (import.meta as any).env?.VITE_API ?? "http://localhost:8787";
const BASE = API_BASE;

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
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
  connectedScopes: CredentialScope[];
}

export const api = {
  health: () => http<{ ok: boolean; project: string }>("/api/health"),
  functions: () => http<ConnectorInfo[]>("/api/functions"),
  extensions: () => http<ExtensionInfo[]>("/api/extensions"),
  extension: (id: string) => http<ExtensionDetail>(`/api/extensions/${id}`),
  aiProviders: () => http<AiProviderInfo[]>("/api/ai-providers"),
  connectAiProvider: (id: string, body: { apiKey: string; scope?: CredentialScope }) =>
    http<{ ok: boolean }>(`/api/ai-providers/${id}/connect`, { method: "POST", body: JSON.stringify(body) }),
  projects: () => http<ProjectInfo[]>("/api/projects"),
  createProject: (name: string) =>
    http<{ ok: boolean; project: string }>("/api/projects", { method: "POST", body: JSON.stringify({ name }) }),
  switchProject: (name: string) =>
    http<{ ok: boolean; project: string }>("/api/projects/switch", { method: "POST", body: JSON.stringify({ name }) }),
  tables: () => http<TableSummary[]>("/api/tables"),
  createTable: (name: string) => http<TableSummary>("/api/tables", { method: "POST", body: JSON.stringify({ name }) }),
  table: (id: string) => http<FullTable>(`/api/tables/${id}`),
  renameTable: (id: string, name: string) =>
    http<{ ok: boolean }>(`/api/tables/${id}/update`, { method: "POST", body: JSON.stringify({ name }) }),
  deleteTable: (id: string) => http<{ ok: boolean }>(`/api/tables/${id}/delete`, { method: "POST" }),
  favoriteTable: (id: string, favorite: boolean) =>
    http<{ ok: boolean; favorite: boolean }>(`/api/tables/${id}/favorite`, { method: "POST", body: JSON.stringify({ favorite }) }),
  addColumn: (
    tableId: string,
    body: { name: string; type?: string; fn?: string; code?: string; params?: Record<string, unknown> },
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
  updateColumn: (
    columnId: string,
    patch: { name?: string; type?: string; kind?: string; provider?: string | null; method?: string | null; code?: string | null; params?: Record<string, unknown> },
  ) => http<{ ok: boolean; tableId?: string; id?: string }>(`/api/columns/${columnId}/update`, { method: "POST", body: JSON.stringify(patch) }),
  deleteColumn: (columnId: string) => http<{ ok: boolean }>(`/api/columns/${columnId}/delete`, { method: "POST" }),
  deleteRow: (rowId: string) => http<{ ok: boolean }>(`/api/rows/${rowId}/delete`, { method: "POST" }),
  clearCell: (rowId: string, columnId: string) =>
    http<{ ok: boolean }>("/api/cells/delete", { method: "POST", body: JSON.stringify({ rowId, columnId }) }),
  connect: (extId: string, secrets: Record<string, string>, scope?: CredentialScope) =>
    http<{ ok: boolean }>(`/api/extensions/${extId}/connect`, { method: "POST", body: JSON.stringify({ secrets, scope }) }),
  agents: () =>
    http<{ claude: AgentStatus; codex: AgentStatus }>("/api/agents"),
  connectAgent: (agent: "claude" | "codex", path?: string) =>
    http<{ claude: AgentStatus; codex: AgentStatus }>("/api/agents/connect", {
      method: "POST",
      body: JSON.stringify({ agent, path }),
    }),
};

export interface AgentStatus {
  installed: boolean;
  version: string | null;
  path?: string | null;
}
