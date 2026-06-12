/**
 * `FolderRepo` — the Effect <-> Drizzle adapter for the `folders` table.
 *
 * Folders are the sidebar's table groups (one level deep, organizational only).
 * Two Layers like the worked example {@link import("./table-repo.js").TableRepo}:
 *   - {@link FolderRepoLive} — Drizzle-backed, depends on {@link DbClient}. The
 *     Postgres `tables.folder_id` FK (ON DELETE SET NULL) unfiles a deleted
 *     folder's tables back to the root.
 *   - {@link folderRepoLayer} — in-memory over a shared {@link GridStore}; its
 *     `remove` mirrors the SET NULL unfiling so tests observe the same shape.
 */

import { schema } from "@gtmgrid/db";
import { asc, eq, max } from "drizzle-orm";
import { Context, Data, Effect, Layer, Option } from "effect";
import { DbClient } from "../db-client.js";
import type { GridStore } from "./grid-store.js";

/** A folder row projection the grid domain uses. */
export interface Folder {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly name: string;
  readonly position: number;
  readonly createdAt: number;
}

/** Fields a `createFolder` insert supplies. */
export interface NewFolder {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly name: string;
  readonly position: number;
  readonly createdAt: number;
}

/** Raised when a folder read/write fails (DB/transport error). */
export class FolderRepoError extends Data.TaggedError("FolderRepoError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (op: string) => (cause: unknown) =>
  new FolderRepoError({
    message: cause instanceof Error ? cause.message : `${op} failed`,
    cause,
  });

/** Reads/writes the `folders` table. */
export class FolderRepo extends Context.Tag("FolderRepo")<
  FolderRepo,
  {
    /** The folder for `id`, or `None`. */
    readonly findById: (
      id: string,
    ) => Effect.Effect<Option.Option<Folder>, FolderRepoError>;
    /** A project's folders, ordered by position then creation. */
    readonly listByProject: (
      projectId: string,
    ) => Effect.Effect<readonly Folder[], FolderRepoError>;
    /** The position for the NEXT created folder: `MAX(position) + 1`, or 0. */
    readonly nextPosition: (
      projectId: string,
    ) => Effect.Effect<number, FolderRepoError>;
    /** Insert a folder and return its id. */
    readonly insert: (
      values: NewFolder,
    ) => Effect.Effect<string, FolderRepoError>;
    /** Rename a folder. */
    readonly rename: (
      id: string,
      name: string,
    ) => Effect.Effect<void, FolderRepoError>;
    /** Delete a folder (its tables are unfiled to the root via SET NULL). */
    readonly remove: (id: string) => Effect.Effect<void, FolderRepoError>;
  }
>() {}

/** The Drizzle-backed `FolderRepo` Layer. */
export const FolderRepoLive: Layer.Layer<FolderRepo, never, DbClient> =
  Layer.effect(
    FolderRepo,
    Effect.gen(function* () {
      const db = yield* DbClient;
      const columns = {
        id: schema.folders.id,
        workspaceId: schema.folders.workspaceId,
        projectId: schema.folders.projectId,
        name: schema.folders.name,
        position: schema.folders.position,
        createdAt: schema.folders.createdAt,
      } as const;
      return {
        findById: (id) =>
          UUID_RE.test(id)
            ? Effect.tryPromise({
                try: async () => {
                  const rows = await db
                    .select(columns)
                    .from(schema.folders)
                    .where(eq(schema.folders.id, id))
                    .limit(1);
                  return Option.fromNullable(rows[0] ?? null);
                },
                catch: fail("folder lookup"),
              })
            : Effect.succeed(Option.none<Folder>()),
        listByProject: (projectId) =>
          UUID_RE.test(projectId)
            ? Effect.tryPromise({
                try: () =>
                  db
                    .select(columns)
                    .from(schema.folders)
                    .where(eq(schema.folders.projectId, projectId))
                    .orderBy(
                      asc(schema.folders.position),
                      asc(schema.folders.createdAt),
                    ),
                catch: fail("folder list"),
              })
            : Effect.succeed([] as readonly Folder[]),
        nextPosition: (projectId) =>
          !UUID_RE.test(projectId)
            ? Effect.succeed(0)
            : Effect.tryPromise({
                try: async () => {
                  const rows = await db
                    .select({ max: max(schema.folders.position) })
                    .from(schema.folders)
                    .where(eq(schema.folders.projectId, projectId));
                  const m = rows[0]?.max;
                  return m === null || m === undefined ? 0 : Number(m) + 1;
                },
                catch: fail("folder next position"),
              }),
        insert: (values) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await db
                .insert(schema.folders)
                .values(values)
                .returning({ id: schema.folders.id });
              const id = rows[0]?.id;
              if (id === undefined) {
                throw new Error("folder insert returned no id");
              }
              return id;
            },
            catch: fail("folder insert"),
          }),
        rename: (id, name) =>
          Effect.tryPromise({
            try: async () => {
              await db
                .update(schema.folders)
                .set({ name })
                .where(eq(schema.folders.id, id));
            },
            catch: fail("folder rename"),
          }),
        remove: (id) =>
          Effect.tryPromise({
            try: async () => {
              // tables.folder_id is ON DELETE SET NULL — the delete unfiles.
              await db.delete(schema.folders).where(eq(schema.folders.id, id));
            },
            catch: fail("folder delete"),
          }),
      };
    }),
  );

/** An in-memory `FolderRepo` Layer over a shared {@link GridStore}. */
export const folderRepoLayer = (store: GridStore): Layer.Layer<FolderRepo> =>
  Layer.succeed(FolderRepo, {
    findById: (id) =>
      Effect.succeed(
        Option.fromNullable(store.folders.find((f) => f.id === id)),
      ),
    listByProject: (projectId) =>
      Effect.succeed(
        [...store.folders]
          .filter((f) => f.projectId === projectId)
          .sort(
            (a, b) => a.position - b.position || a.createdAt - b.createdAt,
          ),
      ),
    nextPosition: (projectId) =>
      Effect.succeed(
        store.folders
          .filter((f) => f.projectId === projectId)
          .reduce((m, f) => Math.max(m, f.position + 1), 0),
      ),
    insert: (values) =>
      Effect.sync(() => {
        const id = store.nextId("folder");
        store.folders.push({ id, ...values });
        return id;
      }),
    rename: (id, name) =>
      Effect.sync(() => {
        const f = store.folders.find((x) => x.id === id);
        if (f) f.name = name;
      }),
    remove: (id) =>
      Effect.sync(() => {
        // Mirror the Postgres SET NULL: unfile the folder's tables to root.
        for (const t of store.tables) {
          if (t.folderId === id) t.folderId = null;
        }
        const i = store.folders.findIndex((f) => f.id === id);
        if (i >= 0) store.folders.splice(i, 1);
      }),
  });
