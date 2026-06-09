/**
 * `WebhookRepo` — the Effect <-> Drizzle adapter for inbound webhook endpoints
 * AND the grid primitives the headless webhook worker writes through.
 *
 * It owns the `webhooks` table's reads/writes (config CRUD: list, create, patch,
 * delete, token lookup) PLUS the narrow slice of grid access the worker path
 * needs (column ids for a table, row insert + position, cell reads/upserts,
 * workspace quota read + meter bump). The Convex source kept all of this in one
 * `convex/webhooks.ts` module because it is one domain — the webhook ingestion
 * surface — so the repo mirrors that boundary rather than spawning a column/row/
 * cell repo per table for code only the webhook worker reaches.
 *
 * Two Layers, like the worked example {@link WorkspaceRepo}:
 *   - {@link WebhookRepoLive} — Drizzle-backed, depends on {@link DbClient}. Every
 *     query is wrapped in `Effect.tryPromise` so a transport failure surfaces as
 *     the typed {@link WebhookRepoError}.
 *   - {@link webhookRepoLayer} — in-memory, backed by mutable fixture arrays, so
 *     the service + procedures are exercised with NO live database.
 */

import { schema } from "@gtmgrid/db";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { Context, Data, Effect, Layer, Option } from "effect";
import { DbClient } from "../db-client.js";

/** A field-mapping entry: a JSON path -> the target column id. */
export interface WebhookMappingEntry {
  readonly path: string;
  readonly columnId: string;
}

/** The webhook's receive behaviour. */
export type WebhookMode = "create" | "upsert";

/** A webhook row projection the domain uses. Mirrors `webhooks`. */
export interface Webhook {
  readonly id: string;
  readonly workspaceId: string;
  readonly tableId: string;
  readonly name: string | null;
  readonly token: string;
  readonly signingSecret: string | null;
  readonly mapping: readonly WebhookMappingEntry[];
  readonly enabled: boolean;
  readonly autoRun: boolean | null;
  readonly mode: WebhookMode | null;
  readonly upsertKey: string | null;
  readonly createdAt: number;
  readonly lastReceivedAt: number | null;
  readonly receivedCount: number | null;
}

/** Fields a `createWebhook` insert supplies. */
export interface WebhookInsert {
  readonly workspaceId: string;
  readonly tableId: string;
  readonly name: string | null;
  readonly token: string;
  readonly signingSecret: string | null;
  readonly mapping: readonly WebhookMappingEntry[];
  readonly enabled: boolean;
  readonly autoRun: boolean | null;
  readonly mode: WebhookMode | null;
  readonly upsertKey: string | null;
  readonly createdAt: number;
}

/** A patch over a webhook row; only present fields are written. */
export interface WebhookPatch {
  readonly name?: string | null;
  readonly mapping?: readonly WebhookMappingEntry[];
  readonly enabled?: boolean;
  readonly autoRun?: boolean | null;
  readonly mode?: WebhookMode | null;
  readonly upsertKey?: string | null;
  readonly token?: string;
  readonly signingSecret?: string | null;
  readonly lastReceivedAt?: number | null;
  readonly receivedCount?: number | null;
}

/** A grid table row projection (the worker's getTable + resolveCell paths). */
export interface GridTable {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly name: string;
  readonly position: number;
  readonly createdAt: number;
}

/** A grid column projection. */
export interface GridColumn {
  readonly id: string;
  readonly tableId: string;
}

/** A grid row projection (id + position, for the next-position computation). */
export interface GridRow {
  readonly id: string;
  readonly tableId: string;
  readonly position: number;
}

/** A grid cell projection the worker reads/writes. */
export interface GridCell {
  readonly id: string;
  readonly rowId: string;
  readonly columnId: string;
  readonly value: unknown;
  /** Current status — needed so the worker COALESCE merge keeps it faithfully. */
  readonly status: string;
  readonly error: string | null;
  readonly updatedAt: number | null;
}

/** Cell fields persisted on an insert/upsert. */
export interface CellWrite {
  readonly value: unknown;
  readonly status: string;
  readonly error: string | null;
  readonly updatedAt: number | null;
}

/** The table/workspace a (row, column) cell write targets — resolveCellTarget. */
export interface CellTarget {
  /** The table the ROW belongs to. */
  readonly rowTableId: string;
  /** The table the COLUMN belongs to (must equal `rowTableId` for a valid cell). */
  readonly columnTableId: string;
  /** The workspace the row's table belongs to (the meter target). */
  readonly workspaceId: string;
}

