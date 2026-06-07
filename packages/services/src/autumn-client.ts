/**
 * `AutumnClientLive` — the real `autumn-js`-backed {@link AutumnClient} Layer for
 * the Postgres/tRPC cloud tier.
 *
 * `AutumnClient` (@gtmgrid/cloud) is the PORT abstracting Autumn for the seats
 * gate; the seat-gate rules are the pure {@link SeatsService}. This module is the
 * production seam — the direct port of the Convex `autumnClientLayer`
 * (convex/model/seats.ts:68) — building the SDK from `AUTUMN_SECRET_KEY` and
 * wrapping each call in `Effect.tryPromise` so a rejection becomes the typed
 * {@link AutumnError} (the domain stays fail-closed). Tests never use this; they
 * provide the in-memory `fakeAutumnLayer` (@gtmgrid/cloud) instead, so the seat
 * check is exercised with no live database AND no Autumn HTTP.
 *
 * Only the methods the invitation flow needs (`checkSeats`, `attach`,
 * `trackSeats`) talk to Autumn meaningfully; the metering methods
 * (`getActivePlanIds`, `trackUsage`, `checkUsage`) are ported too so the Layer
 * satisfies the full port, but they are not on the invitation paths.
 */

import {
  AutumnClient,
  AutumnError,
  type CustomerData,
  requireSecret,
  SEATS_FEATURE_ID,
} from "@gtmgrid/cloud";
import { Autumn } from "autumn-js";
import { Effect, Layer } from "effect";

/**
 * Build params for Autumn `customers.getOrCreate` — UPSERTS by id, so passing
 * `name`/`email` backfills an existing customer. A blank value is OMITTED
 * (`undefined` only, never `null`) so a missing field never nulls an existing
 * one. Ported from convex/model/seats.ts:198.
 */
function getOrCreateParams(
  customerId: string,
  customerData?: CustomerData,
): { customerId: string; name?: string; email?: string } {
  const params: { customerId: string; name?: string; email?: string } = {
    customerId,
  };
  const name = customerData?.name;
  if (name !== undefined && name !== null) params.name = name;
  const email = customerData?.email;
  if (email !== undefined && email !== null) params.email = email;
  return params;
}

/** A legible message for an Autumn SDK rejection. */
function autumnMessage(cause: unknown, op: string): string {
  const detail =
    cause instanceof Error ? cause.message : "unknown Autumn error";
  return `Autumn ${op} failed: ${detail}`;
}

/** Build the real `autumn-js` client; fails closed if the secret is missing. */
function autumnSdk(): Autumn {
  const secretKey = requireSecret(
    "AUTUMN_SECRET_KEY",
    process.env.AUTUMN_SECRET_KEY,
  );
  return new Autumn({ secretKey });
}

/** An {@link AutumnClient} Layer backed by a given `autumn-js` client. */
export const autumnClientLayer = (client: Autumn): Layer.Layer<AutumnClient> =>
  Layer.succeed(AutumnClient, {
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
          return subs.filter((s) => s.status === "active").map((s) => s.planId);
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
          if (bal === null) return { used: 0, limit: null };
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

/**
 * The live {@link AutumnClient} Layer — builds the `autumn-js` SDK from the
 * deployment env lazily (the client is constructed only when the Layer is built,
 * i.e. on a real request that needs a seat check).
 */
export const AutumnClientLive: Layer.Layer<AutumnClient> = Layer.unwrapEffect(
  Effect.sync(() => autumnClientLayer(autumnSdk())),
);
