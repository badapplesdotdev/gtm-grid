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

export interface TableSummary {
  id: string;
  name: string;
  columns: number;
  rows: number;
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
}
export interface ConnectorInfo {
  provider: string;
  name: string;
  category: string;
  requiresCredential: boolean;
  methods: FunctionMethod[];
}
export interface ExtensionInfo {
  id: string;
  name: string;
  category: string;
  methods: number;
  connected: boolean;
}

export const api = {
  health: () => http<{ ok: boolean; project: string }>("/api/health"),
  functions: () => http<ConnectorInfo[]>("/api/functions"),
  extensions: () => http<ExtensionInfo[]>("/api/extensions"),
  tables: () => http<TableSummary[]>("/api/tables"),
  createTable: (name: string) => http<TableSummary>("/api/tables", { method: "POST", body: JSON.stringify({ name }) }),
  table: (id: string) => http<FullTable>(`/api/tables/${id}`),
  addColumn: (
    tableId: string,
    body: { name: string; type?: string; fn?: string; code?: string; params?: Record<string, unknown> },
  ) => http<{ id: string }>(`/api/tables/${tableId}/columns`, { method: "POST", body: JSON.stringify(body) }),
  addRow: (tableId: string, cells?: Record<string, unknown>) =>
    http<{ id: string }>(`/api/tables/${tableId}/rows`, { method: "POST", body: JSON.stringify({ cells }) }),
  setCell: (rowId: string, columnId: string, value: unknown) =>
    http<{ ok: boolean }>("/api/cells", { method: "POST", body: JSON.stringify({ rowId, columnId, value }) }),
  runColumn: (columnId: string, force = false) =>
    http<{ ran: number; errors: number }>(`/api/columns/${columnId}/run`, {
      method: "POST",
      body: JSON.stringify({ force }),
    }),
  updateColumn: (
    columnId: string,
    patch: { name?: string; type?: string; kind?: string; provider?: string | null; method?: string | null; code?: string | null; params?: Record<string, unknown> },
  ) => http<{ ok: boolean; tableId?: string; id?: string }>(`/api/columns/${columnId}/update`, { method: "POST", body: JSON.stringify(patch) }),
  connect: (extId: string, secrets: Record<string, string>) =>
    http<{ ok: boolean }>(`/api/extensions/${extId}/connect`, { method: "POST", body: JSON.stringify({ secrets }) }),
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
