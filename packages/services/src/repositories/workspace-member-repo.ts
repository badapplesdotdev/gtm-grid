/**
 * `WorkspaceMemberRepo` — the member-data repository (the second W2 repo the AC
 * names "MemberRepo").
 *
 * It is DISTINCT from the authz `MemberRepo` re-used from `@gtmgrid/cloud`
 * (`findMembership`, the single (workspace,user) lookup the membership guard
 * runs). That one answers "is the caller a member?"; THIS one owns the bulk
 * member-roster reads + writes the workspace domain needs:
 *
 *   - `listByUser`        — the user's memberships (the workspaces they belong
 *     to + role), backing the `me` query (convex/workspaces.ts:55).
 *   - `listByWorkspace`   — a workspace's roster (joined to each member's user
 *     row for name + email), backing `listMembers` (convex/workspaces.ts:142).
 *   - `countByWorkspace`  — the live member count per workspace, batched for the
 *     no-N+1 `me` seat usage (convex/workspaces.ts:67) and re-read inside the
 *     insert for the transactional seat ceiling (convex/workspaces.ts:233).
 *   - `findByWorkspaceUser`/`insert` — the idempotent owner/member create
 *     (convex/workspaces.ts:194, :247).
 *
 * Same repo pattern as {@link WorkspaceRepo}: a `Context.Tag` with a
 * Drizzle-backed Live Layer (each query wrapped in `Effect.tryPromise` →
 * {@link WorkspaceMemberRepoError}) and an in-memory Test Layer so the workspace
 * domain is exercised with NO live database.
 */

import { schema } from "@gtmgrid/db";
import {
  type Membership,
  MemberRepo,
  type MemberRole,
} from "@gtmgrid/cloud";
import { count, eq, inArray } from "drizzle-orm";
import { Context, Data, Effect, Layer, Option } from "effect";
import { DbClient } from "../db-client.js";

/** A membership row: which workspace, which user, what role, created when. */
export interface MemberRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: MemberRole;
  readonly createdAt: number;
}

/**
 * A roster entry: the membership joined to the member's `users` row for a
 * display name + email (convex/workspaces.ts:151). `name`/`email` are null when
 * the user row is missing.
 */
export interface MemberWithUser extends MemberRow {
  readonly name: string | null;
  readonly email: string | null;
}

/** A new membership insert (owner on create / invitee on invite). */
export interface NewMember {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: MemberRole;
  readonly createdAt: number;
}

