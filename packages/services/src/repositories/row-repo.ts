/**
 * `RowRepo` — the Effect <-> Drizzle adapter for the `rows` table.
 *
 * Ports the row reads/writes of `convex/tables.ts` (getTable's row load,
 * addRow :177, addRowsWithCells :214, deleteRow :309). `remove` relies on the
 * Postgres `ON DELETE CASCADE` FK to drop the row's cells; the in-memory Layer
 * mirrors that with {@link cascadeDeleteRow}.
 */

import { schema } from "@gtmgrid/db";
import { asc, eq } from "drizzle-orm";
import { Context, Data, Effect, Layer, Option } from "effect";
import { DbClient } from "../db-client.js";
import { cascadeDeleteRow, type GridStore } from "./grid-store.js";

/** A row row projection the grid domain uses. */
export interface Row {
  readonly id: string;
  readonly workspaceId: string;
  readonly tableId: string;
  readonly position: number;
  readonly createdAt: number;
}

/** Fields an `addRow` insert supplies. */
export interface NewRow {
  readonly workspaceId: string;
  readonly tableId: string;
  readonly position: number;
  readonly createdAt: number;
}

/** Raised when a row read/write fails (DB/transport error). */
export class RowRepoError extends Data.TaggedError("RowRepoError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (op: string) => (cause: unknown) =>
  new RowRepoError({
    message: cause instanceof Error ? cause.message : `${op} failed`,
    cause,
  });

/** Reads/writes the `rows` table. */
export class RowRepo extends Context.Tag("RowRepo")<
  RowRepo,
  {
    /** The row for `id`, or `None`. */
    readonly findById: (
      id: string,
    ) => Effect.Effect<Option.Option<Row>, RowRepoError>;
    /** A table's rows, ordered by position then creation. */
    readonly listByTable: (
      tableId: string,
    ) => Effect.Effect<readonly Row[], RowRepoError>;
    /** Insert a row and return its id. */
    readonly insert: (values: NewRow) => Effect.Effect<string, RowRepoError>;
    /** Insert many rows in one call, returning ids in input order. */
    readonly insertMany: (
      values: readonly NewRow[],
    ) => Effect.Effect<readonly string[], RowRepoError>;
    /** Delete a row (FK cascade drops its cells). */
    readonly remove: (id: string) => Effect.Effect<void, RowRepoError>;
  }
>() {}

/** The Drizzle-backed `RowRepo` Layer. */
export const RowRepoLive: Layer.Layer<RowRepo, never, DbClient> = Layer.effect(
  RowRepo,
  Effect.gen(function* () {
    const db = yield* DbClient;
    const cols = {
      id: schema.rows.id,
      workspaceId: schema.rows.workspaceId,
      tableId: schema.rows.tableId,
      position: schema.rows.position,
      createdAt: schema.rows.createdAt,
    } as const;
    return {
      findById: (id) =>
        UUID_RE.test(id)
          ? Effect.tryPromise({
              try: async () => {
                const rows = await db
                  .select(cols)
                  .from(schema.rows)
                  .where(eq(schema.rows.id, id))
                  .limit(1);
                return Option.fromNullable(rows[0] ?? null);
              },
              catch: fail("row lookup"),
            })
          : Effect.succeed(Option.none<Row>()),
      listByTable: (tableId) =>
        UUID_RE.test(tableId)
          ? Effect.tryPromise({
              try: () =>
                db
                  .select(cols)
                  .from(schema.rows)
                  .where(eq(schema.rows.tableId, tableId))
                  .orderBy(
                    asc(schema.rows.position),
                    asc(schema.rows.createdAt),
                  ),
              catch: fail("row list"),
            })
          : Effect.succeed([] as readonly Row[]),
      insert: (values) =>
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
          catch: fail("row insert"),
        }),
      insertMany: (values) =>
        values.length === 0
          ? Effect.succeed([] as readonly string[])
          : Effect.tryPromise({
              try: async () => {
                const rows = await db
                  .insert(schema.rows)
                  .values([...values])
                  .returning({ id: schema.rows.id });
                return rows.map((r) => r.id);
              },
              catch: fail("row bulk insert"),
            }),
      remove: (id) =>
        Effect.tryPromise({
          try: async () => {
            await db.delete(schema.rows).where(eq(schema.rows.id, id));
          },
          catch: fail("row delete"),
        }),
    };
  }),
);

/** An in-memory `RowRepo` Layer over a shared {@link GridStore}. */
export const rowRepoLayer = (store: GridStore): Layer.Layer<RowRepo> =>
  Layer.succeed(RowRepo, {
    findById: (id) =>
      Effect.succeed(Option.fromNullable(store.rows.find((r) => r.id === id))),
    listByTable: (tableId) =>
      Effect.succeed(
        [...store.rows]
          .filter((r) => r.tableId === tableId)
          .sort(
            (a, b) => a.position - b.position || a.createdAt - b.createdAt,
          ),
      ),
    insert: (values) =>
      Effect.sync(() => {
        const id = store.nextId("row");
        store.rows.push({ id, ...values });
        return id;
      }),
    insertMany: (values) =>
      Effect.sync(() =>
        values.map((v) => {
          const id = store.nextId("row");
          store.rows.push({ id, ...v });
          return id;
        }),
      ),
    remove: (id) => Effect.sync(() => cascadeDeleteRow(store, id)),
  });
