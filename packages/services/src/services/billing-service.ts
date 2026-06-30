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
  ALL_PAID_PLAN_IDS,
  AutumnClient,
  type AutumnError,
  type InsufficientRoleError,
  MembershipService,
  type MemberRepoError,
  type NoCheckoutUrlError,
  type NotAMemberError,
  planName,
  SeatsService,
  type UnauthenticatedError,
  type UnknownPlanError,
} from "@gtmgrid/cloud";
import { TEAM_PLAN_ID } from "@gtmgrid/cloud";
import { Effect, Option } from "effect";
import {
  WorkspaceMemberRepo,
  type WorkspaceMemberRepoError,
} from "../repositories/workspace-member-repo.js";
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

/** The full error channel of {@link BillingService.syncPlan}. */
export type SyncPlanError =
  | UnauthenticatedError
  | NotAMemberError
  | MemberRepoError
  | WorkspaceRepoError
  | AutumnError;

/** The resolved plan after a sync: the Autumn plan id (null = Free) + name. */
export interface SyncedPlan {
  readonly id: string | null;
  readonly name: string;
  /** Epoch ms the trial ends, or null when not trialing. */
  readonly trialEndsAt: number | null;
}

/** The error channel of {@link BillingService.syncPlanFromWebhook} — no authz
 *  tags, since a secret-gated webhook has no member identity. */
export type SyncPlanFromWebhookError = WorkspaceRepoError | AutumnError;

/** The error channel of {@link BillingService.previewSeatChange}. */
export type PreviewSeatChangeError =
  | UnauthenticatedError
  | NotAMemberError
  | MemberRepoError
  | WorkspaceMemberRepoError
  | WorkspaceRepoError
  | AutumnError;

