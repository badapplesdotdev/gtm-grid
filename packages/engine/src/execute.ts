// Execution engine — ties Db + Registry + sandbox together. Runs a function
// column over its rows, resolving {{Column Name}} templates, dispatching sdk
// calls host-side, and writing cells with pending/running/done/error status.

import { Effect } from "effect";
import type { Db } from "./db.js";
import {
  buildFormulaPrelude,
  compileExpression,
  formulaExpression,
  isFormulaColumn,
  type CompiledFormula,
} from "./formula.js";
import { Registry, defaultRegistry } from "./registry.js";
import { runFunction, type SandboxDispatch } from "./sandbox.js";
import {
  sqliteGridStoreShape,
  type GridStoreError,
  type GridStoreShape,
} from "./store.js";
import type { AiConfig, AiFallbackRequest, Column, ConnectorMethod } from "./types.js";

/** Stored on a cell's `error` (with status "empty") when a run condition gates the
 *  row off, so the grid can show a muted "Run condition not met" note instead of a dash. */
export const CONDITION_SKIP_NOTE = "Run condition not met";

export interface EngineConfig {
  ai?: AiConfig;
  /** All connected AI providers (for model-based routing). */
  aiProviders?: AiConfig[];
  /**
   * Fallback for `ai.generate` when no AI provider key is connected — routes the
   * prompt through the user's coding agent (Claude Code / Codex). Set by the
   * sidecar (in-process {@link generateWithAgent}) and by the MCP (an HTTP POST to
   * the sidecar). Absent ⇒ `ai.generate` throws "No AI provider connected".
   */
  aiFallback?: (req: AiFallbackRequest) => Promise<string>;
  /**
   * Enforce the SSRF guard on every connector HTTP call this engine makes. Set
   * true ONLY on server-side run paths (the Vercel webhook-enrichment worker),
   * where a workspace member's custom manifest `baseUrl` is attacker-controlled
   * shared-infra input. Local/sidecar runs leave it unset (the call runs on the
   * user's own machine, so localhost/LAN connectors stay valid).
   */
  guardSsrf?: boolean;
}

/** A cell's state as observed during a run, for per-cell progress streaming.
 *  Status "empty" streams a condition-gated skip (error = CONDITION_SKIP_NOTE)
 *  so live grids show WHY a cell stayed blank instead of doing nothing. */
export interface CellProgress {
  readonly rowId: string;
  readonly columnId: string;
  readonly value: unknown;
  readonly status: "running" | "done" | "error" | "empty";
  readonly error: string | null;
}

export interface RunColumnOptions {
  concurrency?: number;
  rowIds?: string[];
  /**
   * Re-run cells already marked `done`. Without it, a candidate cell already
   * `done` is SKIPPED (costs no write / no cloud-action bill). Callers that want
   * to recompute ONLY a specific cell scope the force with `rowIds` so the
   * already-`done` cells outside that scope are never re-run or re-billed
   * (TRI-3283 L2).
   */
  force?: boolean;
  /**
   * Fired synchronously after each cell write during the run (running → then
   * done/error). Lets a caller stream per-cell progress (e.g. the sidecar's SSE
   * run route) so clients patch only the changed cell instead of refetching the
   * whole grid. Plain callback — kept off the Effect path on purpose. A throwing
   * callback never aborts the run (its failure is swallowed).
   */
  onCell?: (cell: CellProgress) => void;
}

/**
 * Optional store injection for the {@link Engine}.
 *
 * Local projects leave these unset: the engine builds a `SqliteGridStore` over
 * the constructor `db`/`credsDb`, exactly as before (behaviour unchanged). Cloud
 * projects pass a `ConvexGridStore`-backed shape so the SAME engine reads inputs
 * from Convex and writes cell status/results back via the T4 mutations — the run
 * path is identical; only where reads/writes go changes.
 */
export interface EngineStores {
  /** The project store the run path reads/writes through. */
  readonly store?: GridStoreShape;
  /** The credential store `dispatch` resolves connector secrets through. */
  readonly creds?: GridStoreShape;
}