/**
 * A merge patch for {@link WebhookRepo.upsertCell}. `hasValue` carries the
 * COALESCE presence of `value` (its presence in the body, even `null`, means
 * overwrite); `status` is optional (kept when omitted); `error` is taken as-is
 * (absent => null), mirroring the engine's `error = @error` write.
 */
export interface CellMergePatch {
  readonly hasValue: boolean;
  readonly value?: unknown;
  readonly status?: string;
  readonly error?: string | null;
}

/** Args for the collapsed upsert-cell-and-meter statement. */
export interface UpsertCellArgs {
  readonly workspaceId: string;
  readonly tableId: string;
  readonly rowId: string;
  readonly columnId: string;
  readonly patch: CellMergePatch;
  /**
   * When set, increment the workspace's cloud-actions counter by 1 IFF the
   * RESULTING (merged) status is terminal (`done`/`error`) — mirroring the old
   * `isTerminalStatus(merged.status)` gate, evaluated on the post-merge status
   * so it matches behaviour even when the patch omits `status`.
   */
  readonly meter: boolean;
  /** The timestamp to stamp the write with. */
  readonly updatedAt: number;
}

/** A workspace's cloud-actions quota snapshot the worker pre-checks. */
export interface WorkspaceQuota {
  readonly cloudActionsUsed: number | null;
  readonly cloudActionsLimit: number | null;
}

