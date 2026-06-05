// Execution engine — ties Db + Registry + sandbox together. Runs a function
// column over its rows, resolving {{Column Name}} templates, dispatching sdk
// calls host-side, and writing cells with pending/running/done/error status.

import { Db } from "./db.js";
import { Registry, defaultRegistry } from "./registry.js";
import { runFunction, type SandboxDispatch } from "./sandbox.js";
import type { AiConfig, Column } from "./types.js";

export interface EngineConfig {
  ai?: AiConfig;
}

export interface RunColumnOptions {
  concurrency?: number;
  rowIds?: string[];
  /** Re-run cells already marked done. */
  force?: boolean;
}

export class Engine {
  readonly db: Db;
  readonly registry: Registry;
  config: EngineConfig;

  constructor(db: Db, config: EngineConfig = {}, registry: Registry = defaultRegistry()) {
    this.db = db;
    this.registry = registry;
    this.config = config;
  }

  /** Host-side dispatcher exposed to the sandbox as `sdk.<provider>.<method>`. */
  dispatch: SandboxDispatch = async (provider, method, input) => {
    const m = this.registry.method(provider, method);
    if (!m) throw new Error(`Unknown function ${provider}.${method}`);
    const cred = this.db.getCredential(provider);
    return m.run(input, { secrets: cred?.secrets ?? {}, ai: this.config.ai });
  };

  /** Resolve a column's params for a row, interpolating {{Column Name}} from cells. */
  private resolveParams(col: Column, rowId: string): Record<string, unknown> {
    const cells = this.db.rowCells(rowId);
    const byName = new Map(this.db.listColumns(col.table_id).map((c) => [c.name, c.id]));
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
  }

  /** The JS body for a column: custom code, or synthesized from provider/method. */
  private columnCode(col: Column): string {
    if (col.code) return col.code;
    return `function(inputs, sdk){ return sdk[${JSON.stringify(col.provider)}][${JSON.stringify(col.method)}](inputs); }`;
  }

  async runColumn(columnId: string, opts: RunColumnOptions = {}): Promise<{ ran: number; errors: number }> {
    const col = this.db.getColumn(columnId);
    if (!col) throw new Error(`column ${columnId} not found`);
    if (col.kind !== "function") return { ran: 0, errors: 0 };

    const rowIds = opts.rowIds ?? this.db.listRows(col.table_id).map((r) => r.id);
    const code = this.columnCode(col);
    const providers = this.registry.providerMap();

    let ran = 0;
    let errors = 0;
    await mapConcurrent(rowIds, opts.concurrency ?? 5, async (rowId) => {
      const existing = this.db.getCell(rowId, columnId);
      if (!opts.force && existing?.status === "done") return;
      this.db.setCell(rowId, columnId, { status: "running", error: null });
      try {
        const inputs = this.resolveParams(col, rowId);
        const result = await runFunction({ code, inputs, providers, dispatch: this.dispatch });
        this.db.setCell(rowId, columnId, { value: simplify(result), status: "done", error: null });
        ran++;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.db.setCell(rowId, columnId, { status: "error", error: message });
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
  return undefined;
}
