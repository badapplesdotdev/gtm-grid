/**
 * TableGateway — the CROSS-TABLE surface the `table` connector (table.push /
 * table.lookup) runs against. Connector methods receive only a `MethodContext`,
 * which historically had no store access at all; this gateway is the one,
 * deliberately narrow door through which a method can reach a SIBLING table in
 * the same project (list tables, read a table's schema/rows, upsert a row,
 * create a column). It is injected per-engine via `EngineConfig.grid` and handed
 * to methods as `ctx.grid` — exactly the same injection pattern as
 * `ctx.aiFallback` / `ctx.onAiGeneration`.
 *
 * DECOUPLING (same load-bearing constraint as store-cloud.ts): this module must
 * NOT import any backend client. The concrete implementation
 * ({@link cloudTableGateway}) drives an injected {@link CloudClientLike} against
 * opaque function refs ({@link TableGatewayRefs}) — the caller (the sidecar's
 * cloud-run lane, the Inngest webhook worker, the MCP cloud source) wires the
 * `/api/worker/*` route paths in. Every route validates SERVER-SIDE that the
 * target table belongs to the same project as `sourceTableId`, so the gateway
 * cannot reach across projects/workspaces regardless of client behaviour.
 *
 * CONSISTENCY & CONCURRENCY (the reason this is a class, not bare fetches):
 *   - `getSchema` results are memoized per table ref, so a 1,000-row push run
 *     resolves the target's columns once, not per row.
 *   - `readRows` results are memoized per table and INVALIDATED by any write
 *     this gateway makes to that table, so a lookup that follows a push in the
 *     same run sees the pushed row.
 *   - `upsertRow` calls are SERIALIZED per (table, keyColumn, keyValue): two
 *     concurrent rows pushing the same key can never double-insert — the second
 *     waits for the first and then matches the row it created. (The worker
 *     route is additionally atomic server-side; this ordering just guarantees
 *     the read-your-write sequence within one run.)
 *   - `createColumn` calls are deduped in flight per (table, column name), so
 *     `createMissingColumns` under run concurrency creates one column, not N.
 */

import type { CloudClientLike } from "./store-cloud.js";
import type { ColumnKind, ColumnType } from "./types.js";

/** A sibling table's identity, as listed by {@link TableGateway.listTables}. */
export interface GatewayTableInfo {
  readonly id: string;
  readonly name: string;
}

/** A target table's schema — what push/lookup need to resolve column names. */
export interface GatewayTableSchema {
  readonly id: string;
  readonly name: string;
  readonly columns: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly type: ColumnType;
    readonly kind: ColumnKind;
  }>;
}

/** One row of a target table, cells keyed by COLUMN NAME (lookup's read shape). */
export interface GatewayRow {
  readonly rowId: string;
  readonly cells: Record<string, unknown>;
}

/** Inputs to {@link TableGateway.upsertRow}. */
export interface GatewayUpsertInput {
  readonly tableId: string;
  /** Target column id to match an existing row on; null appends unconditionally. */
  readonly keyColumnId: string | null;
  /** The value to match (ignored when keyColumnId is null). */
  readonly keyValue: unknown;
  /** Cell values to write, keyed by target COLUMN ID (written status "done"). */
  readonly cells: Record<string, unknown>;
  /** Clay-parity: run the target's function columns over the touched row. */
  readonly autoRunTarget?: boolean;
  /** Idempotency key for the autoRunTarget enrich (hash of push column + source row). */
  readonly recordId?: string;
}

/** Result of an upsert: which row was touched, and whether it was created. */
export interface GatewayUpsertResult {
  readonly rowId: string;
  readonly created: boolean;
}

/** Inputs to {@link TableGateway.pushRow} — the webhook-style push (v2). */
export interface GatewayPushInput {
  /** Target table id (resolve via getSchema first for a human error). */
  readonly tableId: string;
  /** The SOURCE row to deliver — the server reads its cells as the payload. */
  readonly sourceRowId: string;
  /** The push COLUMN itself — excluded from the delivered payload. */
  readonly sourceColumnId?: string | null;
  readonly mode: "upsert" | "append";
  /** Target column NAME to dedupe on (upsert mode). */
  readonly keyColumnName?: string | null;
  readonly keyValue?: unknown;
  /** Clay parity: run the target's function columns over the touched row. */
  readonly autoRunTarget?: boolean;
}

/**
 * The cross-table operations available to connector methods via `ctx.grid`.
 * All table refs are within the SAME project as the run's source table — the
 * backing routes enforce this server-side.
 */