/** Raised when a webhook/grid read or write fails (DB/transport error). */
export class WebhookRepoError extends Data.TaggedError("WebhookRepoError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Reads/writes the `webhooks` table + the grid primitives the worker path needs.
 * Backed by Drizzle in production ({@link WebhookRepoLive}); by mutable in-memory
 * arrays in tests ({@link webhookRepoLayer}).
 */
export class WebhookRepo extends Context.Tag("WebhookRepo")<
  WebhookRepo,
  {
    // --- webhook config CRUD ---
    /** The webhook for `id`, or `None`. */
    readonly findById: (
      id: string,
    ) => Effect.Effect<Option.Option<Webhook>, WebhookRepoError>;
    /** Webhooks bound to a table, newest first. */
    readonly listByTable: (
      tableId: string,
    ) => Effect.Effect<readonly Webhook[], WebhookRepoError>;
    /** The webhook for a public token, or `None` (worker resolve). */
    readonly findByToken: (
      token: string,
    ) => Effect.Effect<Option.Option<Webhook>, WebhookRepoError>;
    /** Insert a webhook, returning its id. */
    readonly insert: (
      values: WebhookInsert,
    ) => Effect.Effect<string, WebhookRepoError>;
    /** Patch a webhook by id. */
    readonly patch: (
      id: string,
      patch: WebhookPatch,
    ) => Effect.Effect<void, WebhookRepoError>;
    /** Delete a webhook by id. */
    readonly remove: (id: string) => Effect.Effect<void, WebhookRepoError>;

    // --- grid primitives the worker writes through ---
    /** A table by id, or `None`. */
    readonly findTable: (
      tableId: string,
    ) => Effect.Effect<Option.Option<GridTable>, WebhookRepoError>;
    /** A row by id, or `None`. */
    readonly findRow: (
      rowId: string,
    ) => Effect.Effect<Option.Option<GridRow>, WebhookRepoError>;
    /** A column by id, or `None`. */
    readonly findColumn: (
      columnId: string,
    ) => Effect.Effect<Option.Option<GridColumn>, WebhookRepoError>;
    /** Columns of a table (sorted by position) — for getTable + validation. */
    readonly listColumns: (
      tableId: string,
    ) => Effect.Effect<readonly GridColumn[], WebhookRepoError>;
    /** Rows of a table (sorted by position) — for getTable + next position. */
    readonly listRows: (
      tableId: string,
    ) => Effect.Effect<readonly GridRow[], WebhookRepoError>;
    /** All cells of a table — for getTable + the upsert-key scan. */
    readonly listCellsByTable: (
      tableId: string,
    ) => Effect.Effect<readonly GridCell[], WebhookRepoError>;
    /** Cells of a single row — for the upsert patch-or-insert. */
    readonly listCellsByRow: (
      rowId: string,
    ) => Effect.Effect<readonly GridCell[], WebhookRepoError>;
    /** The cell at (rowId, columnId), or `None` — for setCell merge. */
    readonly findCell: (
      rowId: string,
      columnId: string,
    ) => Effect.Effect<Option.Option<GridCell>, WebhookRepoError>;
    /** Insert a row, returning its id. */
    readonly insertRow: (values: {
      readonly workspaceId: string;
      readonly tableId: string;
      readonly position: number;
      readonly createdAt: number;
    }) => Effect.Effect<string, WebhookRepoError>;
    /** Insert a cell, returning its id. */
    readonly insertCell: (values: {
      readonly workspaceId: string;
      readonly tableId: string;
      readonly rowId: string;
      readonly columnId: string;
      readonly cell: CellWrite;
    }) => Effect.Effect<string, WebhookRepoError>;
    /** Patch an existing cell by id. */
    readonly patchCell: (
      cellId: string,
      cell: CellWrite,
    ) => Effect.Effect<void, WebhookRepoError>;
    /**
     * Resolve the table/workspace a (row, column) write targets in ONE query.
     * Returns the row's tableId, the column's tableId (so the caller can assert
     * they share a table), and the row's workspace. `None` when EITHER the row
     * or the column does not exist. This replaces the prior findRow + findColumn
     * + findTable trio so a worker cell write resolves its target in a single
     * round-trip.
     */
    readonly resolveCellTarget: (
      rowId: string,
      columnId: string,
    ) => Effect.Effect<Option.Option<CellTarget>, WebhookRepoError>;
    /**
     * Upsert a cell at (rowId, columnId) with COALESCE merge semantics AND
     * (when `meter` is set) increment the workspace's cloud-actions counter — in
     * ONE statement (an `INSERT ... ON CONFLICT (row_id, column_id) DO UPDATE`
     * over the `cells_by_row_column` unique index, with the meter folded in as a
     * CTE). This collapses the prior read (findCell) + write (insert/patch) +
     * meter (findTable + update) into a single query. The merge mirrors
     * {@link CellMerge.mergeCellPatch}: `value`/`status` are kept when the patch
     * omits them, `error` is always taken from the patch (absent => null), and
     * `updatedAt` is always stamped. Returns the cell's id.
     */
    readonly upsertCell: (args: UpsertCellArgs) => Effect.Effect<
      string,
      WebhookRepoError
    >;

    // --- worker credential fetch ---
    /**
     * The ciphertext of a SHARED (workspace-scope, `ownerUserId IS NULL`)
     * connector credential for (workspaceId, extensionId), or `None`. The worker
     * can never reach a member's personal credential — only shared rows. The
     * caller decrypts the returned envelope; this repo only reads ciphertext.
     */
    readonly findSharedCredentialEnc: (
      workspaceId: string,
      extensionId: string,
    ) => Effect.Effect<Option.Option<string>, WebhookRepoError>;

    // --- quota + metering ---
    /** A workspace's cloud-actions quota snapshot, or `None`. */
    readonly findWorkspaceQuota: (
      workspaceId: string,
    ) => Effect.Effect<Option.Option<WorkspaceQuota>, WebhookRepoError>;
    /**
     * Meter `by` billable cloud actions onto a workspace by incrementing its
     * `cloudActionsUsed` counter — the SINGLE cloud-actions surface (the grid
     * `MeterService` writes the same column). The legacy `cloudActionsPending`
     * counter + cron flush are gone; accounting is immediate on the write path.
     */
    readonly meterActions: (
      workspaceId: string,
      by: number,
    ) => Effect.Effect<void, WebhookRepoError>;
  }
>() {}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Coerce a stored mapping jsonb back into the typed entry array. */
function asMapping(value: unknown): readonly WebhookMappingEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((e) => {
    if (e === null || typeof e !== "object") return [];
    const rec = e as Record<string, unknown>;
    if (typeof rec.path === "string" && typeof rec.columnId === "string") {
      return [{ path: rec.path, columnId: rec.columnId }];
    }
    return [];
  });
}

