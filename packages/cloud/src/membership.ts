/**
 * Workspace authorization — the reusable authz core for the Convex cloud tier.
 *
 * `requireMember(workspaceId)` is THE pattern every cloud query/mutation (T4)
 * calls before it touches workspace-scoped data: it proves the caller is
 * (a) authenticated and (b) a member of that workspace, returning their
 * membership (with role) so the handler can do further role checks.
 *
 * This module is DELIBERATELY free of any Convex import. The two pieces of
 * environment it needs — "who is the caller?" and "look up a membership row" —
 * are abstracted behind Effect services (`Identity`, `MemberRepo`). The Convex
 * handler layer (convex/model/auth.ts) provides those services backed by
 * `ctx.auth` and `ctx.db`; the tests provide them as in-memory test `Layer`s.
 * That keeps the authz rules exhaustively unit-testable with zero mocking and
 * no Convex codegen.
 *
 * Follows the canonical Effect pattern in packages/engine/src/sample-service.ts:
 * typed `Data.TaggedError`s in the error channel, services as `Context.Tag`s,
 * implementations supplied as `Layer`s.
 */

import { Context, Data, Effect, Option } from "effect";

/** A workspace member's role. Mirrors `memberRole` in convex/schema.ts. */
export type MemberRole = "owner" | "admin" | "member";

/**
 * A workspace membership record — the projection of the `members` table the
 * authz layer needs. `userId` is the Convex Auth user id (a branded string at
 * runtime); `workspaceId` is the `workspaces` document id.
 */
export interface Membership {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: MemberRole;
}

/**
 * Raised when the caller is not authenticated (no Convex Auth identity).
 * Distinct from {@link NotAMemberError} so handlers/clients can tell "log in"
 * apart from "you don't belong here".
 */
export class UnauthenticatedError extends Data.TaggedError(
  "UnauthenticatedError",
)<{
  readonly message: string;
}> {}

/**
 * Raised when an authenticated caller is not a member of the requested
 * workspace. This is the typed authz failure the acceptance criteria require.
 */
export class NotAMemberError extends Data.TaggedError("NotAMemberError")<{
  readonly message: string;
  readonly workspaceId: string;
  readonly userId: string;
}> {}

/**
 * Raised when a required role is not satisfied (e.g. a `member` attempting an
 * owner-only action). Used by {@link MembershipService.requireRole}.
 */
export class InsufficientRoleError extends Data.TaggedError(
  "InsufficientRoleError",
)<{
  readonly message: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly required: readonly MemberRole[];
  readonly actual: MemberRole;
}> {}

/**
 * The current caller's identity. The Convex layer resolves this from
 * `ctx.auth.getUserIdentity()` / `getAuthUserId(ctx)`; tests provide a fixed
 * identity (or `Option.none()` for the unauthenticated path).
 */
export class Identity extends Context.Tag("CloudIdentity")<
  Identity,
  {
    /** The authenticated user id, or `None` when no one is signed in. */
    readonly currentUserId: Effect.Effect<Option.Option<string>>;
  }
>() {}

/**
 * Reads membership rows. Backed by `ctx.db.query("members")` (the
 * `by_workspace_user` index) in Convex; backed by an in-memory list in tests.
 */
export class MemberRepo extends Context.Tag("CloudMemberRepo")<
  MemberRepo,
  {
    /**
     * The membership row for (workspaceId, userId), or `None` if the user is
     * not a member. A read failure surfaces as the typed
     * {@link MemberRepoError}.
     */
    readonly findMembership: (
      workspaceId: string,
      userId: string,
    ) => Effect.Effect<Option.Option<Membership>, MemberRepoError>;
  }
>() {}

/** Raised when the underlying membership lookup fails (DB/transport error). */
export class MemberRepoError extends Data.TaggedError("MemberRepoError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Does `actual` satisfy one of the `required` roles? */
const roleSatisfies = (
  actual: MemberRole,
  required: readonly MemberRole[],
): boolean => required.includes(actual);

/**
 * Workspace authz service. Composes {@link Identity} + {@link MemberRepo} into
 * the reusable guards cloud handlers call.
 */
export class MembershipService extends Effect.Service<MembershipService>()(
  "MembershipService",
  {
    // `effect` init: the service resolves its two dependencies up front and
    // closes over them, so callers only provide the dependency Layers.
    effect: Effect.gen(function* () {
      const identity = yield* Identity;
      const repo = yield* MemberRepo;

      /**
       * Resolve the authenticated caller id or fail with
       * {@link UnauthenticatedError}.
       */
      const requireUserId: Effect.Effect<string, UnauthenticatedError> =
        Effect.gen(function* () {
          const maybe = yield* identity.currentUserId;
          return yield* Option.match(maybe, {
            onNone: () =>
              Effect.fail(
                new UnauthenticatedError({
                  message: "Not authenticated: no Convex Auth identity.",
                }),
              ),
            onSome: (userId) => Effect.succeed(userId),
          });
        });

      /**
       * Assert the caller is a member of `workspaceId`, returning their
       * {@link Membership}. Fails with {@link UnauthenticatedError} when no one
       * is signed in and {@link NotAMemberError} when the caller is not a
       * member. THE guard every workspace-scoped handler runs first.
       */
      const requireMember = (
        workspaceId: string,
      ): Effect.Effect<
        Membership,
        UnauthenticatedError | NotAMemberError | MemberRepoError
      > =>
        Effect.gen(function* () {
          const userId = yield* requireUserId;
          const maybe = yield* repo.findMembership(workspaceId, userId);
          return yield* Option.match(maybe, {
            onNone: () =>
              Effect.fail(
                new NotAMemberError({
                  message: `User is not a member of workspace ${workspaceId}.`,
                  workspaceId,
                  userId,
                }),
              ),
            onSome: (membership) => Effect.succeed(membership),
          });
        });

      /**
       * Like {@link requireMember} but additionally requires the caller's role
       * to be one of `roles`. Fails with {@link InsufficientRoleError} when the
       * caller is a member but lacks the role (e.g. owner-only billing actions).
       */
      const requireRole = (
        workspaceId: string,
        roles: readonly MemberRole[],
      ): Effect.Effect<
        Membership,
        | UnauthenticatedError
        | NotAMemberError
        | InsufficientRoleError
        | MemberRepoError
      > =>
        Effect.gen(function* () {
          const membership = yield* requireMember(workspaceId);
          if (!roleSatisfies(membership.role, roles)) {
            return yield* Effect.fail(
              new InsufficientRoleError({
                message: `Requires role ${roles.join(" | ")}; caller is ${membership.role}.`,
                workspaceId,
                userId: membership.userId,
                required: roles,
                actual: membership.role,
              }),
            );
          }
          return membership;
        });

      return { requireUserId, requireMember, requireRole } as const;
    }),
    // Declares which service Layers must be provided before MembershipService
    // can be built.
    dependencies: [],
  },
) {}
