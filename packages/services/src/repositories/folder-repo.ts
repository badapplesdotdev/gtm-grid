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
import { and, asc, eq, isNull, max } from "drizzle-orm";
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
  /** The folder this folder nests under (null = top level). */
  readonly parentId: string | null;
}

/** Fields a `createFolder` insert supplies. */
export interface NewFolder {
  /**
   * Client-supplied primary key. Optional: the DB generates one when omitted.
   * Supplied by the cloud grid so an optimistic folder insert matches the
   * server's id.
   */
  readonly id?: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly name: string;
  readonly position: number;
  readonly createdAt: number;
  /** The parent folder this is nested under (null/omitted = top level). */
  readonly parentId?: string | null;
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
    /**
     * The position for the NEXT folder created under `parentId` (null = top
     * level) in `projectId`: `MAX(position) + 1` among that sibling group, or 0.
     * Positions are scoped to a sibling group so each nesting level orders
     * independently.
     */
    readonly nextPosition: (
      projectId: string,
      parentId: string | null,
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
    /**
     * Reparent a folder (`parentId: null` → top level), optionally with a new
     * sort position within the destination sibling group. Cycle-safety is the
     * caller's responsibility (see GridService.moveFolder).
     */
    readonly setParent: (
      id: string,
      parentId: string | null,
      position?: number,
    ) => Effect.Effect<void, FolderRepoError>;
    /**
     * Delete a folder. Its tables unfile to the root and its child folders are
     * promoted to the root, both via ON DELETE SET NULL — nothing is cascade-
     * deleted.
     */
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
        parentId: schema.folders.parentId,
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
        nextPosition: (projectId, parentId) =>
          !UUID_RE.test(projectId)
            ? Effect.succeed(0)
            : Effect.tryPromise({
                try: async () => {
                  const rows = await db
                    .select({ max: max(schema.folders.position) })
                    .from(schema.folders)
                    .where(
                      and(
                        eq(schema.folders.projectId, projectId),
                        parentId === null
                          ? isNull(schema.folders.parentId)
                          : eq(schema.folders.parentId, parentId),
                      ),
                    );
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
        setParent: (id, parentId, position) =>
          Effect.tryPromise({
            try: async () => {
              await db
                .update(schema.folders)
                .set({
                  parentId,
                  ...(position !== undefined ? { position } : {}),
                })
                .where(eq(schema.folders.id, id));
            },
            catch: fail("folder reparent"),
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
    nextPosition: (projectId, parentId) =>
      Effect.succeed(
        store.folders
          .filter(
            (f) =>
              f.projectId === projectId && (f.parentId ?? null) === parentId,
          )
          .reduce((m, f) => Math.max(m, f.position + 1), 0),
      ),
    insert: (values) =>
      Effect.sync(() => {
        const id = values.id ?? store.nextId("folder");
        store.folders.push({ ...values, id, parentId: values.parentId ?? null });
        return id;
      }),
    rename: (id, name) =>
      Effect.sync(() => {
        const f = store.folders.find((x) => x.id === id);
        if (f) f.name = name;
      }),
    setParent: (id, parentId, position) =>
      Effect.sync(() => {
        const f = store.folders.find((x) => x.id === id);
        if (f) {
          f.parentId = parentId;
          if (position !== undefined) f.position = position;
        }
      }),
    remove: (id) =>
      Effect.sync(() => {
        // Mirror the Postgres SET NULL: unfile the folder's tables to root and
        // promote its child folders to the root (never cascade-delete).
        for (const t of store.tables) {
          if (t.folderId === id) t.folderId = null;
        }
        for (const f of store.folders) {
          if ((f.parentId ?? null) === id) f.parentId = null;
        }
        const i = store.folders.findIndex((f) => f.id === id);
        if (i >= 0) store.folders.splice(i, 1);
      }),
  });
