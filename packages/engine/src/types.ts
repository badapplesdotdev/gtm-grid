// Shared domain types for the gtmgrid engine.

export type ColumnType = "text" | "number" | "boolean" | "date" | "json";
export type ColumnKind = "manual" | "function";
export type CellStatus = "empty" | "pending" | "running" | "done" | "error";
export type CredentialScope = "local" | "personal" | "team";

export interface Table {
  id: string;
  name: string;
  position: number;
  created_at: number;
}

export interface Column {
  id: string;
  table_id: string;
  name: string;
  type: ColumnType;
  kind: ColumnKind;
  /** Connector provider for a function column, e.g. "ai" or "apollo". */
  provider: string | null;
  /** Connector method, e.g. "generate" or "enrichPerson". */
  method: string | null;
  /** JS body executed inside the QuickJS sandbox: `async function(inputs, sdk) { ... }`. */
  code: string | null;
  /** Input mapping. String values are templated with {{Column Name}} against the row. */
  params: Record<string, unknown>;
  position: number;
  created_at: number;
}

export interface Row {
  id: string;
  table_id: string;
  position: number;
  created_at: number;
}

export interface Cell {
  row_id: string;
  column_id: string;
  value: unknown;
  status: CellStatus;
  error: string | null;
  updated_at: number | null;
}

export interface Credential {
  id: string;
  extension_id: string;
  scope: CredentialScope;
  name: string;
  /** Decrypted secret map, e.g. { apiKey: "..." }. Never persisted in plaintext. */
  secrets: Record<string, string>;
  created_at: number;
}

/** A single callable method on a connector — the unit that becomes a column, an sdk call, and an MCP tool. */
export interface ConnectorMethod {
  id: string; // e.g. "generate"
  label: string; // e.g. "AI Generate"
  description: string; // agent-readable
  /** JSON Schema for inputs (derived from zod via zod-to-json-schema). */
  inputSchema: Record<string, unknown>;
  batchSize: number;
  credits: number;
  /** Executes the method host-side. Receives validated inputs + a resolved credential (if any). */
  run: (inputs: Record<string, unknown>, ctx: MethodContext) => Promise<unknown>;
}

export interface MethodContext {
  secrets: Record<string, string>;
  /** AI provider config resolved from connected AI providers. */
  ai?: AiConfig;
}

export interface AiConfig {
  provider: "anthropic" | "openai";
  apiKey: string;
  model: string;
}

export interface Connector {
  id: string; // e.g. "ai", "apollo"
  name: string;
  category: string;
  /** Auth requirement; null for built-ins like AI that read from AI provider config. */
  auth: { type: "apiKey"; header?: string; query?: string } | null;
  methods: ConnectorMethod[];
}
