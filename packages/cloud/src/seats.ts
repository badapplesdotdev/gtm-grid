/**
 * Seats entitlement domain logic for the Convex cloud (team) tier (T6).
 *
 * Autumn is the single source of truth for entitlement; the ONLY thing gated is
 * `seats` (per-member). There are deliberately NO connector/table caps anywhere.
 *
 * This module is the pure, unit-tested heart of the seats gate. Inviting a
 * member runs {@link SeatsService.checkInvite}: it asks Autumn whether the
 * workspace's customer has a free seat (`check` on the `seats` feature); if so,
 * the caller proceeds to create the membership; if not, the service produces a
 * checkout URL (Autumn `attach` on the team/pro plan) for the upgrade modal
 * instead of adding the member.
 *
 * Like the rest of @gtmgrid/cloud this file has NO Convex import. The one piece
 * of environment it needs — "talk to Autumn" — is abstracted behind the
 * {@link AutumnClient} Effect service. The Convex layer (convex/model/seats.ts)
 * provides it backed by the real `autumn-js` SDK + `AUTUMN_SECRET_KEY`; the
 * tests provide a deterministic in-memory fake. That keeps the gate logic
 * exhaustively testable with zero mocking and no Convex codegen.
 *
 * Follows the canonical Effect pattern (docs/effect-conventions.md, mirrored in
 * membership.ts): typed `Data.TaggedError`s in the error channel, the external
 * dependency as a `Context.Tag` port, the service as an `Effect.Service` with a
 * `.Default` Layer.
 */

import { Context, Data, Effect } from "effect";
import {
  derivePaidPlanId,
  isPaidPlanId,
  PAID_PLAN_IDS,
  type PaidPlanId,
} from "./plans.js";

/**
 * The Autumn feature id for the seat entitlement. The team/pro plan grants a
 * `seats` balance; each member consumes one. Single source of truth for the id.
 */
export const SEATS_FEATURE_ID = "seats" as const;

/**
 * The plan a workspace upgrades to when it runs out of free seats. Used as the
 * Autumn `attach` product id when producing the checkout URL.
 */
export const TEAM_PLAN_ID = "team" as const;

/**
 * Result of {@link SeatsService.checkInvite}.
 *
 * - `allowed: true`  — the workspace has a free seat; the caller proceeds to
 *   create the membership.
 * - `allowed: false` — over the seat limit; `checkoutUrl` is the Autumn billing
 *   URL the UI opens (upgrade modal). The membership is NOT created.
 *
 * A discriminated union so the Convex handler can branch exhaustively without
 * juggling a nullable url on the success path.
 */
export type SeatCheck =
  | {
      readonly allowed: true;
      /**
       * The free-seat balance Autumn reported at check time, or `null` for an
       * unlimited plan / unknown balance. The Convex action turns this into an
       * absolute seat CEILING (current member count + balance) that the
       * membership mutation re-verifies inside its own transaction, so two
       * concurrent invites cannot both pass and exceed the limit.
       */
      readonly balance: number | null;
    }
  | { readonly allowed: false; readonly checkoutUrl: string };

/**
 * Raised when an Autumn API call (check / attach / track) fails — network or
 * transport error, or a malformed response. Carries the underlying cause so the
 * Convex layer can surface it as a `ConvexError` without leaking the SDK type.
 */
