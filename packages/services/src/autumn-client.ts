/**
 * The LIVE `AutumnClient` Layer for the Postgres/tRPC tier — the injectable
 * Autumn port the billing service depends on.
 *
 * The seat/billing business rules live as PURE Effect services in
 * `@gtmgrid/cloud` (`SeatsService.checkout` / `enforceSeatCeiling`, talking to
 * Autumn through the {@link AutumnClient} port). This module is the seam that
 * backs that port with the real `autumn-js` SDK (constructed from
 * `AUTUMN_SECRET_KEY`), wrapping each SDK call in `Effect.tryPromise` so a
 * rejection becomes the typed {@link AutumnError} (the domain stays fail-closed).
 *
 * It is a direct port of `autumnClientLayer` (convex/model/seats.ts:68): the same
 * `getOrCreate`-then-call shape, the same balance/limit normalisation. The only
 * differences from the Convex seam:
 *   - the secret-missing case surfaces as {@link AutumnError} (the billing
 *     domain's existing channel, mapped to a tRPC error by `runEffect`) rather
 *     than a `ConvexError`, so no extra error type leaks into AppServices, and
 *   - the SDK is built LAZILY + once on first use, so merely composing AppLayer
 *     never touches env/SDK — only resolving a billing procedure does.
 *
 * Tests NEVER construct this — they provide the in-memory `fakeAutumnLayer`
 * (@gtmgrid/cloud) so the billing path runs with no SDK, no env, no HTTP.
 */

import {
  AutumnClient,
  AutumnError,
  type CustomerData,
  MissingSecretError,
  requireSecret,
  SEATS_FEATURE_ID,
} from "@gtmgrid/cloud";
import { Autumn } from "autumn-js";
import { Context, Effect, Layer } from "effect";

/** The service shape behind the {@link AutumnClient} tag. */
type AutumnClientImpl = Context.Tag.Service<AutumnClient>;

/**
 * Build the params for Autumn `customers.getOrCreate` from a customer id plus
 * OPTIONAL profile data. `getOrCreate` UPSERTS by id, so including `name` /
 * `email` backfills them onto an existing customer. A blank value (`undefined`
 * OR `null`) is OMITTED so a missing field never overwrites an existing one with
 * null. Ported verbatim from convex/model/seats.ts:198.
 */
function getOrCreateParams(
  customerId: string,
  customerData?: CustomerData,
): { customerId: string; name?: string; email?: string } {
  const params: { customerId: string; name?: string; email?: string } = {
    customerId,
  };
  const name = customerData?.name;
  if (name !== undefined && name !== null) {
    params.name = name;
  }
  const email = customerData?.email;
  if (email !== undefined && email !== null) {
    params.email = email;
  }
  return params;
}

/** A legible message for an Autumn SDK rejection. */
function autumnMessage(cause: unknown, op: string): string {
  const detail =
    cause instanceof Error ? cause.message : "unknown Autumn error";
  return `Autumn ${op} failed: ${detail}`;
}

/**
 * The {@link AutumnClient} port methods bound to a concrete `autumn-js` client.
 * Each wraps the SDK call in `Effect.tryPromise`, mapping any rejection to the
 * typed {@link AutumnError}. Ported from convex/model/seats.ts:68.
 */
