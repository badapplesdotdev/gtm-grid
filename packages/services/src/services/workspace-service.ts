/**
 * `WorkspaceService` — the WORKED-EXAMPLE domain service proving the
 * service-over-repository pattern end-to-end.
 *
 * Where a REPOSITORY is the raw table adapter, a SERVICE composes one or more
 * repositories (and other services) into a domain operation with the business
 * rules attached. This one exposes `getWorkspace`, which:
 *
 *   1. Asserts the caller is a member of the workspace via the ported authz
 *      core (`MembershipService.requireMember`, the Effect port of
 *      convex/model/auth.ts:162) — so a non-member is rejected BEFORE any data
 *      is returned.
 *   2. Loads the workspace through {@link WorkspaceRepo}, failing with
 *      {@link WorkspaceNotFoundError} when it does not exist.
 *
 * It is defined with the `Effect.Service` pattern (Tag + Layer in one) and
 * declares its dependencies; the composed {@link AppLayer} wires the live
 * implementations, while tests provide in-memory repo/identity Layers and get
 * the SAME service with different behaviour — the DI seam the AC requires.
 *
 * See packages/engine/src/sample-service.ts for the canonical shape.
 */

import {
  type InsufficientRoleError,
  type Membership,
  MembershipService,
  type MemberRepoError,
  type MemberRole,
  type NotAMemberError,
  type UnauthenticatedError,
} from "@gtmgrid/cloud";
import { Data, Effect } from "effect";
import {
  type Workspace,
  WorkspaceRepo,
  type WorkspaceRepoError,
} from "../repositories/workspace-repo.js";

/**
 * Raised when an authorized caller requests a workspace that does not exist.
 * Distinct from the authz failures (`NotAMemberError`) so the procedure layer
 * can map it to a 404 rather than a 403.
 */
export class WorkspaceNotFoundError extends Data.TaggedError(
  "WorkspaceNotFoundError",
)<{
  readonly message: string;
  readonly workspaceId: string;
}> {}

/** The full error channel of {@link WorkspaceService.getWorkspace}. */
export type GetWorkspaceError =
  | UnauthenticatedError
  | NotAMemberError
  | InsufficientRoleError
  | MemberRepoError
  | WorkspaceRepoError
  | WorkspaceNotFoundError;

/**
 * Workspace domain service. Composes {@link WorkspaceRepo} +
 * {@link MembershipService} into membership-guarded workspace reads.
 */
export class WorkspaceService extends Effect.Service<WorkspaceService>()(
  "WorkspaceService",
  {
    effect: Effect.gen(function* () {
      const repo = yield* WorkspaceRepo;
      const membership = yield* MembershipService;

      /**
       * Return the workspace for a caller who is a MEMBER of it. Fails with the
       * typed authz errors when the caller is signed out / not a member, and
       * with {@link WorkspaceNotFoundError} when the workspace is missing.
       */
      const getWorkspace = (
        workspaceId: string,
      ): Effect.Effect<Workspace, GetWorkspaceError> =>
        Effect.gen(function* () {
          yield* membership.requireMember(workspaceId);
          const found = yield* repo.findById(workspaceId);
          if (found._tag === "None") {
            return yield* Effect.fail(
              new WorkspaceNotFoundError({
                message: `Workspace ${workspaceId} not found.`,
                workspaceId,
              }),
            );
          }
          return found.value;
        });

      /**
       * Like {@link getWorkspace} but additionally requires the caller's role to
       * be one of `roles` (ports `requireRole`, convex/model/auth.ts:180). The
       * returned {@link Membership} carries the asserted role.
       */
      const requireWorkspaceRole = (
        workspaceId: string,
        roles: readonly MemberRole[],
      ): Effect.Effect<
        Membership,
        | UnauthenticatedError
        | NotAMemberError
        | InsufficientRoleError
        | MemberRepoError
      > => membership.requireRole(workspaceId, roles);

      return { getWorkspace, requireWorkspaceRole } as const;
    }),
    // MembershipService + WorkspaceRepo must be provided before this service is
    // built; AppLayer (or a TestLayer) supplies them.
    dependencies: [],
  },
) {}