/** Map a Drizzle webhook row to the domain {@link Webhook}. */
function rowToWebhook(r: {
  id: string;
  workspaceId: string;
  tableId: string;
  name: string | null;
  token: string;
  signingSecret: string | null;
  mapping: unknown;
  enabled: boolean;
  autoRun: boolean | null;
  mode: WebhookMode | null;
  upsertKey: string | null;
  createdAt: number;
  lastReceivedAt: number | null;
  receivedCount: number | null;
}): Webhook {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    tableId: r.tableId,
    name: r.name,
    token: r.token,
    signingSecret: r.signingSecret,
    mapping: asMapping(r.mapping),
    enabled: r.enabled,
    autoRun: r.autoRun,
    mode: r.mode,
    upsertKey: r.upsertKey,
    createdAt: r.createdAt,
    lastReceivedAt: r.lastReceivedAt,
    receivedCount: r.receivedCount,
  };
}

const fail = (message: string) => (cause: unknown) =>
  new WebhookRepoError({
    message: cause instanceof Error ? cause.message : message,
    cause,
  });

/**
 * The Drizzle-backed `WebhookRepo` Layer. Depends on {@link DbClient}. Non-uuid
 * ids short-circuit to `None`/empty (the Postgres uuid columns would otherwise
 * reject the predicate), matching the Convex `normalizeId -> null` behaviour.
 */
