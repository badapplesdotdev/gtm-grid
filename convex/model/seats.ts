/**
 * Convex ↔ Effect bridge for the seats entitlement gate (T6).
 *
 * The seat-gate business rules live as a PURE Effect service in `@gtmgrid/cloud`
 * (packages/cloud/src/seats.ts): `SeatsService.checkInvite` / `checkout` /
 * `trackSeatUsed`, talking to Autumn through the `AutumnClient` port. This file
 * is the seam that:
 *
 *   1. builds an {@link AutumnClient} Layer backed by the REAL `autumn-js` SDK
 *      (constructed from `AUTUMN_SECRET_KEY` in the Convex deployment env), and
 *   2. runs the service via `Effect.runPromiseExit`, translating its typed error
 *      channel into a `ConvexError` the client can read.
 *
 * Autumn is the single source of truth for entitlement; the only gate is
 * `seats`. There are NO connector/table caps anywhere.
 *
 * These calls make outbound HTTP to Autumn, so they run from Convex ACTIONS
 * (convex/workspaces.ts `inviteMember` action, convex/billing.ts `checkout`),
 * never from queries/mutations. Mirrors the pattern in convex/model/auth.ts:
 * pure rules in @gtmgrid/cloud, ctx/SDK wiring here.
 */

import {
  AutumnClient,
  AutumnError,
  CLOUD_ACTIONS_FEATURE_ID,
  MissingSecretError,
  requireSecret,
  type SeatCheck,
  SeatLimitExceededError,
  SeatsService,
  SEATS_FEATURE_ID,
} from "@gtmgrid/cloud";
import { Autumn } from "autumn-js";
import { ConvexError } from "convex/values";
import { Cause, Effect, Exit, Layer, Option } from "effect";

/**
 * Build the real `autumn-js` client from the deployment env. Throws a
 * `ConvexError` (not a raw crash) when the secret is missing so the failure is
 * legible at the Convex boundary.
 */
export function autumnSdk(): Autumn {
  try {
    // Presence check lives in the pure, unit-tested `requireSecret`
    // (@gtmgrid/cloud); a missing key fails closed before the SDK is built.
    const secretKey = requireSecret(
      "AUTUMN_SECRET_KEY",
      process.env.AUTUMN_SECRET_KEY,
    );
    return new Autumn({ secretKey });
  } catch (cause) {
    if (cause instanceof MissingSecretError) {
      throw new ConvexError({ code: "AutumnConfigError", message: cause.message });
    }
    throw cause;
  }
}

/**
 * An {@link AutumnClient} Layer backed by the real `autumn-js` SDK. Each port
 * method wraps the SDK call in `Effect.tryPromise`, mapping any rejection to the
 * typed {@link AutumnError} (so the domain stays fail-closed). Maps:
 *   - `checkSeats` → `client.check({ featureId: "seats", requiredBalance })`,
 *   - `attach`     → `client.billing.attach({ planId })` → `paymentUrl`,
 *   - `trackSeats` → `client.track({ featureId: "seats", value })`.
 */
