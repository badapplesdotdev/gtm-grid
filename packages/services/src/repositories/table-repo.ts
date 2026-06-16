/**
 * `TableRepo` — the Effect <-> Drizzle adapter for the `tables` table.
 *
 * Ports the table reads/writes of `convex/tables.ts` (listTables :53, getTable's
 * table load :72, createTable :112, deleteTable :285). `remove` relies on the
 * Postgres `ON DELETE CASCADE` FKs (schema.ts) to drop the table's columns, rows,
 * cells, and webhooks — the AC's "rely on FK ON DELETE CASCADE"; the in-memory
 * Layer mirrors that with {@link cascadeDeleteTable}.
 */

import { schema } from "@gtmgrid/db";
import { asc, eq, max } from "drizzle-orm";
import { Context, Data, Effect, Layer, Option } from "effect";
import { DbClient } from "../db-client.js";
import { cascadeDeleteTable, type GridStore } from "./grid-store.js";

/** A table row projection the grid domain uses (the full getTable shape). */
export interface Table {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly name: string;
  readonly position: number;
  readonly createdAt: number;
  /** Dedupe config: the column rows are deduped on (null = off). */
  readonly dedupeColumn: string | null;
  /** Which duplicate to keep ("oldest" | "newest"); null when dedupe is off. */
  readonly dedupeKeep: string | null;
  /** Sidebar folder this table is filed under (null = root). */
  readonly folderId: string | null;
  /** Workspace-shared favourite/pin flag (any member's pin shows for all). */
  readonly favorite: boolean;
}

/** Fields a `createTable` insert supplies. */
export interface NewTable {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly name: string;
  readonly position: number;
  readonly createdAt: number;
  /** Sidebar folder to file the new table under (omitted/null = root). */
  readonly folderId?: string | null;
}

/** Raised when a table read/write fails (DB/transport error). */
export class TableRepoError extends Data.TaggedError("TableRepoError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (op: string) => (cause: unknown) =>
  new TableRepoError({
    message: cause instanceof Error ? cause.message : `${op} failed`,
    cause,
  });

/** Reads/writes the `tables` table. */
export class TableRepo extends Context.Tag("TableRepo")<
  TableRepo,
  {
    /** The table for `id`, or `None`. */
    readonly findById: (
      id: string,
    ) => Effect.Effect<Option.Option<Table>, TableRepoError>;
    /** A project's tables, ordered by position then creation. */
    readonly listByProject: (
      projectId: string,
    ) => Effect.Effect<readonly Table[], TableRepoError>;
    /**
     * The position for the NEXT created table: `MAX(position) + 1`, or `0` when
     * the project has no tables. Computed server-side (one `MAX` aggregate) so
     * creating a table never loads every sibling table just to find the tail.
     */
    readonly nextPosition: (
      projectId: string,
    ) => Effect.Effect<number, TableRepoError>;
    /** Insert a table and return its id. */
    readonly insert: (
      values: NewTable,
    ) => Effect.Effect<string, TableRepoError>;
    /** Rename a table (name only; position/dedupe/etc. unchanged). */
    readonly rename: (
      id: string,
      name: string,
    ) => Effect.Effect<void, TableRepoError>;
    /** Pin/unpin a table (workspace-shared favourite flag). */
    readonly setFavorite: (
      id: string,
      favorite: boolean,
    ) => Effect.Effect<void, TableRepoError>;
    /** Delete a table (FK cascade drops its columns/rows/cells/webhooks). */
    readonly remove: (id: string) => Effect.Effect<void, TableRepoError>;
    /** Set (or clear) a table's dedupe config. `column: null` disables it. */
    readonly setDedupe: (
      id: string,
      config: { readonly column: string | null; readonly keep: string | null },
    ) => Effect.Effect<void, TableRepoError>;
    /**
     * File a table under a folder (`folderId: null` → root), optionally with a
     * new sort position (drag-reorder passes a fractional midpoint).
     */
    readonly setFolder: (
      id: string,
      folderId: string | null,
      position?: number,
    ) => Effect.Effect<void, TableRepoError>;
  }
>() {}

/** The Drizzle-backed `TableRepo` Layer. */
export const TableRepoLive: Layer.Layer<TableRepo, never, DbClient> =
  Layer.effect(
    TableRepo,
    Effect.gen(function* () {
      const db = yield* DbClient;
      const columns = {
        id: schema.tables.id,
        workspaceId: schema.tables.workspaceId,
        projectId: schema.tables.projectId,
        name: schema.tables.name,
        position: schema.tables.position,
        createdAt: schema.tables.createdAt,
        dedupeColumn: schema.tables.dedupeColumn,
        dedupeKeep: schema.tables.dedupeKeep,
        folderId: schema.tables.folderId,
        favorite: schema.tables.favorite,
      } as const;
      return {
        findById: (id) =>
          UUID_RE.test(id)
            ? Effect.tryPromise({
                try: async () => {
                  const rows = await db
                    .select(columns)
                    .from(schema.tables)
                    .where(eq(schema.tables.id, id))
                    .limit(1);
                  return Option.fromNullable(rows[0] ?? null);
                },
                catch: fail("table lookup"),
              })
            : Effect.succeed(Option.none<Table>()),
        listByProject: (projectId) =>
          UUID_RE.test(projectId)
            ? Effect.tryPromise({
                try: () =>
                  db
                    .select(columns)
                    .from(schema.tables)
                    .where(eq(schema.tables.projectId, projectId))
                    .orderBy(
                      asc(schema.tables.position),
                      asc(schema.tables.createdAt),
                    ),
                catch: fail("table list"),
              })
            : Effect.succeed([] as readonly Table[]),
        nextPosition: (projectId) =>
          !UUID_RE.test(projectId)
            ? Effect.succeed(0)
            : Effect.tryPromise({
                try: async () => {
                  const rows = await db
                    .select({ max: max(schema.tables.position) })
                    .from(schema.tables)
                    .where(eq(schema.tables.projectId, projectId));
                  const m = rows[0]?.max;
                  return m === null || m === undefined ? 0 : Number(m) + 1;
                },
                catch: fail("table next position"),
              }),
        insert: (values) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await db
                .insert(schema.tables)
                .values(values)
                .returning({ id: schema.tables.id });
              const id = rows[0]?.id;
              if (id === undefined) {
                throw new Error("table insert returned no id");
              }
              return id;
            },
            catch: fail("table insert"),
          }),
        rename: (id, name) =>
          Effect.tryPromise({
            try: async () => {
              await db
                .update(schema.tables)
                .set({ name })
                .where(eq(schema.tables.id, id));
            },
            catch: fail("table rename"),
          }),
        setFavorite: (id, favorite) =>
          Effect.tryPromise({
            try: async () => {
              await db
                .update(schema.tables)
                .set({ favorite })
                .where(eq(schema.tables.id, id));
            },
            catch: fail("table set favorite"),
          }),
        remove: (id) =>
          Effect.tryPromise({
            try: async () => {
              await db.delete(schema.tables).where(eq(schema.tables.id, id));
            },
            catch: fail("table delete"),
          }),
        setDedupe: (id, config) =>
          Effect.tryPromise({
            try: async () => {
              await db
                .update(schema.tables)
                .set({
                  dedupeColumn: config.column,
                  dedupeKeep: config.column === null ? null : config.keep,
                })
                .where(eq(schema.tables.id, id));
            },
            catch: fail("table set dedupe"),
          }),
        setFolder: (id, folderId, position) =>
          Effect.tryPromise({
            try: async () => {
              await db
                .update(schema.tables)
                .set({
                  folderId,
                  ...(position !== undefined ? { position } : {}),
                })
                .where(eq(schema.tables.id, id));
            },
            catch: fail("table set folder"),
          }),
      };
    }),
  );

