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
import type { AiConfig, Column } from "./types.js";

export interface EngineConfig {
  ai?: AiConfig;
  /** All connected AI providers (for model-based routing). */
  aiProviders?: AiConfig[];
}

export interface RunColumnOptions {
  concurrency?: number;
  rowIds?: string[];
  /** Re-run cells already marked done. */
  force?: boolean;
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
          m.run(input, { secrets: cred?.secrets ?? {}, ai: this.config.ai, aiProviders }),
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
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(col.params)) out[k] = typeof v === "string" ? interp(v) : v;
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

  async runColumn(columnId: string, opts: RunColumnOptions = {}): Promise<{ ran: number; errors: number }> {
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

    // Precompile the formula body and the "only run if" condition ONCE — both are the same
    // for every row, and each carries the helper-library prelude it needs.
    const formula: CompiledFormula | null = isFormulaColumn(col)
      ? compileExpression(formulaExpression(col))
      : null;
    const condition: CompiledFormula | null = col.condition?.trim()
      ? compileExpression(col.condition)
      : null;
    const code = formula ? formula.body : this.columnCode(col);
    const formulaPrelude = formula ? buildFormulaPrelude(formula.libs) : undefined;
    const conditionPrelude = condition ? buildFormulaPrelude(condition.libs) : undefined;

    let ran = 0;
    let errors = 0;
    await mapConcurrent(rowIds, opts.concurrency ?? 5, async (rowId) => {
      const existing = await Effect.runPromise(reads.getCell(rowId, columnId));
      if (!opts.force && existing?.status === "done") return;

      // Conditional-run gate: evaluate "only run if" before any work. A falsy result skips
      // the row (no dispatch → no credits spent); a thrown condition surfaces as an error.
      if (condition) {
        try {
          const cinputs = await Effect.runPromise(this.resolveCells(col, rowId, reads));
          const pass = await runFunction({
            code: condition.body,
            inputs: cinputs,
            providers,
            dispatch: this.dispatch,
            prelude: conditionPrelude,
          });
          if (!pass) {
            // Clear any stale value so the skip is visible; avoid a write if already empty.
            if (existing && existing.status !== "empty") {
              await Effect.runPromise(
                this.store.setCell(rowId, columnId, { value: null, status: "empty", error: null }),
              );
            }
            return;
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          await Effect.runPromise(
            this.store.setCell(rowId, columnId, { status: "error", error: `condition: ${message}` }),
          );
          errors++;
          return;
        }
      }

      await Effect.runPromise(this.store.setCell(rowId, columnId, { status: "running", error: null }));
      try {
        // Formulas run over a typed row object; other function columns use {{...}} prompt
        // templating (resolveParams). formulaPrelude is undefined for non-formula columns.
        const inputs = formula
          ? await Effect.runPromise(this.resolveCells(col, rowId, reads))
          : await Effect.runPromise(this.resolveParams(col, rowId, reads));
        const result = await runFunction({
          code,
          inputs,
          providers,
          dispatch: this.dispatch,
          prelude: formulaPrelude,
        });
        await Effect.runPromise(
          this.store.setCell(rowId, columnId, { value: simplify(result), status: "done", error: null }),
        );
        ran++;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await Effect.runPromise(this.store.setCell(rowId, columnId, { status: "error", error: message }));
        errors++;
      }
    });
    return { ran, errors };
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
