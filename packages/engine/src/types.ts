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
  /** Output value type — surfaced in the function detail ("outputs json"). Default "text". */
  output?: "text" | "json" | "number" | "boolean";
  /** Optional human-readable source (shown in the function detail's Details tab). */
  source?: string;
  /** Executes the method host-side. Receives validated inputs + a resolved credential (if any). */
  run: (inputs: Record<string, unknown>, ctx: MethodContext) => Promise<unknown>;
  /**
   * Optional batched execution. When `batchSize > 1` the engine groups rows into
   * chunks of `batchSize` and calls this ONCE per chunk with the ordered batch of
   * per-row inputs, expecting an array of results in the SAME order (one per
   * input row). Defining this lets a connector collapse N per-row lookups into one
   * bulk external call. Methods that omit it always run per-row (`batchSize` is
   * effectively 1), preserving the unbatched contract.
   */
  runBatch?: (
    inputs: Record<string, unknown>[],
    ctx: MethodContext,
  ) => Promise<unknown[]>;
}

export interface MethodContext {
  secrets: Record<string, string>;
  /** Default/active AI provider config resolved from connected AI providers. */
  ai?: AiConfig;
  /** All connected AI providers — lets a method route by the requested model. */
  aiProviders?: AiConfig[];
  /**
   * Enforce the SSRF guard on this method's outbound HTTP — set ONLY when the
   * connector runs on shared server infrastructure (the Vercel enrichment worker),
   * where an attacker-supplied manifest `baseUrl` could otherwise reach internal/
   * link-local addresses. Local (sidecar) runs leave it unset: the call runs on the
   * user's own machine/network, so a self-hosted localhost/LAN connector is fine.
   */
  guardSsrf?: boolean;
}

export interface AiConfig {
  provider: "anthropic" | "openai" | "openrouter" | "hermes";
  apiKey: string;
  model: string;
  /** OpenAI-compatible base URL. Used by providers that aren't a fixed cloud
   *  endpoint — e.g. `hermes` (a local/LAN gateway). Anthropic ignores it;
   *  openrouter hardcodes its own. */
  baseURL?: string;
}

export interface Connector {
  id: string; // e.g. "ai", "apollo"
  name: string;
  category: string;
  /** Auth requirement; null for built-ins like AI that read from AI provider config. */
  auth: { type: "apiKey"; header?: string; query?: string } | null;
  methods: ConnectorMethod[];
}
