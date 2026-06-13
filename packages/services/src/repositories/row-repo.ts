/**
 * `RowRepo` — the Effect <-> Drizzle adapter for the `rows` table.
 *
 * Ports the row reads/writes of `convex/tables.ts` (getTable's row load,
 * addRow :177, addRowsWithCells :214, deleteRow :309). `remove` relies on the
 * Postgres `ON DELETE CASCADE` FK to drop the row's cells; the in-memory Layer
 * mirrors that with {@link cascadeDeleteRow}.
 */

import { schema } from "@gtmgrid/db";
import { and, asc, count, eq, gt, inArray, max, or } from "drizzle-orm";
import { Context, Data, Effect, Layer, Option } from "effect";
import { DbClient } from "../db-client.js";
import { chunk } from "./_chunk.js";
import {
  CELL_INSERT_CHUNK_SIZE,
  type NewCell,
} from "./cell-repo.js";
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

/**
 * A keyset cursor: the `(position, createdAt, id)` of the LAST row of the
 * previous page. Rows are ordered by ascending position (the stable display
 * order), so the next page is the rows strictly "after" this cursor.
 * `null` requests the first page. `position` alone is NOT unique
 * (it is `doublePrecision`), so the cursor tie-breaks on `createdAt` then `id`
 * — the SAME total order {@link RowRepo.listByTable} already uses, so a paged
 * read returns rows in exactly the order an unbounded read would.
 */
export interface RowCursor {
  readonly position: number;
  readonly createdAt: number;
  readonly id: string;
}

/** One page of rows plus the cursor to fetch the next page (or `null`). */
export interface RowPage {
  readonly rows: readonly Row[];
  readonly nextCursor: RowCursor | null;
}

/** The default page size for a keyset row read (rows per page). */
export const ROW_PAGE_SIZE = 200;

/**
 * The atomic bulk-import unit for a CSV import: the rows to insert, a builder
 * that maps the freshly-returned row ids (in input order) to their cell
 * inserts, and the metering increment to apply. {@link RowRepo.bulkImport} runs
 * all three — row insert, cell insert and meter — inside ONE `db.transaction`
 * so a mid-import failure rolls back atomically (no orphaned rows or cells, no
 * leaked meter count).
 */
export interface BulkImport {
  readonly rows: readonly NewRow[];
  /** Build the cell inserts from the inserted row ids (input order). */
  readonly buildCells: (rowIds: readonly string[]) => readonly NewCell[];
  /** The workspace + cloud-actions count to increment after the writes. */
  readonly meter: { readonly workspaceId: string; readonly n: number };
}