export const autumnClientLayer = (
  client: Autumn,
): Layer.Layer<AutumnClient> =>
  Layer.succeed(AutumnClient, {
    checkSeats: ({ customerId, requiredBalance }) =>
      Effect.tryPromise({
        try: async () => {
          // Idempotent get-or-create so a brand-new workspace exists as an
          // Autumn customer before its first check (keyed on our external id).
          await client.customers.getOrCreate({ customerId });
          const res = await client.check({
            customerId,
            featureId: SEATS_FEATURE_ID,
            requiredBalance,
          });
          // Surface the remaining-seat balance (when Autumn reports a finite,
          // non-unlimited number) so the caller can derive a transactional seat
          // ceiling; an unlimited / absent balance maps to null ("no ceiling").
          const bal = res.balance;
          const balance =
            bal !== null &&
            bal.unlimited !== true &&
            typeof bal.remaining === "number"
              ? bal.remaining
              : null;
          return { allowed: res.allowed === true, balance };
        },
        catch: (cause) =>
          new AutumnError({ message: autumnMessage(cause, "check"), cause }),
      }),
    attach: ({ customerId, planId }) =>
      Effect.tryPromise({
        try: async () => {
          // Autumn `attach` does not auto-create the customer, and a workspace
          // that skipped the seat check/track (e.g. skipped invite) won't exist
          // as an Autumn customer yet. Idempotent get-or-create first.
          await client.customers.getOrCreate({ customerId });
          const res = await client.billing.attach({ customerId, planId });
          return { checkoutUrl: res.paymentUrl ?? null };
        },
        catch: (cause) =>
          new AutumnError({ message: autumnMessage(cause, "attach"), cause }),
      }),
    trackSeats: ({ customerId, value }) =>
      Effect.tryPromise({
        try: async () => {
          await client.track({
            customerId,
            featureId: SEATS_FEATURE_ID,
            value,
          });
        },
        catch: (cause) =>
          new AutumnError({ message: autumnMessage(cause, "track"), cause }),
      }),
    // Read the customer's active subscription plan ids (C27) so the cron can
    // derive + cache which paid tier the workspace is on for the `me` query.
    // Maps to `customers.get({ customerId })` → `subscriptions[]` planIds whose
    // status is "active" (a cancelled/expired sub no longer grants the plan).
    getActivePlanIds: ({ customerId }) =>
      Effect.tryPromise({
        try: async () => {
          const res = await client.customers.get({ customerId });
          const subs = res.subscriptions ?? [];
          return subs
            .filter((s) => s.status === "active")
            .map((s) => s.planId);
        },
        catch: (cause) =>
          new AutumnError({ message: autumnMessage(cause, "customers.get"), cause }),
      }),
    // Generic metered-usage track for the cloud-actions meter (C26): flushes a
    // workspace's pending count under an arbitrary featureId.
    trackUsage: ({ customerId, featureId, value }) =>
      Effect.tryPromise({
        try: async () => {
          await client.track({ customerId, featureId, value });
        },
        catch: (cause) =>
          new AutumnError({ message: autumnMessage(cause, "track"), cause }),
      }),
    // Read a metered feature's live usage/limit without consuming any, so the
    // flush ACTION can snapshot `cloud_actions` for the `me` query (no HTTP from
    // the query itself). `granted` is the plan cap; `unlimited` maps `limit` to
    // null; `usage` is consumed units. A missing balance reads as 0 used.
    checkUsage: ({ customerId, featureId }) =>
      Effect.tryPromise({
        try: async () => {
          const res = await client.check({ customerId, featureId });
          const bal = res.balance;
          if (bal === null) {
            return { used: 0, limit: null };
          }
          const used = typeof bal.usage === "number" ? bal.usage : 0;
          const limit =
            bal.unlimited === true || typeof bal.granted !== "number"
              ? null
              : bal.granted;
          return { used, limit };
        },
        catch: (cause) =>
          new AutumnError({ message: autumnMessage(cause, "check"), cause }),
      }),
  });

/** A legible message for an Autumn SDK rejection. */
function autumnMessage(cause: unknown, op: string): string {
  const detail =
    cause instanceof Error ? cause.message : "unknown Autumn error";
  return `Autumn ${op} failed: ${detail}`;
}

/** The composed Layer: SeatsService provided with the real AutumnClient. */
const seatsLayer = (client: Autumn): Layer.Layer<SeatsService> =>
  SeatsService.Default.pipe(Layer.provide(autumnClientLayer(client)));

/**
 * Run a `SeatsService` program against the real Autumn client, translating a
 * typed failure (`AutumnError` / `NoCheckoutUrlError`) into a `ConvexError` the
 * client can read. A defect (non-typed crash) is rethrown for Convex to log.
 */
