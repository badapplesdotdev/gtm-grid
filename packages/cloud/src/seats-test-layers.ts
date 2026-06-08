/**
 * Deterministic test `Layer`s for the seats gate ({@link AutumnClient}).
 *
 * Per the Effect test conventions (docs/effect-conventions.md) the Autumn
 * dependency is substituted with a real, in-memory `Layer` — a fake client —
 * rather than a mocking framework. The fake mirrors exactly what the Convex
 * layer (convex/model/seats.ts) provides from the real `autumn-js` SDK: a
 * `checkSeats` that answers allowed/denied, an `attach` that yields a checkout
 * URL, and a `trackSeats` that records usage. Tests assert OUTCOMES (the
 * returned {@link SeatCheck} / typed error), so the fake just returns the
 * configured answers.
 */

import { Effect, Layer } from "effect";
import { AutumnClient, AutumnError, type CustomerData } from "./seats.js";

/**
 * Configuration for the fake Autumn client. Every field has a sensible default
 * so a test only specifies the dimension it exercises.
 */
export interface FakeAutumnConfig {
  /** Whether `checkSeats` reports a free seat (default: under the limit). */
  readonly allowed?: boolean;
  /**
   * The free-seat balance `checkSeats` reports (default: `null` = unlimited /
   * unknown). Drives the transactional seat-ceiling guard.
   */
  readonly balance?: number | null;
  /** The URL `attach` returns; `null` models a misconfigured plan. */
  readonly checkoutUrl?: string | null;
  /** Records each `trackSeats` call (consumed-seat audit) for assertions. */
  readonly trackCalls?: Array<{ customerId: string; value: number }>;
  /**
   * Records each `trackUsage` call (cloud-actions flush audit) for assertions.
   * Captures the feature id too so a test can assert it tracked `cloud_actions`.
   */
  readonly usageCalls?: Array<{
    customerId: string;
    featureId: string;
    value: number;
    customerData?: CustomerData;
  }>;
  /**
   * Records the customer profile data forwarded on each customer-materialising
   * call (`checkSeats`, `attach`, `trackUsage`), so a test can assert the
   * workspace name + owner email reach the seam that calls `getOrCreate`.
   */
  readonly customerDataCalls?: Array<{
    customerId: string;
    op: "checkSeats" | "attach" | "trackUsage" | "startTrial";
    customerData?: CustomerData;
  }>;
  /** Records each `startTrial` call (new-signup trial enrolment) for assertions. */
  readonly trialCalls?: Array<{
    customerId: string;
    planId: string;
    seats: number;
    trialDays: number;
    customerData?: CustomerData;
  }>;
  /**
   * The live usage `checkUsage` reports for ANY feature (default: 0 used /
   * unlimited). Drives the snapshot the cloud-actions flush stores for `me`.
   */
  readonly usage?: { used: number; limit: number | null };
  /**
   * The active plan ids `getActivePlanIds` reports (default: `["free"]` — the
   * auto-enabled free tier). Drives the plan the cron caches for the `me` query.
   */
  readonly activePlanIds?: readonly string[];
  /** The `trialEndsAt` (epoch ms) `getActiveSubscriptions` reports; default null. */
  readonly trialEndsAt?: number | null;
  /** Per-seat price `previewSeatChange` multiplies by the seat count; default 20. */
  readonly perSeatPrice?: number;
}

/**
 * A fake {@link AutumnClient} Layer driven by {@link FakeAutumnConfig}. The
 * happy ("under-limit") path: `allowed: true`. The over-limit path:
 * `allowed: false` plus a `checkoutUrl`.
 */
