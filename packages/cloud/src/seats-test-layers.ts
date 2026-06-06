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
import { AutumnClient, AutumnError } from "./seats.js";

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
  }>;
  /**
   * The live usage `checkUsage` reports for ANY feature (default: 0 used /
   * unlimited). Drives the snapshot the cloud-actions flush stores for `me`.
   */
  readonly usage?: { used: number; limit: number | null };
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
  return Layer.succeed(AutumnClient, {
    checkSeats: () => Effect.succeed({ allowed, balance }),
    attach: () => Effect.succeed({ checkoutUrl }),
    trackSeats: ({ customerId, value }) =>
      Effect.sync(() => {
        config.trackCalls?.push({ customerId, value });
      }),
    trackUsage: ({ customerId, featureId, value }) =>
      Effect.sync(() => {
        config.usageCalls?.push({ customerId, featureId, value });
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
  failOn: "check" | "attach" | "track" | "trackUsage" | "checkUsage",
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
    attach: () =>
      failOn === "attach"
        ? fail
        : Effect.succeed({ checkoutUrl: "https://billing.example.com/x" }),
    trackSeats: () => (failOn === "track" ? fail : Effect.void),
    trackUsage: () => (failOn === "trackUsage" ? fail : Effect.void),
    // Default to a benign snapshot so a `trackUsage` failure can be exercised
    // without the (sequenced) `checkUsage` also being the thing that fails.
    checkUsage: () =>
      failOn === "checkUsage"
        ? fail
        : Effect.succeed({ used: 0, limit: null }),
  });
};
