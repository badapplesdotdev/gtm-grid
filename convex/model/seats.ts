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
  type SeatCheck,
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
function autumnSdk(): Autumn {
  const secretKey = process.env.AUTUMN_SECRET_KEY;
  if (secretKey === undefined || secretKey === "") {
    throw new ConvexError({
      code: "AutumnConfigError",
      message: "AUTUMN_SECRET_KEY is not set on the Convex deployment.",
    });
  }
  return new Autumn({ secretKey });
}

/**
 * An {@link AutumnClient} Layer backed by the real `autumn-js` SDK. Each port
 * method wraps the SDK call in `Effect.tryPromise`, mapping any rejection to the
 * typed {@link AutumnError} (so the domain stays fail-closed). Maps:
 *   - `checkSeats` → `client.check({ featureId: "seats", requiredBalance })`,
 *   - `attach`     → `client.billing.attach({ planId })` → `paymentUrl`,
 *   - `trackSeats` → `client.track({ featureId: "seats", value })`.
 */
const autumnClientLayer = (client: Autumn): Layer.Layer<AutumnClient> =>
  Layer.succeed(AutumnClient, {
    checkSeats: ({ customerId, requiredBalance }) =>
      Effect.tryPromise({
        try: async () => {
          const res = await client.check({
            customerId,
            featureId: SEATS_FEATURE_ID,
            requiredBalance,
          });
          return { allowed: res.allowed === true };
        },
        catch: (cause) =>
          new AutumnError({ message: autumnMessage(cause, "check"), cause }),
      }),
    attach: ({ customerId, planId }) =>
      Effect.tryPromise({
        try: async () => {
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