export interface TableGateway {
  /** Sibling tables in the current project (id + name). */
  listTables(): Promise<GatewayTableInfo[]>;
  /** Resolve a table by id or exact name; undefined when it doesn't exist. */
  getSchema(tableRef: string): Promise<GatewayTableSchema | undefined>;
  /** All rows of a table with cells keyed by column NAME (memoized; see above). */
  readRows(tableId: string): Promise<GatewayRow[]>;
  /** Atomic find-or-insert + cell writes (serialized per key; see above). */
  upsertRow(input: GatewayUpsertInput): Promise<GatewayUpsertResult>;
  /**
   * Webhook-style push (v2): deliver ONE source row into the target through
   * its PUSH CONNECTION. The server reads the whole source row as the payload,
   * applies the connection's stored mapping (edited from the TARGET table),
   * lands the raw payload in the target's "Pushed data" column, and upserts by
   * the key. Serialized per key like {@link upsertRow}.
   */
  pushRow(input: GatewayPushInput): Promise<GatewayUpsertResult>;
  /** Create a manual column on a target table (deduped in flight). */
  createColumn(tableId: string, name: string, type?: ColumnType): Promise<{ id: string }>;
  /**
   * The run's SOURCE table id, when known. `table.push` compares this against
   * its target to reject self-push (a push into the table being iterated
   * mutates the row set mid-run). Undefined on table-free dispatches (the MCP
   * `run_function` path), where there is no source to loop on.
   */
  readonly sourceTableId?: string;
}

/**
 * Opaque references to the worker operations the cloud gateway calls — route
 * paths on the HTTP client, `unknown` to keep the engine backend-agnostic
 * (mirrors {@link CloudFunctionRefs} in store-cloud.ts).
 */
export interface TableGatewayRefs {
  /** `{ sourceTableId }` → `{ tables: [{ id, name }] }` */
  readonly listProjectTables: unknown;
  /** `{ sourceTableId, targetRef }` → GatewayTableSchema-shaped payload or null */
  readonly getTableSchema: unknown;
  /** `{ sourceTableId, targetTableId }` → `{ columns, rows, cells }` (worker grid shape) */
  readonly getTableRows: unknown;
  /** `{ sourceTableId, targetTableId, keyColumnId, keyValue, cells, autoRunTarget?, recordId? }` → `{ rowId, created }` */
  readonly upsertRowInTable: unknown;
  /** `{ sourceTableId, targetTableId, name, type }` → `{ id }` */
  readonly createColumnInTable: unknown;
  /** `{ sourceTableId, sourceRowId, targetTableId, mode, keyColumnName?, keyValue?, autoRunTarget? }` → `{ rowId, created }` */
  readonly pushRowIntoTable: unknown;
}

/** Config for {@link cloudTableGateway}. */
export interface CloudTableGatewayConfig {
  readonly client: CloudClientLike;
  readonly refs: TableGatewayRefs;
  /**
   * The run's source table id, baked into every request so the worker can
   * enforce same-project scoping. Omit ONLY for table-free dispatches.
   */
  readonly sourceTableId?: string;
}

/** The worker grid payload `getTableRows` returns (same shape as getTable). */
interface WorkerGridPayload {
  readonly columns: ReadonlyArray<{
    readonly _id: string;
    readonly name: string;
    readonly type: ColumnType;
    readonly kind: ColumnKind;
  }>;
  readonly rows: ReadonlyArray<{ readonly _id: string }>;
  readonly cells: ReadonlyArray<{
    readonly rowId: string;
    readonly columnId: string;
    readonly value: unknown;
  }>;
}

/** The schema payload `getTableSchema` returns. */
interface WorkerSchemaPayload {
  readonly table: { readonly id: string; readonly name: string };
  readonly columns: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly type: ColumnType;
    readonly kind: ColumnKind;
  }>;
}

/**
 * Serialize async work per string key: each call for a key runs strictly after
 * the previous call for that key settles. Keys are independent. The chain entry
 * is removed once its tail settles with no queued successor, so the map never
 * grows past the set of in-flight keys.
 */
class KeyedQueue {
  private readonly chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    // The next chain link settles when THIS task settles (success or failure),
    // but the returned promise preserves the task's own result/rejection.
    const result = prev.then(task, task);
    const link = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, link);
    void link.finally(() => {
      if (this.chains.get(key) === link) this.chains.delete(key);
    });
    return result;
  }
}

/**
 * Build a {@link TableGateway} over the injected worker client + refs. One
 * instance is built per engine (its memoization horizon), matching how the
 * cloud GridStore is built per run lane.
 */