/** Raised when a row read/write fails (DB/transport error). */
export class RowRepoError extends Data.TaggedError("RowRepoError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Max rows per `INSERT` statement. Each row binds 4 columns
 * (workspaceId, tableId, position, createdAt); Postgres caps a statement at
 * 65535 bind parameters → ~16383 rows. 1000 keeps a wide margin so a bulk CSV
 * import (which inserts one row per CSV line) never hits the wall.
 */
export const ROW_INSERT_CHUNK_SIZE = 1000;

const fail = (op: string) => (cause: unknown) =>
  new RowRepoError({
    message: cause instanceof Error ? cause.message : `${op} failed`,
    cause,
  });

/** The `cell_status` enum union, narrowed from a free `string` with no cast. */
type CellStatus = (typeof schema.cellStatus.enumValues)[number];
const toCellStatus = (s: string): CellStatus => {
  const found = schema.cellStatus.enumValues.find((v) => v === s);
  if (found === undefined) throw new Error(`invalid cell status: ${s}`);
  return found;
};

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
    /**
     * Row COUNTS for many tables in ONE grouped query (`COUNT(*) GROUP BY
     * tableId`), returned as `{ [tableId]: count }`. Used by the sidebar's
     * `listTables` to show a real per-table row count WITHOUT loading every row
     * of every table (the N+1 of calling `listByTable` per table). A table with
     * zero rows is omitted from the map; the caller defaults missing ids to 0.
     */
    readonly countByTableIds: (
      tableIds: readonly string[],
    ) => Effect.Effect<Record<string, number>, RowRepoError>;
    /**
     * The position for the NEXT appended row: `MAX(position) + 1`, or `0` when
     * the table has no rows. Computed server-side (one `MAX` aggregate) so adding
     * a row never loads the whole table just to find the tail — the previous
     * `listByTable`-then-`max+1` made each `addRow` O(rows) and n sequential adds
     * O(n²).
     */
    readonly nextPosition: (
      tableId: string,
    ) => Effect.Effect<number, RowRepoError>;
    /**
     * One KEYSET page of a table's rows, ordered by position (then createdAt,
     * id) ascending. `limit` rows are fetched strictly after the optional
     * `cursor` (the last row of the prior page); the returned `nextCursor` is
     * `null` on the last page. The paged read NEVER loads the whole table, so a
     * 10k-row grid is read one bounded page at a time.
     */
    readonly listKeysetByTable: (args: {
      readonly tableId: string;
      readonly limit: number;
      readonly cursor: RowCursor | null;
    }) => Effect.Effect<RowPage, RowRepoError>;
    /** Insert a row and return its id. */
    readonly insert: (values: NewRow) => Effect.Effect<string, RowRepoError>;
    /** Insert many rows in one call, returning ids in input order. */
    readonly insertMany: (
      values: readonly NewRow[],
    ) => Effect.Effect<readonly string[], RowRepoError>;
    /**
     * Atomically insert rows, their cells, and the meter increment in ONE
     * `db.transaction`, returning the new row ids in input order. A failure at
     * any step rolls the whole import back — no orphaned rows.
     */
    readonly bulkImport: (
      input: BulkImport,
    ) => Effect.Effect<readonly string[], RowRepoError>;
    /** Set a row's display position (reorder). */
    readonly setPosition: (
      id: string,
      position: number,
    ) => Effect.Effect<void, RowRepoError>;
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
      countByTableIds: (tableIds) => {
        const ids = tableIds.filter((id) => UUID_RE.test(id));
        if (ids.length === 0) return Effect.succeed({} as Record<string, number>);
        return Effect.tryPromise({
          try: async () => {
            const grouped = await db
              .select({ tableId: schema.rows.tableId, n: count() })
              .from(schema.rows)
              .where(inArray(schema.rows.tableId, ids))
              .groupBy(schema.rows.tableId);
            const out: Record<string, number> = {};
            for (const g of grouped) out[g.tableId] = Number(g.n);
            return out;
          },
          catch: fail("row count by table"),
        });
      },
      nextPosition: (tableId) =>
        !UUID_RE.test(tableId)
          ? Effect.succeed(0)
          : Effect.tryPromise({
              try: async () => {
                const rows = await db
                  .select({ max: max(schema.rows.position) })
                  .from(schema.rows)
                  .where(eq(schema.rows.tableId, tableId));
                const m = rows[0]?.max;
                return m === null || m === undefined ? 0 : Number(m) + 1;
              },
              catch: fail("row next position"),
            }),
      listKeysetByTable: ({ tableId, limit, cursor }) =>
        !UUID_RE.test(tableId)
          ? Effect.succeed<RowPage>({ rows: [], nextCursor: null })
          : Effect.tryPromise({
              try: async () => {
                const base = eq(schema.rows.tableId, tableId);
                // Seek strictly past the cursor in the (position, createdAt, id)
                // total order: position > c.position, OR equal position with a
                // later createdAt, OR equal (position, createdAt) with a later id.
                const seek =
                  cursor === null
                    ? base
                    : and(
                        base,
                        or(
                          gt(schema.rows.position, cursor.position),
                          and(
                            eq(schema.rows.position, cursor.position),
                            gt(schema.rows.createdAt, cursor.createdAt),
                          ),
                          and(
                            eq(schema.rows.position, cursor.position),
                            eq(schema.rows.createdAt, cursor.createdAt),
                            gt(schema.rows.id, cursor.id),
                          ),
                        ),
                      );
                // Fetch one extra to decide whether a next page exists.
                const fetched = await db
                  .select(cols)
                  .from(schema.rows)
                  .where(seek)
                  .orderBy(
                    asc(schema.rows.position),
                    asc(schema.rows.createdAt),
                    asc(schema.rows.id),
                  )
                  .limit(limit + 1);
                const hasMore = fetched.length > limit;
                const page = hasMore ? fetched.slice(0, limit) : fetched;
                const last = page[page.length - 1];
                return {
                  rows: page,
                  nextCursor:
                    hasMore && last !== undefined
                      ? {
                          position: last.position,
                          createdAt: last.createdAt,
                          id: last.id,
                        }
                      : null,
                };
              },
              catch: fail("row page"),
            }),
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
                // Chunk so a large CSV import never exceeds Postgres' 65535
                // bind-parameter cap (~16383 rows at 4 cols/row); concatenate
                // the returned ids so callers still get them in input order.
                const ids: string[] = [];
                for (const batch of chunk(values, ROW_INSERT_CHUNK_SIZE)) {
                  const rows = await db
                    .insert(schema.rows)
                    .values([...batch])
                    .returning({ id: schema.rows.id });
                  for (const r of rows) ids.push(r.id);
                }
                return ids;
              },
              catch: fail("row bulk insert"),
            }),
      bulkImport: (input) =>
        input.rows.length === 0
          ? Effect.succeed([] as readonly string[])
          : Effect.tryPromise({
              try: () =>
                // ONE transaction (one pooled connection) so the import is
                // atomic: a failure in any chunk rolls back the rows, cells and
                // meter together — no orphaned rows. Kept short (insert-only,
                // no app round-trips) so it is Supavisor transaction-pooler safe.
                db.transaction(async (tx) => {
                  // Bulk-insert rows, chunked, preserving input order in ids.
                  const ids: string[] = [];
                  for (const batch of chunk(input.rows, ROW_INSERT_CHUNK_SIZE)) {
                    const inserted = await tx
                      .insert(schema.rows)
                      .values([...batch])
                      .returning({ id: schema.rows.id });
                    for (const r of inserted) ids.push(r.id);
                  }

                  // Build cells from the returned ids and bulk-insert, chunked.
                  const cells = input.buildCells(ids);
                  for (const batch of chunk(cells, CELL_INSERT_CHUNK_SIZE)) {
                    await tx.insert(schema.cells).values(
                      batch.map((c) => ({
                        workspaceId: c.workspaceId,
                        tableId: c.tableId,
                        rowId: c.rowId,
                        columnId: c.columnId,
                        value: c.value,
                        status: toCellStatus(c.status),
                        error: c.error,
                        updatedAt: c.updatedAt,
                      })),
                    );
                  }

                  // Meter the cloud-actions increment inside the same tx so a
                  // rolled-back import never leaks a billable count.
                  if (input.meter.n > 0) {
                    await tx
                      .update(schema.workspaces)
                      .set({
                        cloudActionsUsed: schema.sql`coalesce(${schema.workspaces.cloudActionsUsed}, 0) + ${input.meter.n}`,
                      })
                      .where(eq(schema.workspaces.id, input.meter.workspaceId));
                  }

                  return ids;
                }),
              catch: fail("row bulk import"),
            }),
      setPosition: (id, position) =>
        Effect.tryPromise({
          try: async () => {
            await db
              .update(schema.rows)
              .set({ position })
              .where(eq(schema.rows.id, id));
          },
          catch: fail("row set position"),
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

/**
 * An in-memory `RowRepo` Layer over a shared {@link GridStore}.
 *
 * `meterIncrement` mirrors the live {@link RowRepo.bulkImport} transaction's
 * meter step: a test can pass the SAME function the in-memory `MeterService`
 * uses so the bulk import's meter bump is part of the same atomic unit (and a
 * simulated failure leaves the meter, like the rows and cells, untouched).
 */
export const rowRepoLayer = (
  store: GridStore,
  meterIncrement: (workspaceId: string, n: number) => void = () => {},
): Layer.Layer<RowRepo> =>
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
    countByTableIds: (tableIds) =>
      Effect.succeed(
        store.rows.reduce<Record<string, number>>((acc, r) => {
          if (tableIds.includes(r.tableId)) acc[r.tableId] = (acc[r.tableId] ?? 0) + 1;
          return acc;
        }, {}),
      ),
    nextPosition: (tableId) =>
      Effect.succeed(
        store.rows
          .filter((r) => r.tableId === tableId)
          .reduce((m, r) => Math.max(m, r.position + 1), 0),
      ),
    listKeysetByTable: ({ tableId, limit, cursor }) =>
      Effect.sync(() => {
        // Apply the SAME (position, createdAt, id) total order + seek-past-cursor
        // rule the Drizzle path uses, so the in-memory Layer is a faithful mirror.
        const sorted = [...store.rows]
          .filter((r) => r.tableId === tableId)
          .sort(
            (a, b) =>
              a.position - b.position ||
              a.createdAt - b.createdAt ||
              (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
          );
        const past =
          cursor === null
            ? sorted
            : sorted.filter(
                (r) =>
                  r.position > cursor.position ||
                  (r.position === cursor.position &&
                    r.createdAt > cursor.createdAt) ||
                  (r.position === cursor.position &&
                    r.createdAt === cursor.createdAt &&
                    r.id > cursor.id),
              );
        const page = past.slice(0, limit);
        const hasMore = past.length > limit;
        const last = page[page.length - 1];
        return {
          rows: page,
          nextCursor:
            hasMore && last !== undefined
              ? {
                  position: last.position,
                  createdAt: last.createdAt,
                  id: last.id,
                }
              : null,
        };
      }),
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
    bulkImport: (input) =>
      Effect.try({
        try: () => {
          // Stage the whole import OFF the store, then commit in one shot, so a
          // throw in buildCells/narrowing leaves rows, cells AND the meter
          // untouched — the in-memory mirror of the live tx rollback.
          const staged = input.rows.map((v) => ({
            id: store.nextId("row"),
            ...v,
          }));
          const ids = staged.map((r) => r.id);
          const cells = input
            .buildCells(ids)
            .map((c) => ({ id: store.nextId("cell"), ...c }));
          // Commit: rows + cells + meter together.
          for (const r of staged) store.rows.push(r);
          for (const c of cells) store.cells.push(c);
          if (input.meter.n > 0) {
            meterIncrement(input.meter.workspaceId, input.meter.n);
          }
          const out: readonly string[] = ids;
          return out;
        },
        catch: fail("row bulk import"),
      }),
    setPosition: (id, position) =>
      Effect.sync(() => {
        const r = store.rows.find((x) => x.id === id);
        if (r) r.position = position;
      }),
    remove: (id) => Effect.sync(() => cascadeDeleteRow(store, id)),
  });