/** A preview of the bill after adding seats: the new seat count + monthly total. */
export interface SeatChangePreview {
  /** The projected total seat count (current members + the ones being added). */
  readonly seats: number;
  /** The projected recurring total for that many seats. */
  readonly total: number;
  /** ISO currency code, e.g. "usd". */
  readonly currency: string;
}

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
      const memberRepo = yield* WorkspaceMemberRepo;
      const seats = yield* SeatsService;
      const autumn = yield* AutumnClient;

      /**
       * Persist the reconciled plan, PRESERVING a lapsed trial's `trialEndsAt`.
       *
       * When a paid/trialing sub is active we cache its own `trialEndsAt` (a future
       * date while trialing, `null` once converted to paid). But when the sub
       * lapses (`planId === null`, so the resolved `trialEndsAt` is `null` too) we
       * must NOT blindly null the column: an EXPIRED TRIAL keeps its (now-past)
       * `trialEndsAt` so both the server backstop (`EntitlementService` blocks on
       * `trialEndsAt <= now`) and the desktop can tell "trial expired" apart from a
       * cancelled paid plan / never-trialed Free workspace (both of which already
       * have `trialEndsAt === null`). We therefore fall back to the workspace's
       * existing `trialEndsAt` whenever the resolved one is null.
       */
      const persistResolvedPlan = (
        workspaceId: string,
        planId: string | null,
        resolvedTrialEndsAt: number | null,
      ): Effect.Effect<number | null, WorkspaceRepoError> =>
        Effect.gen(function* () {
          let trialEndsAt = resolvedTrialEndsAt;
          if (trialEndsAt === null) {
            const ws = yield* repo.findById(workspaceId);
            trialEndsAt = Option.match(ws, {
              onNone: () => null,
              onSome: (w) => w.trialEndsAt ?? null,
            });
          }
          yield* repo.updatePlan(workspaceId, planId, trialEndsAt);
          return trialEndsAt;
        });

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

      /**
       * Reconcile the workspace's cached `currentPlanId` with the LIVE Autumn
       * subscription and return the resolved plan. This is what makes an upgrade —
       * whether bought in-app OR changed manually in the Autumn dashboard —
       * actually appear in the app: the `me` query reads the cached column (no
       * outbound HTTP on that hot path), and this reconciles it on demand.
       *
       * The workspace id IS the Autumn customer id. Any MEMBER may refresh the
       * view (billing CHANGES stay owner/admin in {@link checkout}). We pick the
       * first ACTIVE paid subscription (monthly or annual) from Autumn, cache its
       * plan id + trial end, and return `{ id, name, trialEndsAt }`; no active
       * paid plan → `null`. A lapsed trial keeps its (now-past) `trialEndsAt` (see
       * {@link persistResolvedPlan}) so it reads as "trial expired", not Free.
       */
      const syncPlan = (
        workspaceId: string,
      ): Effect.Effect<SyncedPlan, SyncPlanError> =>
        Effect.gen(function* () {
          yield* membership.requireMember(workspaceId);
          const subs = yield* autumn.getActiveSubscriptions({
            customerId: workspaceId,
          });
          const paidPlanIds: readonly string[] = ALL_PAID_PLAN_IDS;
          const paid = subs.find((s) => paidPlanIds.includes(s.planId)) ?? null;
          const planId = paid?.planId ?? null;
          const trialEndsAt = yield* persistResolvedPlan(
            workspaceId,
            planId,
            paid?.trialEndsAt ?? null,
          );
          return { id: planId, name: planName(planId), trialEndsAt };
        });

      /**
       * Webhook variant of {@link syncPlan}: reconcile the cached plan with the
       * live Autumn subscription WITHOUT a member-identity check. The caller (the
       * billing webhook route) is gated by a shared secret, so there is no session
       * to run `requireMember` against — exactly like the secret-trusted worker
       * routes that run with `userId: null`. This is what revokes cloud access when
       * a subscription is cancelled / lapses OUTSIDE the app (no active paid sub →
       * plan id `null`; a lapsed trial keeps its past `trialEndsAt`, a cancelled
       * paid plan stays `null` — see {@link persistResolvedPlan}).
       */
      const syncPlanFromWebhook = (
        workspaceId: string,
      ): Effect.Effect<SyncedPlan, SyncPlanFromWebhookError> =>
        Effect.gen(function* () {
          const subs = yield* autumn.getActiveSubscriptions({
            customerId: workspaceId,
          });
          const paidPlanIds: readonly string[] = ALL_PAID_PLAN_IDS;
          const paid = subs.find((s) => paidPlanIds.includes(s.planId)) ?? null;
          const planId = paid?.planId ?? null;
          const trialEndsAt = yield* persistResolvedPlan(
            workspaceId,
            planId,
            paid?.trialEndsAt ?? null,
          );
          return { id: planId, name: planName(planId), trialEndsAt };
        });

      /**
       * Preview the recurring bill AFTER adding `addSeats` seat(s) to the
       * workspace, so the UI can confirm the new price before an invite that
       * raises the subscription. Members-only (read-only preview). Seats =
       * current member count + `addSeats`; priced against the workspace's current
       * plan (defaulting to Team) via Autumn `previewAttach` — no change is made.
       */
      const previewSeatChange = (
        workspaceId: string,
        addSeats = 1,
      ): Effect.Effect<SeatChangePreview, PreviewSeatChangeError> =>
        Effect.gen(function* () {
          yield* membership.requireMember(workspaceId);
          const count = yield* memberRepo.countByWorkspace(workspaceId);
          const ws = yield* repo.findById(workspaceId);
          const planId = Option.match(ws, {
            onNone: () => TEAM_PLAN_ID as string,
            onSome: (w) => w.currentPlanId ?? TEAM_PLAN_ID,
          });
          const seatTarget = count + Math.max(1, addSeats);
          const preview = yield* autumn.previewSeatChange({
            customerId: workspaceId,
            planId,
            seats: seatTarget,
          });
          return {
            seats: preview.seats,
            total: preview.total,
            currency: preview.currency,
          };
        });

      return { checkout, syncPlan, syncPlanFromWebhook, previewSeatChange } as const;
    }),
    dependencies: [],
  },
) {}
