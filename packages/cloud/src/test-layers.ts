/**
 * Deterministic test `Layer`s for the membership authz core.
 *
 * Per the Effect test conventions (docs/effect-conventions.md) we substitute
 * dependencies with real, in-memory `Layer`s instead of mocking frameworks:
 *   - {@link identityLayer} fixes the "current user" (or `None` = signed out),
 *   - {@link memberRepoLayer} backs `findMembership` with a fixed list of rows.
 *
 * These mirror exactly what the Convex layer (convex/model/auth.ts) provides
 * from `ctx.auth` / `ctx.db`, so the authz behaviour the tests assert is the
 * behaviour production runs.
 */

import { Effect, Layer, Option } from "effect";
import {
  Identity,
  MemberRepo,
  MemberRepoError,
  type Membership,
} from "./membership.js";

/**
 * An {@link Identity} Layer for a fixed caller. Pass `null`/omit to model an
 * unauthenticated request (`currentUserId` resolves to `Option.none()`).
 */
export const identityLayer = (userId: string | null): Layer.Layer<Identity> =>
  Layer.succeed(Identity, {
    currentUserId: Effect.succeed(
      userId === null ? Option.none() : Option.some(userId),
    ),
  });

/**
 * A {@link MemberRepo} Layer backed by an in-memory list of {@link Membership}
 * rows. `findMembership` matches on (workspaceId, userId), exactly like the
 * Convex `by_workspace_user` index query.
 */
export const memberRepoLayer = (
  memberships: readonly Membership[],
): Layer.Layer<MemberRepo> =>
  Layer.succeed(MemberRepo, {
    findMembership: (workspaceId, userId) =>
      Effect.succeed(
        Option.fromNullable(
          memberships.find(
            (m) => m.workspaceId === workspaceId && m.userId === userId,
          ),
        ),
      ),
  });

/**
 * A {@link MemberRepo} Layer whose `findMembership` always fails — used to
 * assert that store/transport failures surface as the typed `MemberRepoError`
 * rather than being swallowed.
 */
export const failingMemberRepoLayer = (
  message = "membership lookup failed",
): Layer.Layer<MemberRepo> =>
  Layer.succeed(MemberRepo, {
    findMembership: () => Effect.fail(new MemberRepoError({ message })),
  });