/** Raised when a member read/write fails (DB/transport error). */
export class WorkspaceMemberRepoError extends Data.TaggedError(
  "WorkspaceMemberRepoError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The member-data repository. Backed by Drizzle over `@gtmgrid/db` in production
 * ({@link WorkspaceMemberRepoLive}); backed by an in-memory list in tests
 * ({@link workspaceMemberRepoLayer}).
 */
export class WorkspaceMemberRepo extends Context.Tag("WorkspaceMemberRepo")<
  WorkspaceMemberRepo,
  {
    /** The caller's memberships (their workspaces + role) — backs `me`. */
    readonly listByUser: (
      userId: string,
    ) => Effect.Effect<readonly MemberRow[], WorkspaceMemberRepoError>;

    /**
     * A workspace's roster, each member joined to their user row (name + email),
     * for `listMembers`. Unordered — the service sorts by `createdAt`.
     */
    readonly listByWorkspace: (
      workspaceId: string,
    ) => Effect.Effect<readonly MemberWithUser[], WorkspaceMemberRepoError>;

    /**
     * The member count per workspace id, in ONE grouped query (the batched read
     * for the no-N+1 `me` seat usage). Missing ids read as 0 (absent from the
     * returned map); the caller defaults them.
     */
    readonly countByWorkspaceIds: (
      workspaceIds: readonly string[],
    ) => Effect.Effect<
      ReadonlyMap<string, number>,
      WorkspaceMemberRepoError
    >;

    /** The live member count for a single workspace (the seat-ceiling re-read). */
    readonly countByWorkspace: (
      workspaceId: string,
    ) => Effect.Effect<number, WorkspaceMemberRepoError>;

    /** The membership for (workspace,user), or `None` — the idempotency check. */
    readonly findByWorkspaceUser: (
      workspaceId: string,
      userId: string,
    ) => Effect.Effect<Option.Option<MemberRow>, WorkspaceMemberRepoError>;

    /** Insert a membership and return its generated id. */
    readonly insert: (
      member: NewMember,
    ) => Effect.Effect<string, WorkspaceMemberRepoError>;
  }
>() {}

/**
 * The Drizzle-backed `WorkspaceMemberRepo` Layer. Depends on {@link DbClient}.
 * Each query is wrapped in `Effect.tryPromise` so a transport failure becomes a
 * typed {@link WorkspaceMemberRepoError}.
 */
export const WorkspaceMemberRepoLive: Layer.Layer<
  WorkspaceMemberRepo,
  never,
  DbClient
> = Layer.effect(
  WorkspaceMemberRepo,
  Effect.gen(function* () {
    const db = yield* DbClient;
    const fail = (op: string) => (cause: unknown) =>
      new WorkspaceMemberRepoError({
        message: cause instanceof Error ? cause.message : `${op} failed`,
        cause,
      });
    return {
      listByUser: (userId) =>
        Effect.tryPromise({
          try: () =>
            db
              .select({
                id: schema.members.id,
                workspaceId: schema.members.workspaceId,
                userId: schema.members.userId,
                role: schema.members.role,
                createdAt: schema.members.createdAt,
              })
              .from(schema.members)
              .where(eq(schema.members.userId, userId)),
          catch: fail("member listByUser"),
        }),
      listByWorkspace: (workspaceId) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db
              .select({
                id: schema.members.id,
                workspaceId: schema.members.workspaceId,
                userId: schema.members.userId,
                role: schema.members.role,
                createdAt: schema.members.createdAt,
                name: schema.users.name,
                email: schema.users.email,
              })
              .from(schema.members)
              .leftJoin(
                schema.users,
                eq(schema.users.id, schema.members.userId),
              )
              .where(eq(schema.members.workspaceId, workspaceId));
            return rows.map((r) => ({
              id: r.id,
              workspaceId: r.workspaceId,
              userId: r.userId,
              role: r.role,
              createdAt: r.createdAt,
              name: r.name ?? null,
              email: r.email ?? null,
            }));
          },
          catch: fail("member listByWorkspace"),
        }),
      countByWorkspaceIds: (workspaceIds) =>
        workspaceIds.length === 0
          ? Effect.succeed(new Map<string, number>())
          : Effect.tryPromise({
              try: async () => {
                const rows = await db
                  .select({
                    workspaceId: schema.members.workspaceId,
                    n: count(),
                  })
                  .from(schema.members)
                  .where(
                    inArray(schema.members.workspaceId, [...workspaceIds]),
                  )
                  .groupBy(schema.members.workspaceId);
                return new Map(rows.map((r) => [r.workspaceId, Number(r.n)]));
              },
              catch: fail("member countByWorkspaceIds"),
            }),
      countByWorkspace: (workspaceId) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db
              .select({ n: count() })
              .from(schema.members)
              .where(eq(schema.members.workspaceId, workspaceId));
            return Number(rows[0]?.n ?? 0);
          },
          catch: fail("member countByWorkspace"),
        }),
      findByWorkspaceUser: (workspaceId, userId) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db
              .select({
                id: schema.members.id,
                workspaceId: schema.members.workspaceId,
                userId: schema.members.userId,
                role: schema.members.role,
                createdAt: schema.members.createdAt,
              })
              .from(schema.members)
              .where(eq(schema.members.workspaceId, workspaceId))
              .limit(200);
            return Option.fromNullable(
              rows.find((r) => r.userId === userId) ?? null,
            );
          },
          catch: fail("member findByWorkspaceUser"),
        }),
      insert: (member) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db
              .insert(schema.members)
              .values({
                workspaceId: member.workspaceId,
                userId: member.userId,
                role: member.role,
                createdAt: member.createdAt,
              })
              .returning({ id: schema.members.id });
            const id = rows[0]?.id;
            if (id === undefined) {
              throw new Error("member insert returned no id");
            }
            return id;
          },
          catch: fail("member insert"),
        }),
    };
  }),
);

