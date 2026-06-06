/**
 * Personal-credential ownership rules for the Convex cloud tier.
 *
 * A `personal`-scope credential belongs to a SINGLE member, not the whole
 * workspace. Without an owner binding, two members of the same workspace saving
 * a personal key for the same connector would collide on
 * (workspaceId, extensionId, scope) — and any member could read or rotate
 * another member's personal key. This module is the pure, unit-tested source of
 * truth for the two ownership decisions the Convex credential functions make:
 *
 *   1. {@link CredentialOwnershipService.ownerFor} — the `ownerUserId` a row of
 *      a given `scope` must be stored/looked-up under. `personal` rows are bound
 *      to the current user; `workspace` rows are shared (no owner).
 *
 *   2. {@link CredentialOwnershipService.assertCanAccess} — whether the current
 *      user may read/rotate an EXISTING row. A `personal` row owned by someone
 *      else is rejected with {@link CredentialOwnershipError}; `workspace` rows
 *      are accessible to any member (membership is checked separately upstream).
 *
 * Like the rest of @gtmgrid/cloud this file has NO Convex import: the Convex
 * function (convex/credentialsData.ts) calls these decisions after it has
 * resolved the current user id and (for `assertCanAccess`) fetched the row's
 * stored owner. That keeps the ownership rules exhaustively unit-testable with
 * zero Convex codegen, mirroring membership.ts / cascade.ts.
 *
 * Follows the canonical Effect pattern: a typed `Data.TaggedError` in the error
 * channel and the service as an `Effect.Service` with a `.Default` Layer.
 */

import { Data, Effect, Option } from "effect";

/** Credential scope. Mirrors `credentialScope` in convex/schema.ts. */
export type CredentialScope = "workspace" | "personal";

/**
 * Raised when the current user attempts to read or rotate a `personal`
 * credential owned by a DIFFERENT user. The typed authz failure the Convex
 * layer surfaces as a `ConvexError`. Distinct from a membership failure: the
 * caller IS a workspace member, but the row is someone else's personal key.
 */
export class CredentialOwnershipError extends Data.TaggedError(
  "CredentialOwnershipError",
)<{
  readonly message: string;
  readonly extensionId: string;
}> {}

/**
 * Personal-credential ownership service. Pure rules with no dependencies; the
 * Convex layer supplies the resolved user id + the stored row owner.
 */
export class CredentialOwnershipService extends Effect.Service<CredentialOwnershipService>()(
  "CredentialOwnershipService",
  {
    sync: () => ({
      /**
       * The `ownerUserId` a row of `scope` must be stored under and filtered by.
       *   - `personal` → `Some(currentUserId)`: the row belongs to this user, so
       *     storage upserts and reads scope to (workspace, extension, scope,
       *     owner). Two members no longer collide.
       *   - `workspace` → `None`: the row is shared; it has no owner binding.
       */
      ownerFor: (
        scope: CredentialScope,
        currentUserId: string,
      ): Option.Option<string> =>
        scope === "personal"
          ? Option.some(currentUserId)
          : Option.none<string>(),

      /**
       * Assert the current user may read/rotate an EXISTING credential row.
       *
       * @param scope the row's scope.
       * @param extensionId the row's connector id (for the error message).
       * @param currentUserId the authenticated caller.
       * @param storedOwnerUserId the row's persisted `ownerUserId` (`None` for a
       *   `workspace` row, or a legacy `personal` row written before ownership
       *   binding existed).
       *
       * `workspace` rows are always accessible (membership is enforced upstream).
       * A `personal` row is accessible ONLY when its stored owner is the current
       * user; a mismatch fails with {@link CredentialOwnershipError}. A
       * `personal` row with NO stored owner (legacy) is also rejected: it cannot
       * be proven to belong to the caller, so we fail closed rather than leak it.
       */
      assertCanAccess: (args: {
        readonly scope: CredentialScope;
        readonly extensionId: string;
        readonly currentUserId: string;
        readonly storedOwnerUserId: Option.Option<string>;
      }): Effect.Effect<void, CredentialOwnershipError> => {
        if (args.scope === "workspace") return Effect.void;
        return Option.match(args.storedOwnerUserId, {
          onNone: () =>
            Effect.fail(
              new CredentialOwnershipError({
                message:
                  `Personal credential for ${args.extensionId} has no owner ` +
                  "binding and cannot be accessed.",
                extensionId: args.extensionId,
              }),
            ),
          onSome: (owner) =>
            owner === args.currentUserId
              ? Effect.void
              : Effect.fail(
                  new CredentialOwnershipError({
                    message:
                      `Personal credential for ${args.extensionId} belongs to ` +
                      "another member.",
                    extensionId: args.extensionId,
                  }),
                ),
        });
      },
    }),
  },
) {}