/** An in-memory `TableRepo` Layer over a shared {@link GridStore}. */
export const tableRepoLayer = (store: GridStore): Layer.Layer<TableRepo> =>
  Layer.succeed(TableRepo, {
    findById: (id) =>
      Effect.succeed(Option.fromNullable(store.tables.find((t) => t.id === id))),
    listByProject: (projectId) =>
      Effect.succeed(
        [...store.tables]
          .filter((t) => t.projectId === projectId)
          .sort(
            (a, b) => a.position - b.position || a.createdAt - b.createdAt,
          ),
      ),
    nextPosition: (projectId) =>
      Effect.succeed(
        store.tables
          .filter((t) => t.projectId === projectId)
          .reduce((m, t) => Math.max(m, t.position + 1), 0),
      ),
    insert: (values) =>
      Effect.sync(() => {
        const id = store.nextId("table");
        store.tables.push({
          id,
          ...values,
          dedupeColumn: null,
          dedupeKeep: null,
          folderId: values.folderId ?? null,
          favorite: false,
        });
        return id;
      }),
    rename: (id, name) =>
      Effect.sync(() => {
        const t = store.tables.find((x) => x.id === id);
        if (t) t.name = name;
      }),
    setFavorite: (id, favorite) =>
      Effect.sync(() => {
        const t = store.tables.find((x) => x.id === id);
        if (t) t.favorite = favorite;
      }),
    remove: (id) => Effect.sync(() => cascadeDeleteTable(store, id)),
    setDedupe: (id, config) =>
      Effect.sync(() => {
        const t = store.tables.find((x) => x.id === id);
        if (t) {
          t.dedupeColumn = config.column;
          t.dedupeKeep = config.column === null ? null : config.keep;
        }
      }),
    setFolder: (id, folderId, position) =>
      Effect.sync(() => {
        const t = store.tables.find((x) => x.id === id);
        if (t) {
          t.folderId = folderId;
          if (position !== undefined) t.position = position;
        }
      }),
  });