const strip = (m: MemberWithUser): MemberRow => ({
  id: m.id,
  workspaceId: m.workspaceId,
  userId: m.userId,
  role: m.role,
  createdAt: m.createdAt,
});

/**
 * Build BOTH in-memory member repos over ONE shared, mutable row store:
 *
 *   - {@link WorkspaceMemberRepo} — the data repo (roster/counts/insert), and
 *   - the authz `MemberRepo` (@gtmgrid/cloud `findMembership`) backing the
 *     membership guard.
 *
 * Sharing the store is what makes the in-memory seam behave like the single live
 * `members` table: a membership inserted via `WorkspaceMemberRepo.insert`
 * (e.g. the owner row `createWorkspace` writes) is IMMEDIATELY visible to the
 * authz guard's `findMembership`, exactly as a row inserted into Postgres would
 * be. Without this, the two repos would be decoupled and a freshly-created owner
 * would fail the membership check.
 *
 * Used by the composed `TestLayer`; tests that only need the data repo can use
 * {@link workspaceMemberRepoLayer}.
 */
export const memberStoreLayers = (
  members: readonly MemberWithUser[],
): {
  readonly workspaceMemberRepo: Layer.Layer<WorkspaceMemberRepo>;
  readonly memberRepo: Layer.Layer<MemberRepo>;
} => {
  const rows: MemberWithUser[] = [...members];
  let seq = 0;
  const workspaceMemberRepo = Layer.succeed(WorkspaceMemberRepo, {
    listByUser: (userId) =>
      Effect.succeed(rows.filter((m) => m.userId === userId).map(strip)),
    listByWorkspace: (workspaceId) =>
      Effect.succeed(rows.filter((m) => m.workspaceId === workspaceId)),
    countByWorkspaceIds: (workspaceIds) =>
      Effect.sync(() => {
        const map = new Map<string, number>();
        for (const m of rows) {
          if (workspaceIds.includes(m.workspaceId)) {
            map.set(m.workspaceId, (map.get(m.workspaceId) ?? 0) + 1);
          }
        }
        return map;
      }),
    countByWorkspace: (workspaceId) =>
      Effect.succeed(rows.filter((m) => m.workspaceId === workspaceId).length),
    findByWorkspaceUser: (workspaceId, userId) =>
      Effect.succeed(
        Option.fromNullable(
          rows.find(
            (m) => m.workspaceId === workspaceId && m.userId === userId,
          ) ?? null,
        ).pipe(Option.map(strip)),
      ),
    insert: (member) =>
      Effect.sync(() => {
        const id = `mem_${seq++}`;
        rows.push({
          id,
          workspaceId: member.workspaceId,
          userId: member.userId,
          role: member.role,
          createdAt: member.createdAt,
          name: null,
          email: null,
        });
        return id;
      }),
  });
  const memberRepo = Layer.succeed(MemberRepo, {
    findMembership: (workspaceId, userId) =>
      Effect.succeed(
        Option.fromNullable(
          rows.find(
            (m) => m.workspaceId === workspaceId && m.userId === userId,
          ) ?? null,
        ).pipe(
          Option.map(
            (m): Membership => ({
              workspaceId: m.workspaceId,
              userId: m.userId,
              role: m.role,
            }),
          ),
        ),
      ),
  });
  return { workspaceMemberRepo, memberRepo };
};

/**
 * An in-memory `WorkspaceMemberRepo` Layer backed by a mutable list of
 * {@link MemberWithUser} rows (name/email may be null when the fixture omits a
 * user). Writes (`insert`) are observable by later reads in the same instance.
 * Used by the repo's own unit tests; the composed `TestLayer` uses
 * {@link memberStoreLayers} so the authz guard shares this store.
 */
export const workspaceMemberRepoLayer = (
  members: readonly MemberWithUser[],
): Layer.Layer<WorkspaceMemberRepo> =>
  memberStoreLayers(members).workspaceMemberRepo;
