/**
 * `EntitlementService` — the cloud-access gate.
 *
 * A workspace may use the cloud tier (cloud tables/projects, realtime
 * multiplayer, shared credentials, webhooks) only while it is on a PAID plan or
 * an active trial. New signups get a 7-day Team trial; when it lapses with no
 * card the workspace falls back to Free and the cloud tier LOCKS — only the
 * local-first features remain.
 *
 * The check is intentionally CHEAP (no outbound Autumn call on the hot path): it
 * reads the workspace's cached `currentPlanId`, which `BillingService.syncPlan`
 * keeps in step with Autumn (the desktop re-syncs on app open / window focus /
 * billing open). `currentPlanId` is only ever a PAID plan id (set on trial start
 * + by `syncPlan`) or `null` for Free — so "has a plan id" == "has cloud access".
 *
 * `requireCloudAccess` is the single seam every cloud-data procedure / service
 * calls (alongside `requireMember`). Membership/billing/workspace-management
 * procedures do NOT call it, so a locked-out owner can still view the workspace
 * and upgrade.
 */

import { Data, Effect, Option } from "effect";
import {
  WorkspaceRepo,
  type WorkspaceRepoError,
} from "../repositories/workspace-repo.js";

/**
 * Raised when a workspace without an active cloud plan attempts a cloud-tier
 * operation. Mapped to a tRPC `FORBIDDEN`; the desktop also gates the cloud UI
 * proactively from `me.plan`, so this is the server-side backstop against bypass.
 */
export class PlanRequiredError extends Data.TaggedError("PlanRequiredError")<{
  readonly message: string;
  readonly workspaceId: string;
}> {}

export class EntitlementService extends Effect.Service<EntitlementService>()(
  "EntitlementService",
  {
    effect: Effect.gen(function* () {
      const repo = yield* WorkspaceRepo;

      /**
       * Assert the workspace currently has cloud access (a paid plan or active
       * trial). Fails with {@link PlanRequiredError} when it is on Free (no
       * `currentPlanId`) so the caller rejects the cloud operation.
       */
      const requireCloudAccess = (
        workspaceId: string,
      ): Effect.Effect<void, PlanRequiredError | WorkspaceRepoError> =>
        Effect.gen(function* () {
          const ws = yield* repo.findById(workspaceId);
          const planId = Option.match(ws, {
            onNone: () => null,
            onSome: (w) => w.currentPlanId ?? null,
          });
          if (planId !== null) return;
          return yield* Effect.fail(
            new PlanRequiredError({
              message:
                "This workspace's cloud plan is inactive. Upgrade to access " +
                "cloud tables, realtime and shared credentials.",
              workspaceId,
            }),
          );
        });

      return { requireCloudAccess } as const;
    }),
    dependencies: [],
  },
) {}