export class Engine {
  /**
   * The local SQLite db, when running a LOCAL project. Undefined on the cloud
   * path, where the store + credentials are injected and no Db exists. Read it
   * through {@link requireDb} when a Db is genuinely required.
   */
  readonly db?: Db;
  /** Where credentials live — the shared global db when running multi-project. */
  readonly credsDb?: Db;
  readonly registry: Registry;
  config: EngineConfig;

  /** The project store the run path reads/writes through (local SQLite wrapper). */
  private readonly store: GridStoreShape;
  /** The credentials store `dispatch` resolves connector secrets through. */
  private readonly creds: GridStoreShape;

  constructor(
    db: Db | undefined,
    config: EngineConfig = {},
    registry: Registry = defaultRegistry(),
    credsDb?: Db,
    stores: EngineStores = {},
  ) {
    this.db = db;
    this.credsDb = credsDb ?? db;
    this.registry = registry;
    this.config = config;
    // The engine drives a GridStore abstraction, not the concrete Db. For local
    // projects that store defaults to a thin SqliteGridStore over the same Db, so
    // behaviour is unchanged; cloud projects inject a ConvexGridStore (built by
    // the server cloud-run lane) so the same run path reads/writes Convex — there
    // a Db is never constructed, so the SQLite fallback is only built when a store
    // is NOT injected. Credentials may live in a separate (shared/global) store
    // when running multi-project, or be injected (workspace-shared cloud creds).
    this.store = stores.store ?? sqliteGridStoreShape(requireDb(db, "store"));
    this.creds =
      stores.creds ?? sqliteGridStoreShape(requireDb(this.credsDb, "credentials"));
  }

  /** The local SQLite db, or throw if the engine was built without one (cloud). */
  requireDb(): Db {
    return requireDb(this.db, "db");
  }

  /** Host-side dispatcher exposed to the sandbox as `sdk.<provider>.<method>`. */
  dispatch: SandboxDispatch = (provider, method, input) =>
    Effect.runPromise(
      Effect.gen(this, function* () {
        const m = this.registry.method(provider, method);
        if (!m) throw new Error(`Unknown function ${provider}.${method}`);
        const cred = yield* this.creds.getCredential(provider);
        const aiProviders = this.config.aiProviders?.length
          ? this.config.aiProviders
          : this.config.ai
            ? [this.config.ai]
            : [];
        return yield* Effect.promise(() =>
          m.run(input, {
            secrets: cred?.secrets ?? {},
            ai: this.config.ai,
            aiProviders,
            guardSsrf: this.config.guardSsrf,
          aiFallback: this.config.aiFallback,
          }),
        );
      }),
    );

