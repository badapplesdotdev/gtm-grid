// Shared domain types for the gtmgrid engine.

import type { TableGateway } from "./table-gateway.js";

export type ColumnType = "text" | "number" | "boolean" | "date" | "json";
export type ColumnKind = "manual" | "function";
export type CellStatus = "empty" | "pending" | "running" | "done" | "error";
export type CredentialScope = "local" | "personal" | "team";

export interface Table {
  id: string;
  name: string;
  position: number;
  created_at: number;
  /** Column id to deduplicate rows on (null/absent = dedup off). */
  dedupe_column?: string | null;
  /** Which row survives a duplicate: "oldest" (default) keeps the first, "newest" keeps the last. */
  dedupe_keep?: "oldest" | "newest" | null;
  /** Sidebar folder this table is filed under (null/absent = root). */
  folder_id?: string | null;
}

/** A sidebar folder grouping tables (organizational only — no data nesting). */
export interface Folder {
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
  /**
   * Optional "only run if" expression — a JS boolean expression (with {{Column Name}}
   * references) evaluated per row before the column runs. When it is falsy the row is
   * skipped (no dispatch, no credits). Null/empty means always run.
   */
  condition: string | null;
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
  /** When a RUN last wrote this cell (ms epoch); null for manual edits.
   *  Optional so non-SQLite stores (cloud) need not supply it. */
  ran_at?: number | null;
  /** Wall-clock duration of that run for this cell (ms). */
  run_ms?: number | null;
  /** The raw pre-`simplify` response of that run, when it differs from
   *  `value` (size-capped). Audit trail for "what did the tool return". */
  raw?: unknown;
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

/**
 * Declares that an input field's value should be PICKED from a live list the
 * connector itself can fetch — e.g. an Instantly `campaign` UUID picked by
 * campaign NAME, resolved from `listCampaigns`. The UI renders a searchable
 * dropdown (labels shown, value stored) instead of forcing a hand-pasted id.
 */
export interface FieldOptionSource {
  /** A method id ON THE SAME CONNECTOR that returns the list of choices. */
  method: string;
  /** Dot-path to the array inside the source response (e.g. "items", "data.campaigns").
   *  Absent → a sensible fallback chain (response itself if an array, else items/data/results). */
  itemsPath?: string;
  /** Key on each item used for the human label (e.g. "name"). Default: name|title|label. */
  labelKey?: string;
  /** Key on each item used for the stored value (e.g. "id"). Default: id|uuid|_id|value. */
  valueKey?: string;
  /** Optional secondary line under the label (e.g. a status or count key). */
  sublabelKey?: string;
  /** Static args passed to the source method call (e.g. { limit: 100 }). */
  args?: Record<string, unknown>;
}

/**
 * A throttle applied to a connector's outbound calls so a large run is SPREAD
 * over time rather than firing N requests at once (respecting the upstream API's
 * documented limits). Enforced engine-side in {@link Engine.dispatch}. Set at the
 * connector level as a default; a single method may override with a stricter cap
 * (e.g. a heavy bulk/verify endpoint). Absent ⇒ no throttle (legacy behaviour).
 */
export interface RateLimit {
  /** Max requests per second. */
  rps?: number;
  /** Max requests per minute (used when rps is absent). */
  rpm?: number;
  /** Max in-flight requests at once for this connector (independent of run concurrency). */
  concurrency?: number;
}

/** A single callable method on a connector — the unit that becomes a column, an sdk call, and an MCP tool. */
export interface ConnectorMethod {
  id: string; // e.g. "generate"
  label: string; // e.g. "AI Generate"
  description: string; // agent-readable
  /** Functions-gallery category for THIS method (per-method because one
   *  connector's methods span use cases). Absent/unknown → listed under "All" only. */
  category?: string;
  /** JSON Schema for inputs (derived from zod via zod-to-json-schema). */
  inputSchema: Record<string, unknown>;
  /**
   * Fields whose value is picked from a live list the connector can fetch
   * (field id → its option source). Surfaced to the UI so e.g. a `campaign`
   * field renders as a name dropdown resolving to the campaign id.
   */
  options?: Record<string, FieldOptionSource>;
  /** Effective per-call throttle for this method (method override ?? connector default). */
  rateLimit?: RateLimit;
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
  /**
   * Fallback text generator used by `ai.generate` when NO AI provider key is
   * connected — routes the prompt through the user's already-authenticated coding
   * agent (Claude Code / Codex), so AI columns work off the model they're already
   * using without a separate key. Resolves to the generated text; rejects if no
   * agent is available either.
   */
  aiFallback?: (req: AiFallbackRequest) => Promise<string>;
  /**
   * Observability sink for an `ai.generate` LLM call — the engine stays
   * telemetry-agnostic and just hands the host the raw generation data; the host
   * (which owns a PostHog client) emits the `$ai_generation` LLM-observability
   * event. Absent ⇒ no tracing.
   */
  onAiGeneration?: (event: AiGenerationEvent) => void;
  /**
   * The LLM-observability trace id for the current column run — set by the engine
   * (one per `runColumn`, shared across its rows) so all `ai.generate` generations
   * in one "Run" group into a single PostHog trace. Undefined for a standalone
   * dispatch (preview / option resolution).
   */
  aiTraceId?: string;
  /**
   * Cross-table access for the `table` connector (table.push / table.lookup) —
   * the ONLY door a method has to sibling tables in the same project. Injected
   * per-engine by the run lane (which bakes in the source table id for scoping);
   * absent on hosts that don't wire it, where table.* methods fail with a clear
   * "not available here" error. Same injection pattern as {@link aiFallback}.
   */
  grid?: TableGateway;
  /**
   * The row this dispatch is executing for, when the call happens inside a
   * per-row column run (set by the engine via AsyncLocalStorage). `table.push`
   * uses it to deliver the WHOLE source row server-side by rowId. Undefined on
   * standalone dispatches (previews / option resolution / MCP run_function).
   */
  row?: { readonly rowId: string; readonly tableId: string; readonly columnId: string };
}

/** Raw data for one LLM generation, handed to {@link MethodContext.onAiGeneration}. */
export interface AiGenerationEvent {
  readonly provider: AiConfig["provider"];
  readonly model: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly latencyMs: number;
  readonly isError: boolean;
  readonly error?: string;
  /** The run-scoped trace id, when the generation runs inside a column run. */
  readonly traceId?: string;
}

/** A one-shot generation request for {@link MethodContext.aiFallback}. */
export interface AiFallbackRequest {
  readonly prompt: string;
  readonly system?: string;
  /** The model the user's agent is using, when known (passed through to the CLI). */
  readonly model?: string;
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

/**
 * How a connector authenticates its outbound calls. Both arms ultimately resolve
 * ONE token out of the flat `MethodContext.secrets` map under `secretKey`, so the
 * injection path is shared — the arms differ in where that token CAME FROM, and
 * therefore in what a user must do when it is missing or rejected:
 *
 * - `apiKey` — the user pasted a key. Missing/401 ⇒ "check the credential and
 *   update the key".
 * - `oauth`  — the token was minted by an OAuth grant against `provider` and is
 *   refreshed outside the engine. Missing/401 ⇒ "(re)connect the account"; there
 *   is no key for the user to paste, so key-flavoured copy would be a dead end.
 *
 * The engine deliberately knows nothing about the OAuth dance itself (authorize/
 * refresh live in the cloud service layer) — by the time a method runs, an oauth
 * connector is just an access token sitting in `secrets`.
 */
export type ConnectorAuth =
  | {
      type: "apiKey";
      header?: string;
      query?: string;
      /** Which decrypted secret holds the token (default "apiKey"). */
      secretKey?: string;
      /** When header is Authorization, the scheme prefix (default "Bearer "). */
      scheme?: string;
    }
  | {
      type: "oauth";
      /** OAuth provider id the access token was minted for (e.g. "slack"). */
      provider: string;
      /**
       * Which credential row to read, when that is NOT this connector's id.
       * Lets a provider family share ONE grant — see {@link credentialSlotFor}.
       */
      credentialSlot?: string;
      header?: string;
      /** Which decrypted secret holds the access token (default "accessToken"). */
      secretKey?: string;
      /** When header is Authorization, the scheme prefix (default "Bearer "). */
      scheme?: string;
    };

export interface Connector {
  id: string; // e.g. "ai", "apollo"
  name: string;
  category: string;
  /** Auth requirement; null for built-ins like AI that read from AI provider config. */
  auth: ConnectorAuth | null;
  /** Default outbound throttle for every method (a method may override it stricter). */
  rateLimit?: RateLimit;
  /**
   * This connector makes NO outbound network calls — its methods are pure-local
   * transforms (e.g. formatting/formula helpers). Such connectors are exempt from
   * the engine's safety-default rate limit so a formula calling `sdk.formatting.*`
   * across thousands of rows is never paced like a remote API. Outbound connectors
   * leave this unset and inherit the default throttle unless they declare a `rateLimit`.
   */
  local?: boolean;
  methods: ConnectorMethod[];
}
