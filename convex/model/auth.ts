/**
 * Convex ↔ Effect authz bridge (T3).
 *
 * This is the seam between Convex handlers and the pure authz domain logic in
 * `@gtmgrid/cloud` (packages/cloud/src/membership.ts). It does two things:
 *
 *   1. `getCurrentUser(ctx)` / `getCurrentUserId(ctx)` — the identity helpers
 *      that read `ctx.auth` (via Convex Auth's `getAuthUserId`) and load the
 *      `users` document.
 *
 *   2. `cloudAuthLayer(ctx)` + `requireMember(ctx, workspaceId)` — provide the
 *      `Identity` and `MemberRepo` services backed by THIS request's `ctx`, then
 *      run the `MembershipService` domain logic via `Effect.runPromise`. This is
 *      THE reusable authz guard every T4 query/mutation calls; it throws a
 *      `ConvexError` (so the typed failure crosses the Convex boundary cleanly)
 *      when the caller is unauthenticated or not a member.
 *
 * Business rules live in `@gtmgrid/cloud` (unit-tested with Effect test Layers);
 * this file only wires `ctx` in and translates the typed error channel into the
 * `ConvexError` Convex clients understand.
 */

import {
  Identity,
  MemberRepo,
  MemberRepoError,
  MembershipService,
  type MemberRole,
  type Membership,
} from "@gtmgrid/cloud";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import type { Doc, Id } from "../_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../_generated/server.js";

/** Any ctx that can read the DB + auth (query, mutation, or action via runner). */
type AuthCtx = QueryCtx | MutationCtx;

/**
 * The authenticated user's id for this request, or `null` if signed out.
 * Thin wrapper over Convex Auth's `getAuthUserId`.
 */
export async function getCurrentUserId(
  ctx: AuthCtx,
): Promise<Id<"users"> | null> {
  return await getAuthUserId(ctx);
}

/**
 * The authenticated user document for this request, or `null` if signed out
 * (or the user row was deleted). The identity helper the AC calls for.
 */
export async function getCurrentUser(
  ctx: AuthCtx,
): Promise<Doc<"users"> | null> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) return null;
  return await ctx.db.get(userId);
}

/**
 * `Identity` Layer backed by this request's `ctx.auth`. Resolves the current
 * user id to `Option.some(id)` / `Option.none()` — exactly the shape the test
 * `identityLayer` provides.
 */
const identityLayer = (ctx: AuthCtx): Layer.Layer<Identity> =>
  Layer.succeed(Identity, {
    // `getAuthUserId` returns `Id<"users"> | null`; `Id<"users">` is a branded
    // string, so the resolved `Option<Id<"users">>` flows into the domain's
    // `Membership.userId: string` with no cast.
    currentUserId: Effect.promise(() => getAuthUserId(ctx)).pipe(
      Effect.map((id) => Option.fromNullable(id)),
    ),
  });

/**
 * `MemberRepo` Layer backed by `ctx.db`, querying the `members` table through
 * the `by_workspace_user` index — the same lookup the test `memberRepoLayer`
 * simulates in memory.
 */
const memberRepoLayer = (ctx: AuthCtx): Layer.Layer<MemberRepo> =>
  Layer.succeed(MemberRepo, {
    findMembership: (workspaceId, userId) =>
      Effect.tryPromise({
        try: async () => {
          // The domain passes `workspaceId` as a plain string; narrow it to a
          // real `Id<"workspaces">` via `normalizeId` (no cast). An invalid /
          // foreign id normalizes to null → treated as "no membership".
          const wsId = ctx.db.normalizeId("workspaces", workspaceId);
          if (wsId === null) return Option.none<Membership>();
          const row = await ctx.db
            .query("members")
            .withIndex("by_workspace_user", (q) =>
              q.eq("workspaceId", wsId).eq("userId", userId),
            )
            .unique();
          return Option.fromNullable(
            row === null
              ? null
              : ({
                  workspaceId: row.workspaceId,
                  userId: row.userId,
                  role: row.role,
                } satisfies Membership),
          );
        },
        catch: (cause) =>
          new MemberRepoError({
            message:
              cause instanceof Error
                ? cause.message
                : "membership lookup failed",
            cause,
          }),
      }),
  });

/**
 * The composed Effect `Layer` providing `MembershipService` + its `Identity`
 * and `MemberRepo` dependencies for this request. Pass to `Effect.provide`.
 */
export const cloudAuthLayer = (
  ctx: AuthCtx,
): Layer.Layer<MembershipService> =>
  MembershipService.Default.pipe(
    Layer.provide(identityLayer(ctx)),
    Layer.provide(memberRepoLayer(ctx)),
  );

/**
 * Run a `MembershipService` program for `ctx`, translating a typed authz
 * failure into a `ConvexError` the client can read. Used by the guards below.
 */
async function runAuthz<A>(
  ctx: AuthCtx,
  program: Effect.Effect<A, unknown, MembershipService>,
): Promise<A> {
  const exit = await Effect.runPromiseExit(
    program.pipe(Effect.provide(cloudAuthLayer(ctx))),
  );
  if (Exit.isSuccess(exit)) return exit.value;

  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) {
    const err = failure.value as { _tag?: string; message?: string };
    throw new ConvexError({
      code: err._tag ?? "AuthzError",
      message: err.message ?? "Authorization failed.",
    });
  }
  // A defect (non-typed crash) — rethrow as-is for Convex to log.
  throw new Error(Cause.pretty(exit.cause));
}

/**
 * THE reusable authz guard: assert the caller is a member of `workspaceId` and
 * return their membership (with role). Every workspace-scoped query/mutation
 * (T4) calls this first. Throws `ConvexError({ code: "UnauthenticatedError" })`
 * when signed out and `ConvexError({ code: "NotAMemberError" })` otherwise.
 */
export function requireMember(
  ctx: AuthCtx,
  workspaceId: Id<"workspaces">,
): Promise<Membership> {
  return runAuthz(
    ctx,
    Effect.gen(function* () {
      const svc = yield* MembershipService;
      return yield* svc.requireMember(workspaceId);
    }),
  );
}

/**
 * Like {@link requireMember} but also requires one of `roles` (e.g. owner-only
 * billing actions). Throws `ConvexError({ code: "InsufficientRoleError" })` when
 * the caller is a member without the required role.
 */
export function requireRole(
  ctx: AuthCtx,
  workspaceId: Id<"workspaces">,
  roles: readonly MemberRole[],
): Promise<Membership> {
  return runAuthz(
    ctx,
    Effect.gen(function* () {
      const svc = yield* MembershipService;
      return yield* svc.requireRole(workspaceId, roles);
    }),
  );
}
