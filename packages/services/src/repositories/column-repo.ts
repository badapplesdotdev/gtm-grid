/**
 * `ColumnRepo` — the Effect <-> Drizzle adapter for the `columns` table.
 *
 * Ports the column reads/writes of `convex/tables.ts` (getTable's column load,
 * addColumn :137, deleteColumn :297). `remove` relies on the Postgres
 * `ON DELETE CASCADE` FK to drop the column's cells; the in-memory Layer mirrors
 * that with {@link cascadeDeleteColumn}.
 */

import { schema } from "@gtmgrid/db";
import { asc, eq, max } from "drizzle-orm";
import { Context, Data, Effect, Layer, Option } from "effect";
import { DbClient } from "../db-client.js";
import { cascadeDeleteColumn, type GridStore } from "./grid-store.js";

/** A column kind literal — manual cell or function column. */
export type ColumnKind = "manual" | "function";

/** The full column projection getTable returns to the desktop grid. */
export interface Column {
  readonly id: string;
  readonly workspaceId: string;
  readonly tableId: string;
  readonly name: string;
  readonly type: string;
  readonly kind: ColumnKind;
  readonly provider: string | null;
  readonly method: string | null;
  readonly code: string | null;
  readonly params: unknown;
  readonly condition: string | null;
  readonly position: number;
  readonly createdAt: number;
}

/** Fields an `addColumn` insert supplies. */
export interface NewColumn {
  readonly workspaceId: string;
  readonly tableId: string;
  readonly name: string;
  readonly type: string;
  readonly kind: ColumnKind;
  readonly provider: string | null;
  readonly method: string | null;
  readonly code: string | null;
  readonly params: unknown;
  readonly condition: string | null;
  readonly position: number;
  readonly createdAt: number;
}

/** The mutable fields an `updateColumn` may patch (id/table/workspace are fixed). */
export interface ColumnPatch {
  readonly name?: string;
  readonly type?: string;
  readonly kind?: ColumnKind;
  readonly provider?: string | null;
  readonly method?: string | null;
  readonly code?: string | null;
  readonly params?: unknown;
  readonly condition?: string | null;
}