export class AutumnError extends Data.TaggedError("AutumnError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The port abstracting Autumn for the seats domain. Only the three operations
 * the gate needs are exposed (NOT the whole SDK), so the fake test Layer is
 * trivial and the domain never imports `autumn-js`.
 *
 * Backed by the real `autumn-js` `Autumn` client in convex/model/seats.ts; by an
 * in-memory fake in seats.test.ts.
 */
export class AutumnClient extends Context.Tag("CloudAutumnClient")<
  AutumnClient,
  {
    /**
     * Does `customerId` have at least `requiredBalance` of the `seats` feature
     * available? Maps to Autumn `check({ customerId, featureId: "seats",
     * requiredBalance })` → `{ allowed }`.
     */
    readonly checkSeats: (args: {
      readonly customerId: string;
      readonly requiredBalance: number;
    }) => Effect.Effect<
      {
        readonly allowed: boolean;
        /**
         * Remaining free seats Autumn reports for the customer (when known).
         * Used to compute a hard seat CEILING the Convex mutation re-checks in
         * its own transaction, closing the check-then-insert race. `null` when
         * the plan grants unlimited seats or Autumn omits a balance.
         */
        readonly balance: number | null;
      },
      AutumnError
    >;

    /**
     * Begin attaching `planId` to `customerId`, returning the checkout/payment
     * URL the customer completes (or `null` when no payment is required). Maps
     * to Autumn `billing.attach({ customerId, planId })` → `{ paymentUrl }`.
     */
    readonly attach: (args: {
      readonly customerId: string;
      readonly planId: string;
    }) => Effect.Effect<{ readonly checkoutUrl: string | null }, AutumnError>;

    /**
     * Record consumption of `value` seats for `customerId` (called after a
     * membership is actually created). Maps to Autumn `track({ customerId,
     * featureId: "seats", value })`.
     */
    readonly trackSeats: (args: {
      readonly customerId: string;
      readonly value: number;
    }) => Effect.Effect<void, AutumnError>;

    /**
     * Read the customer's ACTIVE plan ids — the `planId`s of their active
     * (non-cancelled) recurring subscriptions, used to derive which paid tier the
     * workspace is on for the `me` query / plan badge. Maps to Autumn
     * `customers.get({ customerId })` → the `subscriptions[]` `planId`s whose
     * status is active. Always includes the auto-enabled `free` plan; the caller
     * derives the highest PAID tier via `derivePaidPlanId`.
     *
     * Returns an empty list when the customer has no plans / Autumn omits them.
     * Used by the scheduled flush ACTION (NEVER a query — mutations/queries make
     * no outbound HTTP), so a transport failure surfaces as {@link AutumnError}.
     */
    readonly getActivePlanIds: (args: {
      readonly customerId: string;
    }) => Effect.Effect<readonly string[], AutumnError>;

    /**
     * Record consumption of `value` units of an arbitrary metered feature for
     * `customerId`. Generalises {@link trackSeats} so the cloud-actions meter
     * (C26) can batch-flush its pending count to Autumn under
     * `featureId: "cloud_actions"`. Maps to Autumn
     * `track({ customerId, featureId, value })`.
     *
     * Used by the scheduled flush ACTION (NEVER a mutation — mutations can make
     * no outbound HTTP), so a transport failure surfaces as the typed
     * {@link AutumnError} and the caller can keep the pending count for retry.
     */
    readonly trackUsage: (args: {
      readonly customerId: string;
      readonly featureId: string;
      readonly value: number;
    }) => Effect.Effect<void, AutumnError>;

    /**
     * Read the current usage/limit of a metered feature for `customerId` without
     * consuming any. Lets the cloud-actions flush ACTION snapshot the live
     * `cloud_actions` balance so the `me` query can surface `{ used, limit }`
     * with NO outbound HTTP of its own. Maps to Autumn
     * `check({ customerId, featureId })` → its `balance` (usage / granted /
     * unlimited).
     *
     * `limit` is `null` for an unlimited plan (or when Autumn reports no balance
     * for the feature). `used` defaults to 0 when no balance exists yet.
     */
    readonly checkUsage: (args: {
      readonly customerId: string;
      readonly featureId: string;
    }) => Effect.Effect<
      { readonly used: number; readonly limit: number | null },
      AutumnError
    >;
  }
>() {}

/**
 * Raised when the seat gate would block an invite but Autumn returns no payment
 * URL (e.g. the plan is misconfigured), so there is nothing for the UI to open.
 * Distinct from {@link AutumnError} (a transport failure) — this is a billing
 * config problem surfaced as a typed failure rather than a silent allow.
 */
export class NoCheckoutUrlError extends Data.TaggedError("NoCheckoutUrlError")<{
  readonly message: string;
  readonly customerId: string;
  readonly planId: string;
}> {}

/**
 * Raised when the explicit checkout path is asked to attach a plan id that is
 * not in the paid-plan allow-list ({@link PAID_PLAN_IDS} in plans.ts). Fails
 * closed BEFORE any Autumn call so a forged/unknown plan can never be attached.
 */
export class UnknownPlanError extends Data.TaggedError("UnknownPlanError")<{
  readonly message: string;
  readonly planId: string;
}> {}

/**
 * Raised when adding a member would exceed the workspace's seat ceiling.
 *
 * This is the TRANSACTIONAL guard distinct from {@link checkInvite}'s Autumn
 * pre-check: the Convex membership mutation re-reads the live member count and
 * runs {@link SeatsService.enforceSeatCeiling} inside its own transaction, so
 * two concurrent invites that both passed the (non-transactional) Autumn check
 * cannot both insert and overshoot the limit. The losing invite fails with this.
 */
export class SeatLimitExceededError extends Data.TaggedError(
  "SeatLimitExceededError",
)<{
  readonly message: string;
  readonly currentCount: number;
  readonly ceiling: number;
}> {}

/**
 * Seats entitlement service. The reusable gate the cloud `inviteMember`
 * mutation runs before creating a membership.
 */
export class SeatsService extends Effect.Service<SeatsService>()(
  "SeatsService",
  {
    effect: Effect.gen(function* () {
      const autumn = yield* AutumnClient;

      /**
       * The seat gate for an invite. Checks whether `customerId` has a free
       * seat; if so returns `{ allowed: true }` (caller creates the membership),
       * otherwise attaches the upgrade plan and returns the checkout URL so the
       * UI shows the upgrade modal instead of adding the member.
       *
       * @param customerId the Autumn customer id for the workspace.
       * @param planId the plan to attach when over the limit (defaults to the
       *   team plan).
       */
      const checkInvite = (
        customerId: string,
        planId: string = TEAM_PLAN_ID,
      ): Effect.Effect<SeatCheck, AutumnError | NoCheckoutUrlError> =>
        Effect.gen(function* () {
          // One seat is required to add the prospective member.
          const { allowed, balance } = yield* autumn.checkSeats({
            customerId,
            requiredBalance: 1,
          });
          if (allowed) {
            return { allowed: true, balance } as const;
          }

          // Over the limit: produce the upgrade checkout URL instead of adding.
          const { checkoutUrl } = yield* autumn.attach({ customerId, planId });
          if (checkoutUrl === null) {
            return yield* Effect.fail(
              new NoCheckoutUrlError({
                message:
                  "Seat limit reached but Autumn returned no checkout URL " +
                  `for plan ${planId}.`,
                customerId,
                planId,
              }),
            );
          }
          return { allowed: false, checkoutUrl } as const;
        });

      /**
       * Begin a checkout/upgrade for `customerId` on `planId`, returning the
       * billing URL. Backs the standalone `checkout` Convex action (the upgrade
       * button presents the paid plans and passes the chosen one here).
       *
       * The plan is VALIDATED against the paid-plan allow-list
       * ({@link PAID_PLAN_IDS}) BEFORE any Autumn call: an unknown/forged plan
       * fails closed with {@link UnknownPlanError} and never reaches `attach`.
       * Defaults to the team plan (the entry upsell) when omitted.
       *
       * Fails with {@link NoCheckoutUrlError} when Autumn returns no URL (already
       * on the plan / misconfigured).
       */
      const checkout = (
        customerId: string,
        planId: string = TEAM_PLAN_ID,
      ): Effect.Effect<
        string,
        AutumnError | NoCheckoutUrlError | UnknownPlanError
      > =>
        Effect.gen(function* () {
          if (!isPaidPlanId(planId)) {
            return yield* Effect.fail(
              new UnknownPlanError({
                message:
                  `Unknown plan "${planId}". Choose one of: ` +
                  `${PAID_PLAN_IDS.join(", ")}.`,
                planId,
              }),
            );
          }
          const { checkoutUrl } = yield* autumn.attach({ customerId, planId });
          if (checkoutUrl === null) {
            return yield* Effect.fail(
              new NoCheckoutUrlError({
                message: `Autumn returned no checkout URL for plan ${planId}.`,
                customerId,
                planId,
              }),
            );
          }
          return checkoutUrl;
        });

      /**
       * Record that one seat was consumed (call AFTER the membership is created
       * on the allowed path). Kept separate from {@link checkInvite} so the
       * Convex handler tracks only once the DB write actually succeeded.
       */
      const trackSeatUsed = (
        customerId: string,
      ): Effect.Effect<void, AutumnError> =>
        autumn.trackSeats({ customerId, value: 1 });

      /**
       * The workspace's current PAID plan id, derived from the customer's active
       * Autumn subscriptions, or `null` when on the free tier. Backs the cron's
       * plan sync (convex/model/usage.ts) which caches it on the workspace so the
       * `me` query can surface the plan with NO outbound HTTP. Makes the Autumn
       * `customers.get` call, so it runs from an ACTION only.
       */
      const currentPlan = (
        customerId: string,
      ): Effect.Effect<PaidPlanId | null, AutumnError> =>
        autumn
          .getActivePlanIds({ customerId })
          .pipe(Effect.map(derivePaidPlanId));

      /**
       * Transactional seat guard: assert the LIVE `currentCount` of members is
       * still below `ceiling` before a new member is inserted. Called inside the
       * Convex membership mutation (which re-reads the count in the same
       * transaction) so concurrent invites cannot both pass and exceed the
       * limit. A `null` ceiling means "unlimited" and always allows.
       */
      const enforceSeatCeiling = (
        currentCount: number,
        ceiling: number | null,
      ): Effect.Effect<void, SeatLimitExceededError> => {
        if (ceiling === null || currentCount < ceiling) {
          return Effect.void;
        }
        return Effect.fail(
          new SeatLimitExceededError({
            message:
              `Adding a member would exceed the seat limit ` +
              `(${currentCount}/${ceiling}).`,
            currentCount,
            ceiling,
          }),
        );
      };

      return {
        checkInvite,
        checkout,
        trackSeatUsed,
        currentPlan,
        enforceSeatCeiling,
      } as const;
    }),
    dependencies: [],
  },
) {}