async function runSeats<A>(
  program: Effect.Effect<A, unknown, SeatsService>,
): Promise<A> {
  const client = autumnSdk();
  const exit = await Effect.runPromiseExit(
    program.pipe(Effect.provide(seatsLayer(client))),
  );
  if (Exit.isSuccess(exit)) return exit.value;

  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) {
    const err = failure.value as { _tag?: string; message?: string };
    throw new ConvexError({
      code: err._tag ?? "AutumnError",
      message: err.message ?? "Billing check failed.",
    });
  }
  throw new Error(Cause.pretty(exit.cause));
}

/**
 * The seat gate for an invite: returns `{ allowed: true }` when the workspace
 * has a free seat, or `{ allowed: false, checkoutUrl }` when over the limit.
 * Called by the `inviteMember` action (convex/workspaces.ts) BEFORE it asks the
 * mutation to create the membership. `customerId` is the workspace id (the
 * Autumn customer is the workspace).
 */
export function checkInviteSeat(
  customerId: string,
  planId?: string,
): Promise<SeatCheck> {
  return runSeats(
    Effect.gen(function* () {
      const svc = yield* SeatsService;
      return yield* svc.checkInvite(customerId, planId);
    }),
  );
}

/**
 * Record that one seat was consumed — called AFTER the membership row is created
 * on the allowed path, so usage only counts real members.
 */
export function trackSeatUsed(customerId: string): Promise<void> {
  return runSeats(
    Effect.gen(function* () {
      const svc = yield* SeatsService;
      return yield* svc.trackSeatUsed(customerId);
    }),
  );
}

/**
 * A {@link SeatsService} layer with a stub {@link AutumnClient} that is NEVER
 * called — used to run the PURE `enforceSeatCeiling` guard inside a Convex
 * MUTATION (which cannot make Autumn's outbound HTTP). Constructing the real SDK
 * is skipped so this works in the query/mutation runtime with no env.
 */
const pureSeatsLayer: Layer.Layer<SeatsService> = SeatsService.Default.pipe(
  Layer.provide(
    Layer.succeed(AutumnClient, {
      checkSeats: () =>
        Effect.die("AutumnClient.checkSeats must not be called in a mutation"),
      attach: () =>
        Effect.die("AutumnClient.attach must not be called in a mutation"),
      trackSeats: () =>
        Effect.die("AutumnClient.trackSeats must not be called in a mutation"),
      getActivePlanIds: () =>
        Effect.die(
          "AutumnClient.getActivePlanIds must not be called in a mutation",
        ),
      trackUsage: () =>
        Effect.die("AutumnClient.trackUsage must not be called in a mutation"),
      checkUsage: () =>
        Effect.die("AutumnClient.checkUsage must not be called in a mutation"),
    }),
  ),
);

/**
 * Transactional seat guard for the membership mutation. Re-checks the LIVE
 * `currentCount` against `ceiling` (the absolute seat cap the invite action
 * derived from Autumn) INSIDE the mutation transaction, so two concurrent
 * invites cannot both pass and exceed the limit. Throws a
 * `ConvexError({ code: "SeatLimitExceededError" })` when the cap is reached; a
 * `null` ceiling means unlimited. Pure: no Autumn call, so it runs in the
 * mutation runtime.
 */
export async function enforceSeatCeiling(
  currentCount: number,
  ceiling: number | null,
): Promise<void> {
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const svc = yield* SeatsService;
      return yield* svc.enforceSeatCeiling(currentCount, ceiling);
    }).pipe(Effect.provide(pureSeatsLayer)),
  );
  if (Exit.isSuccess(exit)) return;

  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure) && failure.value instanceof SeatLimitExceededError) {
    throw new ConvexError({
      code: failure.value._tag,
      message: failure.value.message,
    });
  }
  throw new Error(Cause.pretty(exit.cause));
}

/**
 * Begin a checkout/upgrade for the workspace, returning the Autumn billing URL.
 * Backs the standalone `checkout` action (convex/billing.ts).
 */
export function startCheckout(
  customerId: string,
  planId?: string,
): Promise<string> {
  return runSeats(
    Effect.gen(function* () {
      const svc = yield* SeatsService;
      return yield* svc.checkout(customerId, planId);
    }),
  );
}