export const WebhookRepoLive: Layer.Layer<WebhookRepo, never, DbClient> =
  Layer.effect(
    WebhookRepo,
    Effect.gen(function* () {
      const db = yield* DbClient;
      return {
        findById: (id) =>
          UUID_RE.test(id)
            ? Effect.tryPromise({
                try: async () => {
                  const rows = await db
                    .select()
                    .from(schema.webhooks)
                    .where(eq(schema.webhooks.id, id))
                    .limit(1);
                  return Option.fromNullable(
                    rows[0] === undefined ? null : rowToWebhook(rows[0]),
                  );
                },
                catch: fail("webhook lookup failed"),
              })
            : Effect.succeed(Option.none<Webhook>()),

        listByTable: (tableId) =>
          UUID_RE.test(tableId)
            ? Effect.tryPromise({
                try: async () => {
                  const rows = await db
                    .select()
                    .from(schema.webhooks)
                    .where(eq(schema.webhooks.tableId, tableId))
                    .orderBy(desc(schema.webhooks.createdAt));
                  return rows.map(rowToWebhook);
                },
                catch: fail("webhook list failed"),
              })
            : Effect.succeed([] as readonly Webhook[]),

        findByToken: (token) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await db
                .select()
                .from(schema.webhooks)
                .where(eq(schema.webhooks.token, token))
                .limit(1);
              return Option.fromNullable(
                rows[0] === undefined ? null : rowToWebhook(rows[0]),
              );
            },
            catch: fail("token lookup failed"),
          }),

        insert: (values) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await db
                .insert(schema.webhooks)
                .values({
                  workspaceId: values.workspaceId,
                  tableId: values.tableId,
                  name: values.name,
                  token: values.token,
                  signingSecret: values.signingSecret,
                  mapping: values.mapping,
                  enabled: values.enabled,
                  autoRun: values.autoRun,
                  mode: values.mode,
                  upsertKey: values.upsertKey,
                  createdAt: values.createdAt,
                  lastReceivedAt: null,
                  receivedCount: 0,
                })
                .returning({ id: schema.webhooks.id });
              const id = rows[0]?.id;
              if (id === undefined) {
                throw new Error("webhook insert returned no id");
              }
              return id;
            },
            catch: fail("webhook insert failed"),
          }),

        patch: (id, patch) =>
          Effect.tryPromise({
            try: async () => {
              await db
                .update(schema.webhooks)
                .set(patch)
                .where(eq(schema.webhooks.id, id));
            },
            catch: fail("webhook patch failed"),
          }),

        remove: (id) =>
          Effect.tryPromise({
            try: async () => {
              await db.delete(schema.webhooks).where(eq(schema.webhooks.id, id));
            },
            catch: fail("webhook delete failed"),
          }),

        findTable: (tableId) =>
          UUID_RE.test(tableId)
            ? Effect.tryPromise({
                try: async () => {
                  const rows = await db
                    .select()
                    .from(schema.tables)
                    .where(eq(schema.tables.id, tableId))
                    .limit(1);
                  return Option.fromNullable(rows[0] ?? null);
                },
                catch: fail("table lookup failed"),
              })
            : Effect.succeed(Option.none<GridTable>()),

        findRow: (rowId) =>
          UUID_RE.test(rowId)
            ? Effect.tryPromise({
                try: async () => {
                  const rows = await db
                    .select({
                      id: schema.rows.id,
                      tableId: schema.rows.tableId,
                      position: schema.rows.position,
                    })
                    .from(schema.rows)
                    .where(eq(schema.rows.id, rowId))
                    .limit(1);
                  return Option.fromNullable(rows[0] ?? null);
                },
                catch: fail("row lookup failed"),
              })
            : Effect.succeed(Option.none<GridRow>()),

        findColumn: (columnId) =>
          UUID_RE.test(columnId)
            ? Effect.tryPromise({
                try: async () => {
                  const rows = await db
                    .select({
                      id: schema.columns.id,
                      tableId: schema.columns.tableId,
                    })
                    .from(schema.columns)
                    .where(eq(schema.columns.id, columnId))
                    .limit(1);
                  return Option.fromNullable(rows[0] ?? null);
                },
                catch: fail("column lookup failed"),
              })
            : Effect.succeed(Option.none<GridColumn>()),

        listColumns: (tableId) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await db
                .select({
                  id: schema.columns.id,
                  tableId: schema.columns.tableId,
                })
                .from(schema.columns)
                .where(eq(schema.columns.tableId, tableId))
                .orderBy(asc(schema.columns.position));
              return rows;
            },
            catch: fail("column list failed"),
          }),

        listRows: (tableId) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await db
                .select({
                  id: schema.rows.id,
                  tableId: schema.rows.tableId,
                  position: schema.rows.position,
                })
                .from(schema.rows)
                .where(eq(schema.rows.tableId, tableId))
                .orderBy(asc(schema.rows.position));
              return rows;
            },
            catch: fail("row list failed"),
          }),

        listCellsByTable: (tableId) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await db
                .select({
                  id: schema.cells.id,
                  rowId: schema.cells.rowId,
                  columnId: schema.cells.columnId,
                  value: schema.cells.value,
                  status: schema.cells.status,
                  error: schema.cells.error,
                  updatedAt: schema.cells.updatedAt,
                })
                .from(schema.cells)
                .where(eq(schema.cells.tableId, tableId));
              return rows;
            },
            catch: fail("cell list failed"),
          }),

        listCellsByRow: (rowId) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await db
                .select({
                  id: schema.cells.id,
                  rowId: schema.cells.rowId,
                  columnId: schema.cells.columnId,
                  value: schema.cells.value,
                  status: schema.cells.status,
                  error: schema.cells.error,
                  updatedAt: schema.cells.updatedAt,
                })
                .from(schema.cells)
                .where(eq(schema.cells.rowId, rowId));
              return rows;
            },
            catch: fail("cell-by-row list failed"),
          }),

        findCell: (rowId, columnId) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await db
                .select({
                  id: schema.cells.id,
                  rowId: schema.cells.rowId,
                  columnId: schema.cells.columnId,
                  value: schema.cells.value,
                  status: schema.cells.status,
                  error: schema.cells.error,
                  updatedAt: schema.cells.updatedAt,
                })
                .from(schema.cells)
                .where(
                  and(
                    eq(schema.cells.rowId, rowId),
                    eq(schema.cells.columnId, columnId),
                  ),
                )
                .limit(1);
              return Option.fromNullable(rows[0] ?? null);
            },
            catch: fail("cell lookup failed"),
          }),

        insertRow: (values) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await db
                .insert(schema.rows)
                .values(values)
                .returning({ id: schema.rows.id });
              const id = rows[0]?.id;
              if (id === undefined) throw new Error("row insert returned no id");
              return id;
            },
            catch: fail("row insert failed"),
          }),

        insertCell: (values) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await db
                .insert(schema.cells)
                .values({
                  workspaceId: values.workspaceId,
                  tableId: values.tableId,
                  rowId: values.rowId,
                  columnId: values.columnId,
                  value: values.cell.value,
                  status: values.cell.status as never,
                  error: values.cell.error,
                  updatedAt: values.cell.updatedAt,
                })
                .returning({ id: schema.cells.id });
              const id = rows[0]?.id;
              if (id === undefined) {
                throw new Error("cell insert returned no id");
              }
              return id;
            },
            catch: fail("cell insert failed"),
          }),

        patchCell: (cellId, cell) =>
          Effect.tryPromise({
            try: async () => {
              await db
                .update(schema.cells)
                .set({
                  value: cell.value,
                  status: cell.status as never,
                  error: cell.error,
                  updatedAt: cell.updatedAt,
                })
                .where(eq(schema.cells.id, cellId));
            },
            catch: fail("cell patch failed"),
          }),

        resolveCellTarget: (rowId, columnId) =>
          UUID_RE.test(rowId) && UUID_RE.test(columnId)
            ? Effect.tryPromise({
                try: async () => {
                  // One round-trip: the row joined to its table (for the
                  // workspace) plus the column's table id. A cross join of the
                  // single matching row + single matching column yields one row
                  // when BOTH exist, none otherwise.
                  const out = await db
                    .select({
                      rowTableId: schema.rows.tableId,
                      workspaceId: schema.tables.workspaceId,
                      columnTableId: schema.columns.tableId,
                    })
                    .from(schema.rows)
                    .innerJoin(
                      schema.tables,
                      eq(schema.tables.id, schema.rows.tableId),
                    )
                    .innerJoin(
                      schema.columns,
                      eq(schema.columns.id, columnId),
                    )
                    .where(eq(schema.rows.id, rowId))
                    .limit(1);
                  const r = out[0];
                  return r === undefined
                    ? Option.none<CellTarget>()
                    : Option.some<CellTarget>({
                        rowTableId: r.rowTableId,
                        columnTableId: r.columnTableId,
                        workspaceId: r.workspaceId,
                      });
                },
                catch: fail("cell target resolve failed"),
              })
            : Effect.succeed(Option.none<CellTarget>()),

        upsertCell: (args) =>
          Effect.tryPromise({
            try: async () => {
              const { sql } = schema;
              const { patch } = args;
              // COALESCE merge expressed in SQL on the (row_id, column_id)
              // unique index, with the meter increment folded into the same
              // statement as a CTE so a terminal cell write is a SINGLE query.
              //
              // value : overwrite only when the patch carries it (`hasValue`).
              // status: overwrite only when the patch carries it.
              // error : always from the patch (absent => null).
              // updatedAt: always stamped.
              const valueJson =
                patch.hasValue && patch.value !== undefined
                  ? JSON.stringify(patch.value)
                  : null;
              // On a fresh cell with no status patch, the COALESCE base is the
              // engine's empty default ("empty"); on update, an omitted status
              // keeps the existing one.
              const insertStatus = patch.status ?? "empty";
              const errorVal = patch.error ?? null;
              // Meter only when this path meters AND the RESULTING status is
              // terminal — folded into the same statement as a CTE keyed off the
              // upserted row's final status.
              const meterCte = args.meter
                ? sql`, metered AS (
                    UPDATE workspaces
                    SET cloud_actions_used = coalesce(cloud_actions_used, 0) + 1
                    WHERE id = ${args.workspaceId}
                      AND EXISTS (
                        SELECT 1 FROM upserted
                        WHERE upserted.status IN ('done', 'error')
                      )
                  )`
                : sql``;
              const rows = await db.execute<{ id: string }>(sql`
                WITH upserted AS (
                  INSERT INTO cells
                    (workspace_id, table_id, row_id, column_id, value, status, error, updated_at)
                  VALUES (
                    ${args.workspaceId},
                    ${args.tableId},
                    ${args.rowId},
                    ${args.columnId},
                    ${patch.hasValue ? sql`${valueJson}::jsonb` : sql`NULL`},
                    ${insertStatus},
                    ${errorVal},
                    ${args.updatedAt}
                  )
                  ON CONFLICT (row_id, column_id) DO UPDATE SET
                    value = ${patch.hasValue ? sql`${valueJson}::jsonb` : sql`cells.value`},
                    status = ${patch.status !== undefined ? sql`${insertStatus}` : sql`cells.status`},
                    error = ${errorVal},
                    updated_at = ${args.updatedAt}
                  RETURNING id, status
                )${meterCte}
                SELECT id FROM upserted
              `);
              const id = rows[0]?.id;
              if (id === undefined) {
                throw new Error("cell upsert returned no id");
              }
              return id;
            },
            catch: fail("cell upsert failed"),
          }),

        findSharedCredentialEnc: (workspaceId, extensionId) =>
          !UUID_RE.test(workspaceId)
            ? Effect.succeed(Option.none<string>())
            : Effect.tryPromise({
                try: async () => {
                  const rows = await db
                    .select({ secretsEnc: schema.credentials.secretsEnc })
                    .from(schema.credentials)
                    .where(
                      and(
                        eq(schema.credentials.workspaceId, workspaceId),
                        eq(schema.credentials.extensionId, extensionId),
                        eq(schema.credentials.scope, "workspace"),
                        isNull(schema.credentials.ownerUserId),
                      ),
                    )
                    .limit(1);
                  return Option.fromNullable(rows[0]?.secretsEnc ?? null);
                },
                catch: fail("shared credential lookup failed"),
              }),

        findWorkspaceQuota: (workspaceId) =>
          UUID_RE.test(workspaceId)
            ? Effect.tryPromise({
                try: async () => {
                  const rows = await db
                    .select({
                      cloudActionsUsed: schema.workspaces.cloudActionsUsed,
                      cloudActionsLimit: schema.workspaces.cloudActionsLimit,
                    })
                    .from(schema.workspaces)
                    .where(eq(schema.workspaces.id, workspaceId))
                    .limit(1);
                  return Option.fromNullable(rows[0] ?? null);
                },
                catch: fail("workspace quota lookup failed"),
              })
            : Effect.succeed(Option.none<WorkspaceQuota>()),

        meterActions: (workspaceId, by) =>
          Effect.tryPromise({
            try: async () => {
              await db
                .update(schema.workspaces)
                .set({
                  cloudActionsUsed: schema.sql`coalesce(${schema.workspaces.cloudActionsUsed}, 0) + ${by}`,
                })
                .where(eq(schema.workspaces.id, workspaceId));
            },
            catch: fail("meter increment failed"),
          }),
      };
    }),
  );

