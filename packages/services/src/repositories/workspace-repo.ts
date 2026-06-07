/**
 * `WorkspaceRepo` — the WORKED-EXAMPLE repository proving the repo pattern every
 * W2 lane copies.
 *
 * A repository is the Effect <-> Drizzle adapter: it owns ONE table's reads and
 * writes, exposes them as `Effect.Effect<…, RepoError>` methods, and lives
 * behind a `Context.Tag` so it can be backed two ways:
 *
 *   - {@link WorkspaceRepoLive} — Drizzle-backed, depends on {@link DbClient}
 *     (the per-request pooled handle). Every DB call is wrapped in
 *     `Effect.tryPromise` so a transport failure surfaces as the typed
 *     {@link WorkspaceRepoError} in the error channel — never a thrown rejection.
 *   - {@link workspaceRepoLayer} — in-memory, backed by a fixed array. Tests use
 *     this so they exercise real repo behaviour with NO live database.
 *
 * Follows the canonical Effect service shape (packages/engine/src/sample-service.ts
 * and packages/cloud/src/membership.ts): typed `Data.TaggedError`s, services as
 * `Context.Tag`s, implementations supplied as `Layer`s.
 */

import { schema } from "@gtmgrid/db";
import { eq } from "drizzle-orm";
import { Context, Data, Effect, Layer, Option } from "effect";
import { DbClient } from "../db-client.js";

/**
 * A workspace row projection the domain needs. Mirrors `workspaces`
 * (packages/db/src/schema.ts:217) but exposes only the fields callers use, so
 * the in-memory Test Layer stays small.
 */
export interface Workspace {
  readonly id: string;
  readonly name: string;
  /** Better Auth user id of the creator/owner. */
  readonly ownerId: string;
}

/** Raised when a workspace read/write fails (DB/transport error). */
export class WorkspaceRepoError extends Data.TaggedError(
  "WorkspaceRepoError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Reads workspace rows. Backed by Drizzle over `@gtmgrid/db` in production
 * ({@link WorkspaceRepoLive}); backed by an in-memory list in tests
 * ({@link workspaceRepoLayer}).
 */
export class WorkspaceRepo extends Context.Tag("WorkspaceRepo")<
  WorkspaceRepo,
  {
    /**
     * The workspace for `workspaceId`, or `None` when it does not exist. A read
     * failure surfaces as the typed {@link WorkspaceRepoError}.
     */
    readonly findById: (
      workspaceId: string,
    ) => Effect.Effect<Option.Option<Workspace>, WorkspaceRepoError>;
  }
>() {}

/**
 * The Drizzle-backed `WorkspaceRepo` Layer. Depends on {@link DbClient} for the
 * per-request pooled handle. Each query is wrapped in `Effect.tryPromise` so a
 * transport failure becomes a typed {@link WorkspaceRepoError}.
 */
export const WorkspaceRepoLive: Layer.Layer<WorkspaceRepo, never, DbClient> =
  Layer.effect(
    WorkspaceRepo,
    Effect.gen(function* () {
      const db = yield* DbClient;
      return {
        findById: (workspaceId) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await db
                .select({
                  id: schema.workspaces.id,
                  name: schema.workspaces.name,
                  ownerId: schema.workspaces.ownerId,
                })
                .from(schema.workspaces)
                .where(eq(schema.workspaces.id, workspaceId))
                .limit(1);
              return Option.fromNullable(rows[0] ?? null);
            },
            catch: (cause) =>
              new WorkspaceRepoError({
                message:
                  cause instanceof Error
                    ? cause.message
                    : "workspace lookup failed",
                cause,
              }),
          }),
      };
    }),
  );

/**
 * An in-memory `WorkspaceRepo` Layer backed by a fixed list of {@link Workspace}
 * rows. `findById` matches on `id`, exactly like the Drizzle `eq(id)` query.
 * Used by tests so the repo pattern is exercised with NO live database.
 */
export const workspaceRepoLayer = (
  workspaces: readonly Workspace[],
): Layer.Layer<WorkspaceRepo> =>
  Layer.succeed(WorkspaceRepo, {
    findById: (workspaceId) =>
      Effect.succeed(
        Option.fromNullable(workspaces.find((w) => w.id === workspaceId)),
      ),
  });