export const fakeAutumnLayer = (
  config: FakeAutumnConfig = {},
): Layer.Layer<AutumnClient> => {
  const allowed = config.allowed ?? true;
  const balance = config.balance ?? null;
  const checkoutUrl =
    config.checkoutUrl === undefined
      ? "https://billing.example.com/checkout/test"
      : config.checkoutUrl;
  const usage = config.usage ?? { used: 0, limit: null };
  const activePlanIds = config.activePlanIds ?? ["free"];
  return Layer.succeed(AutumnClient, {
    checkSeats: ({ customerId, customerData }) =>
      Effect.sync(() => {
        config.customerDataCalls?.push({
          customerId,
          op: "checkSeats",
          customerData,
        });
        return { allowed, balance };
      }),
    previewSeatChange: ({ seats }) =>
      Effect.succeed({
        total: seats * (config.perSeatPrice ?? 20),
        currency: "usd",
        seats,
      }),
    attach: ({ customerId, customerData }) =>
      Effect.sync(() => {
        config.customerDataCalls?.push({
          customerId,
          op: "attach",
          customerData,
        });
        return { checkoutUrl };
      }),
    setupPayment: () => Effect.succeed({ checkoutUrl }),
    startTrial: ({ customerId, planId, seats, trialDays, customerData }) =>
      Effect.sync(() => {
        config.trialCalls?.push({
          customerId,
          planId,
          seats,
          trialDays,
          customerData,
        });
        config.customerDataCalls?.push({
          customerId,
          op: "startTrial",
          customerData,
        });
      }),
    trackSeats: ({ customerId, value }) =>
      Effect.sync(() => {
        config.trackCalls?.push({ customerId, value });
      }),
    getActivePlanIds: () => Effect.succeed(activePlanIds),
    getActiveSubscriptions: () =>
      Effect.succeed(
        activePlanIds.map((planId) => ({
          planId,
          trialEndsAt: config.trialEndsAt ?? null,
        })),
      ),
    trackUsage: ({ customerId, featureId, value, customerData }) =>
      Effect.sync(() => {
        config.usageCalls?.push({ customerId, featureId, value, customerData });
        config.customerDataCalls?.push({
          customerId,
          op: "trackUsage",
          customerData,
        });
      }),
    checkUsage: () => Effect.succeed(usage),
  });
};

/**
 * A fake {@link AutumnClient} whose chosen operation always fails with
 * {@link AutumnError} — used to assert that Autumn transport failures surface as
 * the typed error rather than silently allowing (fail-closed) the invite.
 */
export const failingAutumnLayer = (
  failOn:
    | "check"
    | "attach"
    | "startTrial"
    | "track"
    | "trackUsage"
    | "checkUsage"
    | "getActivePlanIds",
  message = "autumn unavailable",
): Layer.Layer<AutumnClient> => {
  const fail = Effect.fail(new AutumnError({ message }));
  return Layer.succeed(AutumnClient, {
    // When the FAILURE under test is `attach`, the seat check must DENY so the
    // over-limit path that calls `attach` is actually reached; otherwise the
    // check passes (only the named op fails).
    checkSeats: () =>
      failOn === "check"
        ? fail
        : Effect.succeed({ allowed: failOn !== "attach", balance: null }),
    previewSeatChange: ({ seats }) =>
      Effect.succeed({ total: seats * 20, currency: "usd", seats }),
    attach: () =>
      failOn === "attach"
        ? fail
        : Effect.succeed({ checkoutUrl: "https://billing.example.com/x" }),
    setupPayment: () =>
      Effect.succeed({ checkoutUrl: "https://billing.example.com/setup" }),
    startTrial: () => (failOn === "startTrial" ? fail : Effect.void),
    trackSeats: () => (failOn === "track" ? fail : Effect.void),
    getActivePlanIds: () =>
      failOn === "getActivePlanIds" ? fail : Effect.succeed(["free"]),
    getActiveSubscriptions: () =>
      failOn === "getActivePlanIds"
        ? fail
        : Effect.succeed([{ planId: "free", trialEndsAt: null }]),
    trackUsage: () => (failOn === "trackUsage" ? fail : Effect.void),
    // Default to a benign snapshot so a `trackUsage` failure can be exercised
    // without the (sequenced) `checkUsage` also being the thing that fails.
    checkUsage: () =>
      failOn === "checkUsage"
        ? fail
        : Effect.succeed({ used: 0, limit: null }),
  });
};
