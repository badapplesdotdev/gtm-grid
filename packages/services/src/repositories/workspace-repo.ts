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
import { and, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import { Context, Data, Effect, Layer, Option } from "effect";
import { DbClient } from "../db-client.js";

/**
 * A workspace row projection the domain needs. Mirrors `workspaces`
 * (packages/db/src/schema.ts:217) but exposes only the fields callers use, so
 * the in-memory Test Layer stays small.
 *
 * The metering columns (`cloudActionsUsed` / `cloudActionsLimit`) and the cached
 * paid plan (`currentPlanId`) are the snapshot the `me` query surfaces with NO
 * outbound HTTP — the metering-simplification mandate KEEPS the
 * `cloudActionsUsed/Limit` semantics (drops only the pending-cron). All three are
 * nullable: a workspace that has never been metered reads as 0 used / unlimited /
 * free tier.
 */
export interface Workspace {
  readonly id: string;
  readonly name: string;
  /** Better Auth user id of the creator/owner. */
  readonly ownerId: string;
  /** Last-known CLOUD-actions usage Autumn reported (null/undefined → 0 used). */
  readonly cloudActionsUsed?: number | null;
  /** Plan cap for cloud actions; null for an unlimited plan. */
  readonly cloudActionsLimit?: number | null;
  /** Current PAID plan id ("team"|"business"|"unlimited"), or null for free. */
  readonly currentPlanId?: string | null;
  /** Epoch ms the current trial ends, or null when not trialing. */
  readonly trialEndsAt?: number | null;
}

/**
 * The workspace customer profile forwarded to Autumn `customers.getOrCreate`:
 * the org name + owner email. Ports `workspaceCustomerData`
 * (convex/workspaces.ts:351) / `assertBillingAdmin` (convex/billing.ts:34) which
 * loaded the owner's email so the checkout materialises the customer with a
 * profile, not just an id. Both fields are nullable for a missing workspace/owner.
 */
export interface WorkspaceCustomerData {
  readonly name: string | null;
  readonly email: string | null;
}

/** A new-workspace insert: the name + the creator who becomes its owner. */
export interface NewWorkspace {
  readonly name: string;
  readonly ownerId: string;
  readonly createdAt: number;
}

/**
 * The authenticated user's profile the `me` query returns (its `user` field —
 * convex/workspaces.ts:118). `name`/`email` are nullable to mirror the source.
 */
export interface WorkspaceUser {
  readonly id: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly image: string | null;
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

    /**
     * The workspaces for the given ids, in ONE indexed query (the batched read
     * that backs the no-N+1 `me` query — convex/workspaces.ts:65). Missing ids
     * are simply absent from the result; the caller re-associates by id.
     */
    readonly findManyByIds: (
      workspaceIds: readonly string[],
    ) => Effect.Effect<readonly Workspace[], WorkspaceRepoError>;

    /**
     * Insert a workspace and return its generated id. Ports the workspace insert
     * of `createWorkspace` (convex/workspaces.ts:189); the OWNER membership is
     * inserted by the caller (the service) in the same operation.
     */
    readonly insert: (
      workspace: NewWorkspace,
    ) => Effect.Effect<string, WorkspaceRepoError>;

    /**
     * Hard-delete the workspace row; the Postgres `workspace_id` FK cascades
     * drop every workspace-scoped child (members, projects, tables,
     * credentials, shares, ...). The caller MUST purge the RESTRICTed
     * pipeline-version dependants first (PipelineRepo.purgeByWorkspace) or
     * the delete violates a FK constraint.
     */
    readonly remove: (
      workspaceId: string,
    ) => Effect.Effect<void, WorkspaceRepoError>;

    /**
     * The workspace's customer profile (org name + owner email) for Autumn
     * `customers.getOrCreate`. Ports `workspaceCustomerData`
     * (convex/workspaces.ts:351): loads the workspace, then its owner's email.
     * Returns `{ name: null, email: null }` for a missing workspace/owner.
     */
    readonly findCustomerData: (
      workspaceId: string,
    ) => Effect.Effect<WorkspaceCustomerData, WorkspaceRepoError>;

    /**
     * The user's profile ({@link WorkspaceUser}) for the `me` query's `user`
     * field, or `None` when the user row is missing.
     */
    readonly findUser: (
      userId: string,
    ) => Effect.Effect<Option.Option<WorkspaceUser>, WorkspaceRepoError>;

    /**
     * Persist the workspace's current paid plan id (`currentPlanId`) AND its trial
     * end (`trialEndsAt`, epoch ms or null when not trialing). The write-back that
     * keeps the cached snapshot in step with Autumn — `BillingService.syncPlan`
     * calls it with the live plan id + trial end (both null for Free), and trial
     * start seeds it. Drives the plan badge, the cloud-access gate, the in-app
     * trial countdown, and the email-reminder scan.
     */
    readonly updatePlan: (
      workspaceId: string,
      planId: string | null,
      trialEndsAt: number | null,
    ) => Effect.Effect<void, WorkspaceRepoError>;

    /**
     * Workspaces whose trial ends within `[fromMs, toMs]`, with the owner's email.
     * Backs the scheduled trial-ending email reminders. Excludes rows with no
     * trial or no owner email. Ordered by `trialEndsAt` ascending.
     */
    readonly findTrialsEndingBetween: (
      fromMs: number,
      toMs: number,
    ) => Effect.Effect<
      readonly {
        readonly id: string;
        readonly name: string;
        readonly ownerEmail: string;
        readonly ownerName: string | null;
        readonly trialEndsAt: number;
      }[],
      WorkspaceRepoError
    >;
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
      /** Map a thrown rejection to the typed repo error. */
      const fail = (op: string) => (cause: unknown) =>
        new WorkspaceRepoError({
          message: cause instanceof Error ? cause.message : `${op} failed`,
          cause,
        });
      /** The full workspace projection (one place so reads agree on columns). */
      const columns = {
        id: schema.workspaces.id,
        name: schema.workspaces.name,
        ownerId: schema.workspaces.ownerId,
        cloudActionsUsed: schema.workspaces.cloudActionsUsed,
        cloudActionsLimit: schema.workspaces.cloudActionsLimit,
        currentPlanId: schema.workspaces.currentPlanId,
        trialEndsAt: schema.workspaces.trialEndsAt,
      } as const;
      return {
        findById: (workspaceId) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await db
                .select(columns)
                .from(schema.workspaces)
                .where(eq(schema.workspaces.id, workspaceId))
                .limit(1);
              return Option.fromNullable(rows[0] ?? null);
            },
            catch: fail("workspace lookup"),
          }),
        findManyByIds: (workspaceIds) =>
          workspaceIds.length === 0
            ? Effect.succeed([])
            : Effect.tryPromise({
                try: () =>
                  db
                    .select(columns)
                    .from(schema.workspaces)
                    .where(inArray(schema.workspaces.id, [...workspaceIds])),
                catch: fail("workspace batch lookup"),
              }),
        insert: (workspace) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await db
                .insert(schema.workspaces)
                .values({
                  name: workspace.name,
                  ownerId: workspace.ownerId,
                  createdAt: workspace.createdAt,
                })
                .returning({ id: schema.workspaces.id });
              const id = rows[0]?.id;
              if (id === undefined) {
                throw new Error("workspace insert returned no id");
              }
              return id;
            },
            catch: fail("workspace insert"),
          }),
        findCustomerData: (workspaceId) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await db
                .select({
                  name: schema.workspaces.name,
                  email: schema.users.email,
                })
                .from(schema.workspaces)
                .leftJoin(
                  schema.users,
                  eq(schema.users.id, schema.workspaces.ownerId),
                )
                .where(eq(schema.workspaces.id, workspaceId))
                .limit(1);
              const row = rows[0];
              return row === undefined
                ? { name: null, email: null }
                : { name: row.name, email: row.email ?? null };
            },
            catch: fail("workspace customer data lookup"),
          }),
        findUser: (userId) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await db
                .select({
                  id: schema.users.id,
                  name: schema.users.name,
                  email: schema.users.email,
                  image: schema.users.image,
                })
                .from(schema.users)
                .where(eq(schema.users.id, userId))
                .limit(1);
              const row = rows[0];
              return Option.fromNullable(
                row === undefined
                  ? null
                  : {
                      id: row.id,
                      name: row.name ?? null,
                      email: row.email,
                      image: row.image ?? null,
                    },
              );
            },
            catch: fail("user lookup"),
          }),
        updatePlan: (workspaceId, planId, trialEndsAt) =>
          Effect.tryPromise({
            try: async () => {
              await db
                .update(schema.workspaces)
                .set({ currentPlanId: planId, trialEndsAt })
                .where(eq(schema.workspaces.id, workspaceId));
            },
            catch: fail("workspace plan update"),
          }),
        findTrialsEndingBetween: (fromMs, toMs) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await db
                .select({
                  id: schema.workspaces.id,
                  name: schema.workspaces.name,
                  trialEndsAt: schema.workspaces.trialEndsAt,
                  ownerEmail: schema.users.email,
                  ownerName: schema.users.name,
                })
                .from(schema.workspaces)
                .innerJoin(
                  schema.users,
                  eq(schema.users.id, schema.workspaces.ownerId),
                )
                .where(
                  and(
                    isNotNull(schema.workspaces.trialEndsAt),
                    gte(schema.workspaces.trialEndsAt, fromMs),
                    lte(schema.workspaces.trialEndsAt, toMs),
                  ),
                )
                .orderBy(schema.workspaces.trialEndsAt);
              return rows.flatMap((r) =>
                r.trialEndsAt === null
                  ? []
                  : [
                      {
                        id: r.id,
                        name: r.name,
                        ownerEmail: r.ownerEmail,
                        ownerName: r.ownerName ?? null,
                        trialEndsAt: r.trialEndsAt,
                      },
                    ],
              );
            },
            catch: fail("trial-ending scan"),
          }),
        remove: (workspaceId) =>
          Effect.tryPromise({
            try: () =>
              db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)),
            catch: fail("workspace delete"),
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
  users: readonly WorkspaceUser[] = [],
): Layer.Layer<WorkspaceRepo> => {
  // A mutable copy so `insert` is observable by later reads in the SAME test
  // (createWorkspace inserts, then the membership is created against the new id),
  // exactly like the live table.
  const rows: Workspace[] = [...workspaces];
  const userRows: WorkspaceUser[] = [...users];
  let seq = 0;
  return Layer.succeed(WorkspaceRepo, {
    findById: (workspaceId) =>
      Effect.succeed(
        Option.fromNullable(rows.find((w) => w.id === workspaceId)),
      ),
    findManyByIds: (workspaceIds) =>
      Effect.succeed(rows.filter((w) => workspaceIds.includes(w.id))),
    insert: (workspace) =>
      Effect.sync(() => {
        const id = `ws_${seq++}_${workspace.ownerId}`;
        rows.push({
          id,
          name: workspace.name,
          ownerId: workspace.ownerId,
        });
        return id;
      }),
    findCustomerData: (workspaceId) =>
      Effect.succeed(
        Option.match(
          Option.fromNullable(rows.find((w) => w.id === workspaceId)),
          {
            onNone: () => ({ name: null, email: null }),
            onSome: (w) => ({
              name: w.name,
              email: userRows.find((u) => u.id === w.ownerId)?.email ?? null,
            }),
          },
        ),
      ),
    findUser: (userId) =>
      Effect.succeed(
        Option.fromNullable(userRows.find((u) => u.id === userId) ?? null),
      ),
    updatePlan: (workspaceId, planId, trialEndsAt) =>
      Effect.sync(() => {
        const i = rows.findIndex((r) => r.id === workspaceId);
        if (i !== -1) {
          rows[i] = { ...rows[i], currentPlanId: planId, trialEndsAt };
        }
      }),
    findTrialsEndingBetween: (fromMs, toMs) =>
      Effect.succeed(
        rows.flatMap((w) => {
          const t = w.trialEndsAt ?? null;
          if (t === null || t < fromMs || t > toMs) return [];
          const owner = userRows.find((u) => u.id === w.ownerId);
          if (owner?.email == null) return [];
          return [
            {
              id: w.id,
              name: w.name,
              ownerEmail: owner.email,
              ownerName: owner.name ?? null,
              trialEndsAt: t,
            },
          ];
        }),
      ),
    remove: (workspaceId) =>
      Effect.sync(() => {
        const i = rows.findIndex((r) => r.id === workspaceId);
        if (i !== -1) rows.splice(i, 1);
      }),
  });
};
