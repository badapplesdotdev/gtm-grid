// Execution engine — ties Db + Registry + sandbox together. Runs a function
// column over its rows, resolving {{Column Name}} templates, dispatching sdk
// calls host-side, and writing cells with pending/running/done/error status.

import { Effect } from "effect";
import { Db } from "./db.js";
import { Registry, defaultRegistry } from "./registry.js";
import { runFunction, type SandboxDispatch } from "./sandbox.js";
import { sqliteGridStoreShape, type GridStoreShape } from "./store.js";
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
  readonly db: Db;
  /** Where credentials live — the shared global db when running multi-project. */
  readonly credsDb: Db;
  readonly registry: Registry;
  config: EngineConfig;

  /** The project store the run path reads/writes through (local SQLite wrapper). */
  private readonly store: GridStoreShape;
  /** The credentials store `dispatch` resolves connector secrets through. */
  private readonly creds: GridStoreShape;

  constructor(
    db: Db,
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
    // the server cloud-run lane) so the same run path reads/writes Convex.
    // Credentials may live in a separate (shared/global) store when running
    // multi-project, or be injected (e.g. workspace-shared cloud credentials).
    this.store = stores.store ?? sqliteGridStoreShape(db);
    this.creds = stores.creds ?? sqliteGridStoreShape(this.credsDb);
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

  /** Resolve a column's params for a row, interpolating {{Column Name}} from cells. */
  private resolveParams(
    col: Column,
    rowId: string,
  ): Effect.Effect<Record<string, unknown>, never, never> {
    return Effect.gen(this, function* () {
      const cells = yield* this.store.rowCells(rowId);
      const columns = yield* this.store.listColumns(col.table_id);
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
    }).pipe(
      // Param resolution never surfaces store errors to the caller: a failed
      // read collapses templates to empty, matching the prior best-effort behaviour.
      Effect.orElseSucceed(() => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(col.params)) {
          out[k] = typeof v === "string" ? v.replace(/\{\{\s*[^}]+?\s*\}\}/g, "") : v;
        }
        return out;
      }),
    );
  }

  /** The JS body for a column: custom code, or synthesized from provider/method. */
  private columnCode(col: Column): string {
    if (col.code) return col.code;
    return `function(inputs, sdk){ return sdk[${JSON.stringify(col.provider)}][${JSON.stringify(col.method)}](inputs); }`;
  }

  async runColumn(columnId: string, opts: RunColumnOptions = {}): Promise<{ ran: number; errors: number }> {
    const col = await Effect.runPromise(this.store.getColumn(columnId));
    if (!col) throw new Error(`column ${columnId} not found`);
    if (col.kind !== "function") return { ran: 0, errors: 0 };

    const rowIds =
      opts.rowIds ?? (await Effect.runPromise(this.store.listRows(col.table_id))).map((r) => r.id);
    const code = this.columnCode(col);
    const providers = this.registry.providerMap();

    let ran = 0;
    let errors = 0;
    await mapConcurrent(rowIds, opts.concurrency ?? 5, async (rowId) => {
      const existing = await Effect.runPromise(this.store.getCell(rowId, columnId));
      if (!opts.force && existing?.status === "done") return;
      await Effect.runPromise(this.store.setCell(rowId, columnId, { status: "running", error: null }));
      try {
        const inputs = await Effect.runPromise(this.resolveParams(col, rowId));
        const result = await runFunction({ code, inputs, providers, dispatch: this.dispatch });
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