/**
 * An in-memory `WebhookRepo` Layer backed by MUTABLE fixture arrays, so a test
 * can exercise the insert/upsert/prune side effects (rows/cells grow, telemetry
 * bumps) exactly like the Drizzle path, with NO live database. The arrays are
 * shared by reference, so a test can read them back after the service runs.
 */
export const webhookRepoLayer = (fixtures: {
  webhooks?: Webhook[];
  tables?: GridTable[];
  columns?: GridColumn[];
  rows?: GridRow[];
  cells?: GridCell[];
  quotas?: Map<string, WorkspaceQuota>;
  /** Shared-credential ciphertext keyed by `${workspaceId}:${extensionId}`. */
  credentials?: Map<string, string>;
}): Layer.Layer<WebhookRepo> => {
  const webhooks = fixtures.webhooks ?? [];
  const tables = fixtures.tables ?? [];
  const columns = fixtures.columns ?? [];
  const rows = fixtures.rows ?? [];
  const cells = fixtures.cells ?? [];
  const quotas = fixtures.quotas ?? new Map<string, WorkspaceQuota>();
  const credentials = fixtures.credentials ?? new Map<string, string>();
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}_${++seq}`;

  return Layer.succeed(WebhookRepo, {
    findById: (id) =>
      Effect.succeed(Option.fromNullable(webhooks.find((w) => w.id === id))),
    listByTable: (tableId) =>
      Effect.succeed(
        [...webhooks]
          .filter((w) => w.tableId === tableId)
          .sort((a, b) => b.createdAt - a.createdAt),
      ),
    findByToken: (token) =>
      Effect.succeed(
        Option.fromNullable(webhooks.find((w) => w.token === token)),
      ),
    insert: (values) =>
      Effect.sync(() => {
        const id = nextId("webhook");
        webhooks.push({
          ...values,
          id,
          lastReceivedAt: null,
          receivedCount: 0,
        });
        return id;
      }),
    patch: (id, patch) =>
      Effect.sync(() => {
        const idx = webhooks.findIndex((w) => w.id === id);
        if (idx >= 0) webhooks[idx] = { ...webhooks[idx], ...patch };
      }),
    remove: (id) =>
      Effect.sync(() => {
        const idx = webhooks.findIndex((w) => w.id === id);
        if (idx >= 0) webhooks.splice(idx, 1);
      }),
    findTable: (tableId) =>
      Effect.succeed(Option.fromNullable(tables.find((t) => t.id === tableId))),
    findRow: (rowId) =>
      Effect.succeed(Option.fromNullable(rows.find((r) => r.id === rowId))),
    findColumn: (columnId) =>
      Effect.succeed(
        Option.fromNullable(columns.find((c) => c.id === columnId)),
      ),
    listColumns: (tableId) =>
      Effect.succeed(columns.filter((c) => c.tableId === tableId)),
    listRows: (tableId) =>
      Effect.succeed(
        [...rows]
          .filter((r) => r.tableId === tableId)
          .sort((a, b) => a.position - b.position),
      ),
    listCellsByTable: (tableId) =>
      Effect.succeed(
        cells.filter((c) => {
          const r = rows.find((row) => row.id === c.rowId);
          return r?.tableId === tableId;
        }),
      ),
    listCellsByRow: (rowId) =>
      Effect.succeed(cells.filter((c) => c.rowId === rowId)),
    findCell: (rowId, columnId) =>
      Effect.succeed(
        Option.fromNullable(
          cells.find((c) => c.rowId === rowId && c.columnId === columnId),
        ),
      ),
    insertRow: (values) =>
      Effect.sync(() => {
        const id = nextId("row");
        rows.push({ id, tableId: values.tableId, position: values.position });
        return id;
      }),
    insertCell: (values) =>
      Effect.sync(() => {
        const id = nextId("cell");
        cells.push({
          id,
          rowId: values.rowId,
          columnId: values.columnId,
          value: values.cell.value,
          status: values.cell.status,
          error: values.cell.error,
          updatedAt: values.cell.updatedAt,
        });
        return id;
      }),
    patchCell: (cellId, cell) =>
      Effect.sync(() => {
        const idx = cells.findIndex((c) => c.id === cellId);
        if (idx >= 0) {
          cells[idx] = {
            ...cells[idx],
            value: cell.value,
            status: cell.status,
            error: cell.error,
            updatedAt: cell.updatedAt,
          };
        }
      }),
    resolveCellTarget: (rowId, columnId) =>
      Effect.succeed(
        ((): Option.Option<CellTarget> => {
          const row = rows.find((r) => r.id === rowId);
          const column = columns.find((c) => c.id === columnId);
          if (row === undefined || column === undefined) {
            return Option.none<CellTarget>();
          }
          const table = tables.find((t) => t.id === row.tableId);
          return Option.some<CellTarget>({
            rowTableId: row.tableId,
            columnTableId: column.tableId,
            workspaceId: table?.workspaceId ?? "",
          });
        })(),
      ),
    upsertCell: (args) =>
      Effect.sync(() => {
        const { patch } = args;
        const idx = cells.findIndex(
          (c) => c.rowId === args.rowId && c.columnId === args.columnId,
        );
        // COALESCE merge mirroring the SQL path: value/status kept when the
        // patch omits them, error always taken from the patch, updatedAt always
        // stamped.
        const prev = idx >= 0 ? cells[idx] : undefined;
        const merged = {
          value: patch.hasValue ? patch.value : (prev?.value ?? null),
          status: patch.status ?? prev?.status ?? "empty",
          error: patch.error ?? null,
          updatedAt: args.updatedAt,
        };
        let id: string;
        if (idx >= 0 && prev !== undefined) {
          id = prev.id;
          cells[idx] = { ...prev, ...merged };
        } else {
          id = nextId("cell");
          cells.push({
            id,
            rowId: args.rowId,
            columnId: args.columnId,
            ...merged,
          });
        }
        if (
          args.meter &&
          (merged.status === "done" || merged.status === "error")
        ) {
          const q = quotas.get(args.workspaceId);
          quotas.set(args.workspaceId, {
            cloudActionsUsed: (q?.cloudActionsUsed ?? 0) + 1,
            cloudActionsLimit: q?.cloudActionsLimit ?? null,
          });
        }
        return id;
      }),
    findSharedCredentialEnc: (workspaceId, extensionId) =>
      Effect.succeed(
        Option.fromNullable(credentials.get(`${workspaceId}:${extensionId}`)),
      ),
    findWorkspaceQuota: (workspaceId) =>
      Effect.succeed(Option.fromNullable(quotas.get(workspaceId))),
    meterActions: (workspaceId, by) =>
      Effect.sync(() => {
        const q = quotas.get(workspaceId);
        const current = q?.cloudActionsUsed ?? 0;
        quotas.set(workspaceId, {
          cloudActionsUsed: current + by,
          cloudActionsLimit: q?.cloudActionsLimit ?? null,
        });
      }),
  });
};
