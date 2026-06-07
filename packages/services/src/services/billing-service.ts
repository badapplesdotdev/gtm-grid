/**
 * `BillingService` — the domain service behind the `billing.checkout` procedure.
 *
 * Ports the Convex `checkout` ACTION (convex/billing.ts:62) into a SINGLE
 * tRPC-runnable operation: in Postgres the same procedure can make Autumn's
 * outbound HTTP, so the action/mutation split collapses to one method.
 *
 *   1. Authz — owner/admin only (billing is privileged), via the ported authz
 *      core (`MembershipService.requireRole`, convex/billing.ts:40).
 *   2. Load the workspace customer profile (org name + owner email) so the
 *      checkout `attach` materialises the Autumn customer WITH a profile
 *      (convex/billing.ts:34 `assertBillingAdmin`).
 *   3. Delegate to the PURE {@link SeatsService.checkout} (@gtmgrid/cloud), which
 *      validates the plan against the paid-plan allow-list and calls Autumn
 *      `attach` through the injectable {@link AutumnClient} port. Tests provide a
 *      fake port; production provides the real `autumn-js`-backed Layer.
 *
 * Defined with the `Effect.Service` pattern (Tag + Layer), like
 * {@link WorkspaceService}; AppLayer wires the live deps, TestLayer the
 * in-memory ones, so the same procedure runs with no live DB and no SDK.
 */

import {
  type AutumnError,
  type InsufficientRoleError,
  MembershipService,
  type MemberRepoError,
  type NoCheckoutUrlError,
  type NotAMemberError,
  SeatsService,
  type UnauthenticatedError,
  type UnknownPlanError,
} from "@gtmgrid/cloud";
import { Effect } from "effect";
import {
  WorkspaceRepo,
  type WorkspaceRepoError,
} from "../repositories/workspace-repo.js";

/** The full error channel of {@link BillingService.checkout}. */
export type CheckoutError =
  | UnauthenticatedError
  | NotAMemberError
  | InsufficientRoleError
  | MemberRepoError
  | WorkspaceRepoError
  | AutumnError
  | NoCheckoutUrlError
  | UnknownPlanError;

/**
 * Billing domain service. Composes {@link MembershipService} (authz),
 * {@link WorkspaceRepo} (customer profile) and the pure {@link SeatsService}
 * (Autumn `attach`) into the privileged checkout operation.
 */
export class BillingService extends Effect.Service<BillingService>()(
  "BillingService",
  {
    effect: Effect.gen(function* () {
      const membership = yield* MembershipService;
      const repo = yield* WorkspaceRepo;
      const seats = yield* SeatsService;

      /**
       * Begin a checkout/upgrade for `workspaceId` on the chosen `planId`,
       * returning the Autumn billing URL the UI opens. Owner/admin only. The
       * workspace id IS the Autumn customer id. `planId` is validated inside the
       * pure SeatsService (unknown/forged → {@link UnknownPlanError} before any
       * Autumn call); omitted defaults to the team plan (the entry upsell).
       */
      const checkout = (
        workspaceId: string,
        planId?: string,
      ): Effect.Effect<{ readonly checkoutUrl: string }, CheckoutError> =>
        Effect.gen(function* () {
          // Authz first: only owner/admin may start a billing checkout.
          yield* membership.requireRole(workspaceId, ["owner", "admin"]);
          // The customer profile forwarded to Autumn getOrCreate via attach.
          const customerData = yield* repo.findCustomerData(workspaceId);
          const checkoutUrl = yield* seats.checkout(
            workspaceId,
            planId,
            customerData,
          );
          return { checkoutUrl };
        });

      return { checkout } as const;
    }),
    dependencies: [],
  },
) {}
