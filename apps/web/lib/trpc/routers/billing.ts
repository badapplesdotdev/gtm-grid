/**
 * The `billing` tRPC router — the W2 port of convex/billing.ts.
 *
 * `checkout` collapses the Convex action/mutation split into ONE procedure:
 * Postgres procedures can make Autumn's outbound HTTP, so the privileged
 * upgrade flow is a single `BillingService.checkout` call. The service asserts
 * owner/admin authz, loads the workspace customer profile, validates the plan,
 * and returns the Autumn billing URL the UI opens.
 *
 * The procedure runs the Effect via `runEffect`, so the typed error channel
 * (`InsufficientRoleError` → FORBIDDEN, `UnknownPlanError` → 400, `AutumnError`
 * → 500, etc.) maps to tRPC codes; the SAME procedure runs against a fake Autumn
 * port under `createCaller` in tests (no SDK, no HTTP).
 */

import { BillingService } from "@gtmgrid/services";
import { Effect } from "effect";
import { z } from "zod";
import { protectedProcedure, router, runEffect } from "../trpc";

export const billingRouter = router({
  /**
   * Start a checkout/upgrade for a workspace on the chosen plan, returning the
   * Autumn billing URL. Owner/admin only (enforced inside `BillingService`).
   * `planId` is optional — omitted defaults to the team plan (the entry upsell);
   * an unknown/forged plan fails closed before any Autumn call.
   */
  checkout: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        planId: z.string().min(1).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* BillingService;
          return yield* svc.checkout(input.workspaceId, input.planId);
        }),
      ),
    ),
});