function boundMethods(client: Autumn): AutumnClientImpl {
  return {
    checkSeats: ({ customerId, requiredBalance, customerData }) =>
      Effect.tryPromise({
        try: async () => {
          await client.customers.getOrCreate(
            getOrCreateParams(customerId, customerData),
          );
          const res = await client.check({
            customerId,
            featureId: SEATS_FEATURE_ID,
            requiredBalance,
          });
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
    previewSeatChange: ({ customerId, planId, seats }) =>
      Effect.tryPromise({
        try: async () => {
          // The customer is already on the plan (trial or paid) when inviting, so
          // this is a seat-QUANTITY change → previewUpdate (previewAttach 409s on
          // the same plan). The RECURRING price the user will pay is next cycle's
          // total; `total` is the (often $0 during a trial) immediate proration.
          const res = await client.billing.previewUpdate({
            customerId,
            planId,
            featureQuantities: [{ featureId: SEATS_FEATURE_ID, quantity: seats }],
          });
          const recurring =
            (typeof res.nextCycle?.total === "number"
              ? res.nextCycle.total
              : undefined) ??
            (typeof res.total === "number" ? res.total : 0);
          return { total: recurring, currency: res.currency ?? "usd", seats };
        },
        catch: (cause) =>
          new AutumnError({
            message: autumnMessage(cause, "previewUpdate"),
            cause,
          }),
      }),
    attach: ({ customerId, planId, customerData }) =>
      Effect.tryPromise({
        try: async () => {
          await client.customers.getOrCreate(
            getOrCreateParams(customerId, customerData),
          );
          const res = await client.billing.attach({ customerId, planId });
          return { checkoutUrl: res.paymentUrl ?? null };
        },
        catch: (cause) =>
          new AutumnError({ message: autumnMessage(cause, "attach"), cause }),
      }),
    startTrial: ({ customerId, planId, seats, trialDays, customerData }) =>
      Effect.tryPromise({
        try: async () => {
          await client.customers.getOrCreate(
            getOrCreateParams(customerId, customerData),
          );
          // No-card trial: `customize.freeTrial` starts a `trialDays`-day trial
          // with no payment method (paymentUrl is null). The Team plan's seats are
          // PREPAID, so grant the seat quantity explicitly via featureQuantities —
          // otherwise the trial grants 0 seats and the owner can't invite anyone.
          await client.billing.attach({
            customerId,
            planId,
            customize: {
              freeTrial: {
                durationLength: trialDays,
                durationType: "day",
                cardRequired: false,
              },
            },
            featureQuantities: [{ featureId: SEATS_FEATURE_ID, quantity: seats }],
          });
        },
        catch: (cause) =>
          new AutumnError({
            message: autumnMessage(cause, "startTrial"),
            cause,
          }),
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
    getActivePlanIds: ({ customerId }) =>
      Effect.tryPromise({
        try: async () => {
          const res = await client.customers.get({ customerId });
          const subs = res.subscriptions ?? [];
          // Count TRIALING subscriptions as active: a new signup is on the Team
          // trial (status "trialing"), and we want the plan badge + seat
          // entitlements to reflect Team during the trial, not Free.
          return subs
            .filter((s) => s.status === "active" || s.status === "trialing")
            .map((s) => s.planId);
        },
        catch: (cause) =>
          new AutumnError({
            message: autumnMessage(cause, "customers.get"),
            cause,
          }),
      }),
    getActiveSubscriptions: ({ customerId }) =>
      Effect.tryPromise({
        try: async () => {
          const res = await client.customers.get({ customerId });
          const subs = res.subscriptions ?? [];
          return subs
            .filter((s) => s.status === "active" || s.status === "trialing")
            .map((s) => ({
              planId: s.planId,
              trialEndsAt: s.trialEndsAt ?? null,
            }));
        },
        catch: (cause) =>
          new AutumnError({
            message: autumnMessage(cause, "customers.get"),
            cause,
          }),
      }),
    trackUsage: ({ customerId, featureId, value, customerData }) =>
      Effect.tryPromise({
        try: async () => {
          await client.customers.getOrCreate(
            getOrCreateParams(customerId, customerData),
          );
          await client.track({ customerId, featureId, value });
        },
        catch: (cause) =>
          new AutumnError({ message: autumnMessage(cause, "track"), cause }),
      }),
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
  };
}

/**
 * An {@link AutumnClient} Layer backed by an already-constructed `autumn-js`
 * client. Exposed for callers that build the SDK themselves; production uses
 * {@link AutumnClientLive}, which builds it lazily.
 */
export const autumnClientLayer = (client: Autumn): Layer.Layer<AutumnClient> =>
  Layer.succeed(AutumnClient, boundMethods(client));

/**
 * Construct the real `autumn-js` client from the deployment env. Fails closed
 * with the typed {@link AutumnError} (NOT a raw crash) when the secret is absent,
 * keeping the error inside the billing domain's existing channel. The presence
 * check lives in the pure, unit-tested `requireSecret` (@gtmgrid/cloud).
 */
const buildAutumnSdk = (): Effect.Effect<Autumn, AutumnError> =>
  Effect.try({
    try: () => {
      const secretKey = requireSecret(
        "AUTUMN_SECRET_KEY",
        process.env.AUTUMN_SECRET_KEY,
      );
      return new Autumn({ secretKey });
    },
    catch: (cause) =>
      new AutumnError({
        message:
          cause instanceof MissingSecretError
            ? cause.message
            : "Failed to construct the Autumn client.",
        cause,
      }),
  });

/**
 * The LIVE `AutumnClient` Layer (E = never, so it composes into AppLayer without
 * leaking an error type). The real SDK is built LAZILY and memoized on first use
 * (`Effect.cached`), so merely composing the app Layer never reads the env or
 * constructs the SDK — only resolving a billing procedure does. A missing secret
 * surfaces as {@link AutumnError} in each method's channel.
 */
export const AutumnClientLive: Layer.Layer<AutumnClient> = Layer.effect(
  AutumnClient,
  Effect.gen(function* () {
    // One memoized SDK build (success OR failure) shared by every method call,
    // so the env is read / the SDK constructed at most once, on first use.
    const sdk = yield* Effect.cached(buildAutumnSdk());
    const withClient = <A>(
      use: (methods: AutumnClientImpl) => Effect.Effect<A, AutumnError>,
    ): Effect.Effect<A, AutumnError> =>
      sdk.pipe(Effect.flatMap((client) => use(boundMethods(client))));
    return {
      checkSeats: (args) => withClient((m) => m.checkSeats(args)),
      previewSeatChange: (args) =>
        withClient((m) => m.previewSeatChange(args)),
      attach: (args) => withClient((m) => m.attach(args)),
      startTrial: (args) => withClient((m) => m.startTrial(args)),
      trackSeats: (args) => withClient((m) => m.trackSeats(args)),
      getActivePlanIds: (args) => withClient((m) => m.getActivePlanIds(args)),
      getActiveSubscriptions: (args) =>
        withClient((m) => m.getActiveSubscriptions(args)),
      trackUsage: (args) => withClient((m) => m.trackUsage(args)),
      checkUsage: (args) => withClient((m) => m.checkUsage(args)),
    };
  }),
);