  /**
   * Resolve a column's params for a row, interpolating {{Column Name}} from cells.
   *
   * A store read failure PROPAGATES as a `GridStoreError`: `runColumn`'s per-row
   * try/catch then marks that cell `status:"error"`, restoring the prior LOCAL
   * semantics where a failed read surfaced as a failed cell rather than a silent
   * `done`. Missing-cell / null values still collapse their template to `""`
   * inside `interp` — only an actual store error escapes.
   */
  private resolveParams(
    col: Column,
    rowId: string,
    store: GridStoreShape,
  ): Effect.Effect<Record<string, unknown>, GridStoreError, never> {
    return Effect.gen(this, function* () {
      const cells = yield* store.rowCells(rowId);
      const columns = yield* store.listColumns(col.table_id);
      const byName = new Map(columns.map((c) => [c.name, c.id]));
      const interp = (s: string): string =>
        s.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, name: string) => {
          const cid = byName.get(name.trim());
          if (!cid) return "";
          const v = cells.get(cid)?.value;
          return v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
        });
      // Interpolate {{Column}} in every string, including those NESTED inside
      // object/array params (e.g. an http.request column's `headers`/`body`).
      // Non-string leaves are preserved as-is, so numbers/booleans stay typed.
      const interpDeep = (v: unknown): unknown =>
        typeof v === "string"
          ? interp(v)
          : Array.isArray(v)
            ? v.map(interpDeep)
            : v && typeof v === "object"
              ? Object.fromEntries(Object.entries(v).map(([k, val]) => [k, interpDeep(val)]))
              : v;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(col.params)) out[k] = interpDeep(v);
      return out;
    });
  }

  /**
   * Resolve a row into a typed `{ columnName: value }` object for formula / condition
   * evaluation. Unlike {@link resolveParams} (which splices raw cell *text* into prompt
   * strings), this preserves value TYPES so `{{Score}} + 1` sees the number and
   * `{{Email}}.split(...)` sees the string.
   */
  private resolveCells(
    col: Column,
    rowId: string,
    store: GridStoreShape,
  ): Effect.Effect<Record<string, unknown>, GridStoreError, never> {
    return Effect.gen(this, function* () {
      const cells = yield* store.rowCells(rowId);
      const columns = yield* store.listColumns(col.table_id);
      const out: Record<string, unknown> = {};
      for (const c of columns) out[c.name] = cells.get(c.id)?.value ?? null;
      return out;
    });
  }

  /** The JS body for a column: a compiled formula, custom code, or provider/method. */
  private columnCode(col: Column): string {
    if (isFormulaColumn(col)) return compileExpression(formulaExpression(col)).body;
    if (col.code) return col.code;
    return `function(inputs, sdk){ return sdk[${JSON.stringify(col.provider)}][${JSON.stringify(col.method)}](inputs); }`;
  }

  async runColumn(
    columnId: string,
    opts: RunColumnOptions = {},
  ): Promise<{ ran: number; errors: number; firstError?: string }> {
    // Take one read snapshot for the whole run. For stores whose granular reads
    // are expensive to repeat (ConvexGridStore re-fetches the full grid on every
    // read), `snapshot()` fetches the grid ONCE and serves every per-row read
    // from memory, so a run over N rows is O(N) store reads instead of O(N^2).
    // Local SQLite has no `snapshot` (reads are cheap, synchronous) and falls
    // back to the live store, preserving its exact behaviour. Writes still go to
    // the live store so cell status streams to clients during the run.
    const reads = this.store.snapshot
      ? await Effect.runPromise(this.store.snapshot())
      : this.store;

    const col = await Effect.runPromise(reads.getColumn(columnId));
    if (!col) throw new Error(`column ${columnId} not found`);
    if (col.kind !== "function") return { ran: 0, errors: 0 };

    const rowIds =
      opts.rowIds ?? (await Effect.runPromise(reads.listRows(col.table_id))).map((r) => r.id);
    const providers = this.registry.providerMap();

    // Precompile the formula body and the "only run if" condition ONCE (same for every
    // row); each carries the helper-library prelude it needs.
    const formula: CompiledFormula | null = isFormulaColumn(col)
      ? compileExpression(formulaExpression(col))
      : null;
    const condition: CompiledFormula | null = col.condition?.trim()
      ? compileExpression(col.condition)
      : null;
    const code = formula ? formula.body : this.columnCode(col);
    const formulaPrelude = formula ? buildFormulaPrelude(formula.libs) : undefined;
    const conditionPrelude = condition ? buildFormulaPrelude(condition.libs) : undefined;

    // Emit a per-cell progress event, never letting a bad callback abort the run.
    const emit = (cell: CellProgress): void => {
      if (!opts.onCell) return;
      try {
        opts.onCell(cell);
      } catch {
        /* a streaming sink failure must not fail the run */
      }
    };

    const counters = { ran: 0, errors: 0 };
    // The first cell error message — returned so a caller (the MCP run_column
    // tool) can tell the user WHY a run failed (e.g. a missing AI/connector key)
    // without a follow-up get_table read.
    let firstError: string | undefined;
    // Stores that batch terminal writes (the cloud store) coalesce the interim
    // `running` write away so a cell is ONE write, not two HTTP POSTs. Cheap
    // synchronous stores leave the flag unset and keep streaming `running`.
    const skipRunning = this.store.coalesceRunningWrites === true;
    const concurrency = opts.concurrency ?? 5;

    // Resolve whether this column can run as ONE method call per batch: it must
    // be a plain method-call column (no custom JS body), and its method must
    // declare batchSize > 1 plus a `runBatch` implementation. Otherwise every
    // row goes through the per-row sandbox path, identical to before — so the
    // batchSize:1 / custom-code / runBatch-less cases are completely unchanged.
    // Conditional-run columns must run per-row so the gate can skip individual rows.
    // Formula columns have no runBatch and are already excluded by batchableMethod.
    const batchMethod = condition ? null : this.batchableMethod(col);

    // Per-row run start times, for the run-duration metadata on terminal writes.
    const startedAt = new Map<string, number>();
    // Archive the raw pre-`simplify` response only when it carries MORE than the
    // stored value (different serialization) and fits the size cap — otherwise
    // null, which also clears a stale archive from a previous run.
    const RAW_CAP = 64_000;
    const rawToArchive = (value: unknown, raw: unknown): unknown => {
      if (raw === undefined || raw === null) return null;
      try {
        const rawJson = JSON.stringify(raw);
        if (rawJson == null || rawJson.length > RAW_CAP) return null;
        return rawJson === JSON.stringify(value) ? null : raw;
      } catch {
        return null; // unserializable response — skip the archive, never the run
      }
    };
    const runMeta = (rowId: string): { ranAt: number; runMs: number | null } => {
      const start = startedAt.get(rowId);
      const ranAt = Date.now();
      return { ranAt, runMs: start != null ? ranAt - start : null };
    };

    // Mark a cell `running` (unless the store coalesces it) and stream progress.
    const markRunning = async (rowId: string): Promise<void> => {
      startedAt.set(rowId, Date.now());
      if (skipRunning) return;
      await Effect.runPromise(this.store.setCell(rowId, columnId, { status: "running", error: null }));
      emit({ rowId, columnId, value: null, status: "running", error: null });
    };
    const markDone = async (rowId: string, value: unknown, raw?: unknown): Promise<void> => {
      const { ranAt, runMs } = runMeta(rowId);
      await Effect.runPromise(
        this.store.setCell(rowId, columnId, {
          value,
          status: "done",
          error: null,
          ranAt,
          runMs,
          raw: rawToArchive(value, raw),
        }),
      );
      emit({ rowId, columnId, value, status: "done", error: null });
      counters.ran++;
    };
    const markError = async (rowId: string, e: unknown): Promise<void> => {
      const message = e instanceof Error ? e.message : String(e);
      if (firstError === undefined) firstError = message;
      const { ranAt, runMs } = runMeta(rowId);
      await Effect.runPromise(
        this.store.setCell(rowId, columnId, { status: "error", error: message, ranAt, runMs, raw: null }),
      );
      emit({ rowId, columnId, value: null, status: "error", error: message });
      counters.errors++;
    };

    if (batchMethod) {
      // Skip already-done cells up front so chunking groups only the rows we'll
      // actually call for, keeping the call count ~= pending-rows / batchSize.
      const pending: string[] = [];
      for (const rowId of rowIds) {
        const existing = await Effect.runPromise(reads.getCell(rowId, columnId));
        if (!opts.force && existing?.status === "done") continue;
        pending.push(rowId);
      }
      const chunks = chunk(pending, batchMethod.batchSize);
      // Bound concurrency across BATCHES (not rows): N rows at batchSize B is
      // ceil(N/B) external calls, at most `concurrency` of them in flight.
      await mapConcurrent(chunks, concurrency, async (rows) => {
        for (const rowId of rows) await markRunning(rowId);
        let inputs: Record<string, unknown>[];
        try {
          inputs = await Promise.all(
            rows.map((rowId) => Effect.runPromise(this.resolveParams(col, rowId, reads))),
          );
        } catch (e) {
          for (const rowId of rows) await markError(rowId, e);
          return;
        }
        try {
          const results = await this.runBatch(col, inputs);
          // Fan each ordered result back to its row's cell (order preserved).
          for (let i = 0; i < rows.length; i++) await markDone(rows[i], simplify(results[i]), results[i]);
        } catch (e) {
          // A failed batch call fails every cell in that batch — never a silent done.
          for (const rowId of rows) await markError(rowId, e);
        }
      });
    } else {
      await mapConcurrent(rowIds, concurrency, async (rowId) => {
        const existing = await Effect.runPromise(reads.getCell(rowId, columnId));
        if (!opts.force && existing?.status === "done") return;

        // Conditional-run gate: evaluate "only run if" before any work. A falsy result
        // skips the row (no dispatch → no credits); a thrown condition is a cell error.
        if (condition) {
          try {
            const cinputs = await Effect.runPromise(this.resolveCells(col, rowId, reads));
            // NOTE: a condition expression runs in the same sandbox as a code/formula
            // column, so it CAN call `sdk.<connector>.<method>` — meaning the gate itself
            // can dispatch a connector call and thus spend credits, bounded by the same
            // registry allow-list that constrains code columns. This is intentional (lets
            // a gate consult an enrichment before deciding to run), not a leak.
            const pass = await runFunction({
              code: condition.body,
              inputs: cinputs,
              providers,
              dispatch: this.dispatch,
              prelude: conditionPrelude,
            });
            if (!pass) {
              // Mark the cell so the user can SEE why it's blank — gated off by the run
              // condition. We reuse the `error` text with status "empty" (not "error"), so
              // the grid shows a muted "Run condition not met" note instead of a bare dash.
              // Skip the write when it already shows that note, but ALWAYS stream the
              // progress event so a live grid updates immediately instead of doing nothing.
              if (existing?.status !== "empty" || existing?.error !== CONDITION_SKIP_NOTE) {
                await Effect.runPromise(
                  this.store.setCell(rowId, columnId, { value: null, status: "empty", error: CONDITION_SKIP_NOTE }),
                );
              }
              emit({ rowId, columnId, value: null, status: "empty", error: CONDITION_SKIP_NOTE });
              return;
            }
          } catch (e) {
            await markError(rowId, `condition: ${e instanceof Error ? e.message : String(e)}`);
            return;
          }
        }

        await markRunning(rowId);
        try {
          // Formulas run over a typed row object; other columns use {{...}} templating.
          const inputs = formula
            ? await Effect.runPromise(this.resolveCells(col, rowId, reads))
            : await Effect.runPromise(this.resolveParams(col, rowId, reads));
          const result = await runFunction({ code, inputs, providers, dispatch: this.dispatch, prelude: formulaPrelude });
          await markDone(rowId, simplify(result), result);
        } catch (e) {
          await markError(rowId, e);
        }
      });
    }
    // Flush the final partial batch + await all in-flight writes (no-op for
    // synchronous stores).
    if (this.store.drain) await Effect.runPromise(this.store.drain());
    return { ran: counters.ran, errors: counters.errors, ...(firstError ? { firstError } : {}) };
  }

  /**
   * The connector method to drive a column's run as ONE call per batch, or null
   * if the column must run per-row. Eligible columns are plain method calls (no
   * custom JS body) whose method declares `batchSize > 1` and a `runBatch`.
   */
  private batchableMethod(col: Column): (ConnectorMethod & { batchSize: number }) | null {
    if (col.code) return null; // custom JS bodies always run per-row in the sandbox
    if (!col.provider || !col.method) return null;
    const m = this.registry.method(col.provider, col.method);
    if (!m || m.batchSize <= 1 || !m.runBatch) return null;
    return m;
  }

  /** Run a connector method over an ordered batch of inputs (one external call). */
  private async runBatch(col: Column, inputs: Record<string, unknown>[]): Promise<unknown[]> {
    const m = this.registry.method(col.provider ?? "", col.method ?? "");
    if (!m?.runBatch) throw new Error(`Method ${col.provider}.${col.method} is not batchable`);
    const cred = await Effect.runPromise(this.creds.getCredential(col.provider ?? ""));
    const aiProviders = this.config.aiProviders?.length
      ? this.config.aiProviders
      : this.config.ai
        ? [this.config.ai]
        : [];
    return m.runBatch(inputs, {
      secrets: cred?.secrets ?? {},
      ai: this.config.ai,
      aiProviders,
      guardSsrf: this.config.guardSsrf,
          aiFallback: this.config.aiFallback,
    });
  }

  /**
   * Dry-run a not-yet-saved function column against the first `limit` rows and
   * return each result WITHOUT persisting a column or writing any cell. Powers
   * the "Try on N rows" preview: it resolves {{Column}} templates per row (same
   * path as a real run) and dispatches the method, so what you see is what a run
   * would store. A per-row failure is captured as `error`, never thrown.
   */
  async previewColumn(
    spec: { provider: string; method: string; params: Record<string, unknown>; table_id: string },
    limit = 5,
  ): Promise<Array<{ rowId: string; value?: unknown; error?: string }>> {
    const rows = (await Effect.runPromise(this.store.listRows(spec.table_id))).slice(0, Math.max(0, limit));
    // A transient column object — never saved; `resolveParams` only reads
    // `params` + `table_id`, so this is enough to interpolate per-row values.
    const col: Column = {
      id: "__preview__",
      table_id: spec.table_id,
      name: "__preview__",
      type: "json",
      kind: "function",
      provider: spec.provider,
      method: spec.method,
      code: null,
      params: spec.params,
      condition: null,
      position: 0,
      created_at: 0,
    };
    // Bounded by `limit` (≤25 from the route), so a plain concurrent fan-out is fine.
    return Promise.all(
      rows.map(async (row) => {
        try {
          const input = await Effect.runPromise(this.resolveParams(col, row.id, this.store));
          const value = await this.dispatch(spec.provider, spec.method, input);
          return { rowId: row.id, value };
        } catch (e) {
          return { rowId: row.id, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
  }
}

/**
 * Assert a `Db` is present (the LOCAL path), throwing a clear error otherwise.
 * The CLOUD path injects `stores.store`/`stores.creds`, so no Db is required —
 * but if neither a Db nor an injected store is supplied for a given purpose the
 * engine cannot read/write, and this surfaces that as an explicit failure rather
 * than a `Cannot read properties of undefined` later in the run.
 */
function requireDb(db: Db | undefined, purpose: string): Db {
  if (!db)
    throw new Error(
      `Engine requires a Db for ${purpose}: pass a Db (local path) or inject stores.${purpose === "credentials" ? "creds" : "store"} (cloud path).`,
    );
  return db;
}

/** Unwrap a sole `{ text }` result so AI columns store the plain string. */
function simplify(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const keys = Object.keys(v as Record<string, unknown>);
    if (keys.length === 1 && keys[0] === "text") return (v as { text: unknown }).text;
  }
  return v;
}

/** Split a list into fixed-size chunks (last chunk may be smaller). */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 1) return items.map((i) => [i]);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Bounded-concurrency map (Revcode's `mapConcurrent`). */
export async function mapConcurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await fn(items[index], index);
    }
  });
  await Promise.all(workers);
}

/** Resolve AI config from environment (Anthropic preferred). */
export function aiConfigFromEnv(): AiConfig | undefined {
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: "anthropic",
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.GTMGRID_AI_MODEL ?? "claude-haiku-4-5-20251001",
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return { provider: "openai", apiKey: process.env.OPENAI_API_KEY, model: process.env.GTMGRID_AI_MODEL ?? "gpt-4o-mini" };
  }
  if (process.env.OPENROUTER_API_KEY) {
    return {
      provider: "openrouter",
      apiKey: process.env.OPENROUTER_API_KEY,
      model: process.env.GTMGRID_AI_MODEL ?? "openai/gpt-4o-mini",
    };
  }
  return undefined;
}