export function cloudTableGateway(config: CloudTableGatewayConfig): TableGateway {
  const { client, refs, sourceTableId } = config;

  /** Memoized schema lookups, keyed by the caller-supplied table ref. */
  const schemaCache = new Map<string, Promise<GatewayTableSchema | undefined>>();
  /** Memoized row reads, keyed by table id — invalidated by writes to that table. */
  const rowsCache = new Map<string, Promise<GatewayRow[]>>();
  /** In-flight column creations, keyed by `${tableId} ${name}`. */
  const columnCreates = new Map<string, Promise<{ id: string }>>();
  /** Upsert serialization per (table, keyColumn, keyValue). */
  const upserts = new KeyedQueue();

  const base = { sourceTableId };

  const invalidateRows = (tableId: string): void => {
    rowsCache.delete(tableId);
  };

  return {
    ...base,

    async listTables(): Promise<GatewayTableInfo[]> {
      const res = (await client.query(refs.listProjectTables, {
        sourceTableId,
      })) as { tables: GatewayTableInfo[] };
      return res.tables;
    },

    getSchema(tableRef: string): Promise<GatewayTableSchema | undefined> {
      const cached = schemaCache.get(tableRef);
      if (cached) return cached;
      const fetched = (async (): Promise<GatewayTableSchema | undefined> => {
        const res = (await client.query(refs.getTableSchema, {
          sourceTableId,
          targetRef: tableRef,
        })) as WorkerSchemaPayload | null;
        if (res == null) return undefined;
        return { id: res.table.id, name: res.table.name, columns: res.columns };
      })();
      schemaCache.set(tableRef, fetched);
      // A failed fetch must not be cached as a permanent miss.
      fetched.catch(() => schemaCache.delete(tableRef));
      return fetched;
    },

    readRows(tableId: string): Promise<GatewayRow[]> {
      const cached = rowsCache.get(tableId);
      if (cached) return cached;
      const fetched = (async (): Promise<GatewayRow[]> => {
        const grid = (await client.query(refs.getTableRows, {
          sourceTableId,
          targetTableId: tableId,
        })) as WorkerGridPayload;
        const nameById = new Map(grid.columns.map((c) => [c._id, c.name]));
        const byRow = new Map<string, Record<string, unknown>>();
        for (const row of grid.rows) byRow.set(row._id, {});
        for (const cell of grid.cells) {
          const name = nameById.get(cell.columnId);
          const rowCells = byRow.get(cell.rowId);
          if (name !== undefined && rowCells !== undefined) rowCells[name] = cell.value;
        }
        return grid.rows.map((r) => ({ rowId: r._id, cells: byRow.get(r._id) ?? {} }));
      })();
      rowsCache.set(tableId, fetched);
      fetched.catch(() => rowsCache.delete(tableId));
      return fetched;
    },

    upsertRow(input: GatewayUpsertInput): Promise<GatewayUpsertResult> {
      // Append-mode (no key) calls need no ordering; keyed upserts serialize so
      // two concurrent rows with the same key can never race find-or-insert.
      const doUpsert = async (): Promise<GatewayUpsertResult> => {
        const res = (await client.mutation(refs.upsertRowInTable, {
          sourceTableId,
          targetTableId: input.tableId,
          keyColumnId: input.keyColumnId,
          keyValue: input.keyValue ?? null,
          cells: input.cells,
          ...(input.autoRunTarget !== undefined ? { autoRunTarget: input.autoRunTarget } : {}),
          ...(input.recordId !== undefined ? { recordId: input.recordId } : {}),
        })) as GatewayUpsertResult;
        invalidateRows(input.tableId);
        return res;
      };
      if (input.keyColumnId === null) return doUpsert();
      const key = `${input.tableId} ${input.keyColumnId} ${JSON.stringify(input.keyValue) ?? "null"}`;
      return upserts.run(key, doUpsert);
    },

    pushRow(input: GatewayPushInput): Promise<GatewayUpsertResult> {
      const doPush = async (): Promise<GatewayUpsertResult> => {
        const res = (await client.mutation(refs.pushRowIntoTable, {
          sourceTableId,
          sourceRowId: input.sourceRowId,
          sourceColumnId: input.sourceColumnId ?? null,
          targetTableId: input.tableId,
          mode: input.mode,
          keyColumnName: input.keyColumnName ?? null,
          keyValue: input.keyValue ?? null,
          ...(input.autoRunTarget !== undefined ? { autoRunTarget: input.autoRunTarget } : {}),
        })) as GatewayUpsertResult;
        invalidateRows(input.tableId);
        return res;
      };
      if (input.mode !== "upsert" || input.keyColumnName == null) return doPush();
      const key = `${input.tableId} ${input.keyColumnName} ${JSON.stringify(input.keyValue) ?? "null"}`;
      return upserts.run(key, doPush);
    },

    createColumn(tableId: string, name: string, type?: ColumnType): Promise<{ id: string }> {
      const key = `${tableId} ${name}`;
      const inFlight = columnCreates.get(key);
      if (inFlight) return inFlight;
      const created = (async (): Promise<{ id: string }> => {
        const res = (await client.mutation(refs.createColumnInTable, {
          sourceTableId,
          targetTableId: tableId,
          name,
          type: type ?? "text",
        })) as { id: string };
        // The target's schema changed — drop the memoized schema entries that
        // could resolve to this table (by id or by name we may not know here,
        // so clear the whole schema cache: cheap, and column creation is rare).
        schemaCache.clear();
        invalidateRows(tableId);
        return res;
      })();
      columnCreates.set(key, created);
      // Keep successful creations memoized for the run (repeat calls return the
      // same column); drop failures so a retry can attempt again.
      created.catch(() => columnCreates.delete(key));
      return created;
    },
  };
}
