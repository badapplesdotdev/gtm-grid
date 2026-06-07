/**
 * `ExtensionRepo` — the Effect <-> Drizzle adapter for installed connector
 * extensions (`extensions`).
 *
 * Owns the reads/writes `convex/extensions.ts` needed: list a workspace's
 * extensions, find one by (workspaceId, extensionId) for the upsert decision,
 * insert a new one, and patch an existing one in place.
 *
 * Two Layers, like the worked example {@link WorkspaceRepo}: Drizzle-backed
 * {@link ExtensionRepoLive} and the in-memory {@link extensionRepoLayer} for
 * offline tests.
 */

import { schema } from "@gtmgrid/db";
import { and, asc, eq } from "drizzle-orm";
import { Context, Data, Effect, Layer, Option } from "effect";
import { DbClient } from "../db-client.js";

/** An extension row projection. Mirrors `extensions`. */
export interface Extension {
  readonly id: string;
  readonly workspaceId: string;
  readonly extensionId: string;
  readonly name: string;
  readonly category: string | null;
  readonly manifest: unknown;
}

/** Fields a `saveExtension` insert supplies. */
export interface ExtensionInsert {
  readonly workspaceId: string;
  readonly extensionId: string;
  readonly name: string;
  readonly category: string | null;
  readonly manifest: unknown;
}

/** The mutable fields a `saveExtension` patch updates in place. */
export interface ExtensionPatch {
  readonly name: string;
  readonly category: string | null;
  readonly manifest: unknown;
}

/** Raised when an extension read/write fails (DB/transport error). */
export class ExtensionRepoError extends Data.TaggedError("ExtensionRepoError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Reads/writes the `extensions` table. Backed by Drizzle in production
 * ({@link ExtensionRepoLive}); by an in-memory array in tests
 * ({@link extensionRepoLayer}).
 */
export class ExtensionRepo extends Context.Tag("ExtensionRepo")<
  ExtensionRepo,
  {
    /** A workspace's extensions (stable order by extensionId). */
    readonly listByWorkspace: (
      workspaceId: string,
    ) => Effect.Effect<readonly Extension[], ExtensionRepoError>;
    /** The extension for (workspaceId, extensionId), or `None`. */
    readonly findByWorkspaceExtension: (
      workspaceId: string,
      extensionId: string,
    ) => Effect.Effect<Option.Option<Extension>, ExtensionRepoError>;
    /** Insert a new extension, returning its id. */
    readonly insert: (
      values: ExtensionInsert,
    ) => Effect.Effect<string, ExtensionRepoError>;
    /** Patch an existing extension by id. */
    readonly patch: (
      id: string,
      patch: ExtensionPatch,
    ) => Effect.Effect<void, ExtensionRepoError>;
  }
>() {}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const failExt = (message: string) => (cause: unknown) =>
  new ExtensionRepoError({
    message: cause instanceof Error ? cause.message : message,
    cause,
  });

/** The Drizzle-backed Layer. Depends on {@link DbClient}. */
export const ExtensionRepoLive: Layer.Layer<ExtensionRepo, never, DbClient> =
  Layer.effect(
    ExtensionRepo,
    Effect.gen(function* () {
      const db = yield* DbClient;
      return {
        listByWorkspace: (workspaceId) =>
          !UUID_RE.test(workspaceId)
            ? Effect.succeed([] as readonly Extension[])
            : Effect.tryPromise({
                try: async () => {
                  const rows = await db
                    .select()
                    .from(schema.extensions)
                    .where(eq(schema.extensions.workspaceId, workspaceId))
                    .orderBy(asc(schema.extensions.extensionId));
                  return rows;
                },
                catch: failExt("extension list failed"),
              }),

        findByWorkspaceExtension: (workspaceId, extensionId) =>
          !UUID_RE.test(workspaceId)
            ? Effect.succeed(Option.none<Extension>())
            : Effect.tryPromise({
                try: async () => {
                  const rows = await db
                    .select()
                    .from(schema.extensions)
                    .where(
                      and(
                        eq(schema.extensions.workspaceId, workspaceId),
                        eq(schema.extensions.extensionId, extensionId),
                      ),
                    )
                    .limit(1);
                  return Option.fromNullable(rows[0] ?? null);
                },
                catch: failExt("extension lookup failed"),
              }),

        insert: (values) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await db
                .insert(schema.extensions)
                .values(values)
                .returning({ id: schema.extensions.id });
              const id = rows[0]?.id;
              if (id === undefined) {
                throw new Error("extension insert returned no id");
              }
              return id;
            },
            catch: failExt("extension insert failed"),
          }),

        patch: (id, patch) =>
          Effect.tryPromise({
            try: async () => {
              await db
                .update(schema.extensions)
                .set(patch)
                .where(eq(schema.extensions.id, id));
            },
            catch: failExt("extension patch failed"),
          }),
      };
    }),
  );

/**
 * In-memory Layer over a MUTABLE extension array, so a test can observe the
 * insert/patch upsert behaviour with NO live database.
 */
export const extensionRepoLayer = (
  extensions: Extension[] = [],
): Layer.Layer<ExtensionRepo> => {
  let seq = 0;
  return Layer.succeed(ExtensionRepo, {
    listByWorkspace: (workspaceId) =>
      Effect.succeed(
        [...extensions]
          .filter((e) => e.workspaceId === workspaceId)
          .sort((a, b) =>
            a.extensionId < b.extensionId
              ? -1
              : a.extensionId > b.extensionId
                ? 1
                : 0,
          ),
      ),
    findByWorkspaceExtension: (workspaceId, extensionId) =>
      Effect.succeed(
        Option.fromNullable(
          extensions.find(
            (e) =>
              e.workspaceId === workspaceId && e.extensionId === extensionId,
          ),
        ),
      ),
    insert: (values) =>
      Effect.sync(() => {
        const id = `extension_${++seq}`;
        extensions.push({ ...values, id });
        return id;
      }),
    patch: (id, patch) =>
      Effect.sync(() => {
        const idx = extensions.findIndex((e) => e.id === id);
        if (idx >= 0) extensions[idx] = { ...extensions[idx], ...patch };
      }),
  });
};