/** Raised when a column read/write fails (DB/transport error). */
export class ColumnRepoError extends Data.TaggedError("ColumnRepoError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (op: string) => (cause: unknown) =>
  new ColumnRepoError({
    message: cause instanceof Error ? cause.message : `${op} failed`,
    cause,
  });

/** Reads/writes the `columns` table. */
export class ColumnRepo extends Context.Tag("ColumnRepo")<
  ColumnRepo,
  {
    /** The column for `id`, or `None`. */
    readonly findById: (
      id: string,
    ) => Effect.Effect<Option.Option<Column>, ColumnRepoError>;
    /** A table's columns, ordered by position then creation. */
    readonly listByTable: (
      tableId: string,
    ) => Effect.Effect<readonly Column[], ColumnRepoError>;
    /**
     * The position for the NEXT appended column: `MAX(position) + 1`, or `0` when
     * the table has no columns. Computed server-side (one `MAX` aggregate) so
     * adding a column never loads every column just to find the tail.
     */
    readonly nextPosition: (
      tableId: string,
    ) => Effect.Effect<number, ColumnRepoError>;
    /** Insert a column and return its id. */
    readonly insert: (
      values: NewColumn,
    ) => Effect.Effect<string, ColumnRepoError>;
    /** Patch a column's mutable fields; resolves to the updated projection. */
    readonly update: (
      id: string,
      patch: ColumnPatch,
    ) => Effect.Effect<Option.Option<Column>, ColumnRepoError>;
    /** Delete a column (FK cascade drops its cells). */
    readonly remove: (id: string) => Effect.Effect<void, ColumnRepoError>;
  }
>() {}

/** The Drizzle-backed `ColumnRepo` Layer. */
export const ColumnRepoLive: Layer.Layer<ColumnRepo, never, DbClient> =
  Layer.effect(
    ColumnRepo,
    Effect.gen(function* () {
      const db = yield* DbClient;
      const cols = {
        id: schema.columns.id,
        workspaceId: schema.columns.workspaceId,
        tableId: schema.columns.tableId,
        name: schema.columns.name,
        type: schema.columns.type,
        kind: schema.columns.kind,
        provider: schema.columns.provider,
        method: schema.columns.method,
        code: schema.columns.code,
        params: schema.columns.params,
        condition: schema.columns.condition,
        position: schema.columns.position,
        createdAt: schema.columns.createdAt,
      } as const;
      return {
        findById: (id) =>
          UUID_RE.test(id)
            ? Effect.tryPromise({
                try: async () => {
                  const rows = await db
                    .select(cols)
                    .from(schema.columns)
                    .where(eq(schema.columns.id, id))
                    .limit(1);
                  return Option.fromNullable(rows[0] ?? null);
                },
                catch: fail("column lookup"),
              })
            : Effect.succeed(Option.none<Column>()),
        listByTable: (tableId) =>
          UUID_RE.test(tableId)
            ? Effect.tryPromise({
                try: () =>
                  db
                    .select(cols)
                    .from(schema.columns)
                    .where(eq(schema.columns.tableId, tableId))
                    .orderBy(
                      asc(schema.columns.position),
                      asc(schema.columns.createdAt),
                    ),
                catch: fail("column list"),
              })
            : Effect.succeed([] as readonly Column[]),
        nextPosition: (tableId) =>
          !UUID_RE.test(tableId)
            ? Effect.succeed(0)
            : Effect.tryPromise({
                try: async () => {
                  const rows = await db
                    .select({ max: max(schema.columns.position) })
                    .from(schema.columns)
                    .where(eq(schema.columns.tableId, tableId));
                  const m = rows[0]?.max;
                  return m === null || m === undefined ? 0 : Number(m) + 1;
                },
                catch: fail("column next position"),
              }),
        insert: (values) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await db
                .insert(schema.columns)
                .values({
                  workspaceId: values.workspaceId,
                  tableId: values.tableId,
                  name: values.name,
                  type: values.type as never,
                  kind: values.kind,
                  provider: values.provider,
                  method: values.method,
                  code: values.code,
                  params: values.params,
                  condition: values.condition,
                  position: values.position,
                  createdAt: values.createdAt,
                })
                .returning({ id: schema.columns.id });
              const id = rows[0]?.id;
              if (id === undefined) {
                throw new Error("column insert returned no id");
              }
              return id;
            },
            catch: fail("column insert"),
          }),
        update: (id, patch) =>
          !UUID_RE.test(id)
            ? Effect.succeed(Option.none<Column>())
            : Effect.tryPromise({
                try: async () => {
                  // Only set the keys the caller actually provided, so an omitted
                  // field keeps its current value.
                  const set: Record<string, unknown> = {};
                  if (patch.name !== undefined) set.name = patch.name;
                  if (patch.type !== undefined) set.type = patch.type;
                  if (patch.kind !== undefined) set.kind = patch.kind;
                  if (patch.provider !== undefined) set.provider = patch.provider;
                  if (patch.method !== undefined) set.method = patch.method;
                  if (patch.code !== undefined) set.code = patch.code;
                  if (patch.params !== undefined) set.params = patch.params;
                  if (patch.condition !== undefined) set.condition = patch.condition;
                  if (Object.keys(set).length === 0) {
                    const rows = await db
                      .select(cols)
                      .from(schema.columns)
                      .where(eq(schema.columns.id, id))
                      .limit(1);
                    return Option.fromNullable(rows[0] ?? null);
                  }
                  const rows = await db
                    .update(schema.columns)
                    .set(set as never)
                    .where(eq(schema.columns.id, id))
                    .returning(cols);
                  return Option.fromNullable(rows[0] ?? null);
                },
                catch: fail("column update"),
              }),
        remove: (id) =>
          Effect.tryPromise({
            try: async () => {
              await db.delete(schema.columns).where(eq(schema.columns.id, id));
            },
            catch: fail("column delete"),
          }),
      };
    }),
  );

/** An in-memory `ColumnRepo` Layer over a shared {@link GridStore}. */
export const columnRepoLayer = (store: GridStore): Layer.Layer<ColumnRepo> =>
  Layer.succeed(ColumnRepo, {
    findById: (id) =>
      Effect.succeed(
        Option.fromNullable(store.columns.find((c) => c.id === id)),
      ),
    listByTable: (tableId) =>
      Effect.succeed(
        [...store.columns]
          .filter((c) => c.tableId === tableId)
          .sort(
            (a, b) => a.position - b.position || a.createdAt - b.createdAt,
          ),
      ),
    nextPosition: (tableId) =>
      Effect.succeed(
        store.columns
          .filter((c) => c.tableId === tableId)
          .reduce((m, c) => Math.max(m, c.position + 1), 0),
      ),
    insert: (values) =>
      Effect.sync(() => {
        const id = store.nextId("column");
        store.columns.push({ id, ...values });
        return id;
      }),
    update: (id, patch) =>
      Effect.sync(() => {
        const col = store.columns.find((c) => c.id === id);
        if (!col) return Option.none<Column>();
        if (patch.name !== undefined) col.name = patch.name;
        if (patch.type !== undefined) col.type = patch.type;
        if (patch.kind !== undefined) col.kind = patch.kind;
        if (patch.provider !== undefined) col.provider = patch.provider;
        if (patch.method !== undefined) col.method = patch.method;
        if (patch.code !== undefined) col.code = patch.code;
        if (patch.params !== undefined) col.params = patch.params;
        if (patch.condition !== undefined) col.condition = patch.condition;
        return Option.some(col);
      }),
    remove: (id) => Effect.sync(() => cascadeDeleteColumn(store, id)),
  });
