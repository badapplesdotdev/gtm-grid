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
 * + by `syncPlan`) or `null` for Free.
 *
 * TIME-BASED BACKSTOP: the cached `currentPlanId` lags reality — a trial that has
 * lapsed *by date* keeps `currentPlanId = "team"` until Autumn's webhook fires or
 * the desktop re-syncs, and in that window credited actions would still run. So the
 * gate ALSO fails the instant `trialEndsAt` is in the past, regardless of the
 * cached plan id. A converted paid plan has `trialEndsAt = null` (cleared by
 * `syncPlan`), so it is unaffected; a lapsed trial keeps its (now-past)
 * `trialEndsAt` (see `BillingService` lapse branch) so this check closes
 * immediately. Net: "has a non-null plan id AND not past a trial end" == access.
 *
 * `requireCloudAccess` is the single seam every cloud-data procedure / service
 * calls (alongside `requireMember`). Membership/billing/workspace-management
 * procedures do NOT call it, so a locked-out owner can still view the workspace
 * and upgrade.
 */

import { Clock, Data, Effect, Option } from "effect";
import {
  WorkspaceRepo,
  type WorkspaceRepoError,
} from "../repositories/workspace-repo.js";
import { isSelfHost } from "../self-host.js";

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
       * Assert the workspace currently has cloud access (a paid plan or an
       * UNEXPIRED trial). Fails with {@link PlanRequiredError} when it is on Free
       * (no `currentPlanId`) OR when its trial has lapsed by date
       * (`trialEndsAt <= now`), so the caller rejects the cloud operation — even
       * before Autumn has synced the lapse into `currentPlanId`.
       */
      const requireCloudAccess = (
        workspaceId: string,
      ): Effect.Effect<void, PlanRequiredError | WorkspaceRepoError> =>
        Effect.gen(function* () {
          // SELF-HOST: the paid cloud-access gate does not apply. A self-hosted
          // instance has no billing backend, so every workspace is Free (null
          // plan) yet must retain full cloud-tier access indefinitely. Gated by
          // `GTMGRID_SELF_HOST=1`; the hosted product leaves it unset and the
          // entitlement check below applies as normal. See SELF-HOST.md.
          if (isSelfHost()) return;
          const ws = yield* repo.findById(workspaceId);
          const planId = Option.match(ws, {
            onNone: () => null,
            onSome: (w) => w.currentPlanId ?? null,
          });
          const trialEndsAt = Option.match(ws, {
            onNone: () => null,
            onSome: (w) => w.trialEndsAt ?? null,
          });
          // A lapsed trial blocks immediately, regardless of the cached plan id:
          // the Autumn webhook/sync that flips `currentPlanId` to null lags the
          // real trial end, and credited actions must stop the moment it passes.
          const now = yield* Clock.currentTimeMillis;
          const trialLapsed = trialEndsAt !== null && trialEndsAt <= now;
          if (planId !== null && !trialLapsed) return;
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
