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
import { captureServer } from "../../posthog-server";
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
    .mutation(async ({ ctx, input }) => {
      captureServer("billing_checkout_initiated", {
        distinctId: ctx.userId,
        properties: {
          workspace_id: input.workspaceId,
          plan_id: input.planId ?? "",
        },
        groups: { workspace: input.workspaceId },
      });
      return runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* BillingService;
          return yield* svc.checkout(input.workspaceId, input.planId);
        }),
      );
    }),

  /**
   * Reconcile a workspace's cached plan with its live Autumn subscription and
   * return `{ id, name }`. Any member may call it; the desktop calls it on app
   * load, on window focus, and when the billing panel opens so a plan changed in
   * Autumn (manual upgrade or completed checkout) is reflected without a restart.
   */
  syncPlan: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* BillingService;
          return yield* svc.syncPlan(input.workspaceId);
        }),
      ),
    ),

  /**
   * Preview the recurring bill after adding `addSeats` seat(s), so the desktop can
   * confirm the new price before an invite that raises the subscription. Any
   * member may preview; returns `{ seats, total, currency }`.
   */
  previewSeatChange: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        addSeats: z.number().int().min(1).optional(),
      }),
    )
    .query(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* BillingService;
          return yield* svc.previewSeatChange(input.workspaceId, input.addSeats);
        }),
      ),
    ),
});
