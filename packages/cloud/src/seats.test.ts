/**
 * Tests for the seats entitlement gate (checkInvite / checkout / trackSeatUsed).
 *
 * Outcome-focused per docs/effect-conventions.md: we assert the returned
 * {@link SeatCheck} (allowed vs. checkout url) or the typed error `_tag` in the
 * Effect error channel via `Effect.runPromiseExit` + `Cause.failureOption` —
 * never internal calls, never try/catch. The Autumn dependency comes from an
 * in-memory fake `Layer` (no mocks).
 *
 * Covers the acceptance-criteria paths: under-limit allows; over-limit returns
 * a checkout URL instead of adding the member; the standalone checkout action;
 * plus the fail-closed transport-error path and the misconfigured-plan path.
 */

import { Cause, Effect, Exit, type Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  AutumnClient,
  AutumnError,
  NoCheckoutUrlError,
  SeatsService,
} from "./seats.js";
import { failingAutumnLayer, fakeAutumnLayer } from "./seats-test-layers.js";

const CUSTOMER = "ws_customer_alpha";

const run = <A, E>(
  effect: Effect.Effect<A, E, SeatsService>,
  autumn: Layer.Layer<AutumnClient>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SeatsService.Default), Effect.provide(autumn)),
  );

/** Resolve the typed failure of a run, asserting it failed (not died/succeeded). */
const failureOf = async <A, E>(
  effect: Effect.Effect<A, E, SeatsService>,
  autumn: Layer.Layer<AutumnClient>,
): Promise<E> => {
  const exit = await Effect.runPromiseExit(
    effect.pipe(Effect.provide(SeatsService.Default), Effect.provide(autumn)),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.failureOption(exit.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) return failure.value;
  }
  throw new Error("expected a typed failure");
};

const checkInvite = (planId?: string) =>
  Effect.gen(function* () {
    const svc = yield* SeatsService;
    return yield* svc.checkInvite(CUSTOMER, planId);
  });

describe("checkInvite (seat gate on invite)", () => {
  it("allows the invite when under the seat limit", async () => {
    const result = await run(checkInvite(), fakeAutumnLayer({ allowed: true }));
    expect(result.allowed).toBe(true);
    // The allowed branch carries no checkout url.
    expect("checkoutUrl" in result).toBe(false);
  });

  it("returns a checkout URL instead of adding when over the limit", async () => {
    const result = await run(
      checkInvite(),
      fakeAutumnLayer({
        allowed: false,
        checkoutUrl: "https://billing.example.com/checkout/abc",
      }),
    );
    expect(result.allowed).toBe(false);
    if (result.allowed === false) {
      expect(result.checkoutUrl).toBe(
        "https://billing.example.com/checkout/abc",
      );
    }
  });

  it("does NOT record seat usage during the gate (track is separate)", async () => {
    const trackCalls: Array<{ customerId: string; value: number }> = [];
    await run(checkInvite(), fakeAutumnLayer({ allowed: true, trackCalls }));
    // checkInvite must not consume a seat; tracking happens only after the
    // membership write succeeds (trackSeatUsed).
    expect(trackCalls).toHaveLength(0);
  });

  it("fails closed with AutumnError when the seat check errors", async () => {
    const error = await failureOf(checkInvite(), failingAutumnLayer("check"));
    expect(error).toBeInstanceOf(AutumnError);
  });

  it("fails with NoCheckoutUrlError when over the limit but no URL is returned", async () => {
    const error = await failureOf(
      checkInvite(),
      fakeAutumnLayer({ allowed: false, checkoutUrl: null }),
    );
    expect(error).toBeInstanceOf(NoCheckoutUrlError);
    if (error instanceof NoCheckoutUrlError) {
      expect(error.customerId).toBe(CUSTOMER);
    }
  });

  it("propagates an AutumnError if attach fails on the over-limit path", async () => {
    const error = await failureOf(checkInvite(), failingAutumnLayer("attach"));
    expect(error).toBeInstanceOf(AutumnError);
  });
});

describe("checkout (standalone upgrade action)", () => {
  const checkout = (planId?: string) =>
    Effect.gen(function* () {
      const svc = yield* SeatsService;
      return yield* svc.checkout(CUSTOMER, planId);
    });

  it("returns the billing URL from Autumn attach", async () => {
    const url = await run(
      checkout(),
      fakeAutumnLayer({ checkoutUrl: "https://billing.example.com/upgrade/1" }),
    );
    expect(url).toBe("https://billing.example.com/upgrade/1");
  });

  it("fails with NoCheckoutUrlError when Autumn returns no URL", async () => {
    const error = await failureOf(
      checkout(),
      fakeAutumnLayer({ checkoutUrl: null }),
    );
    expect(error).toBeInstanceOf(NoCheckoutUrlError);
  });

  it("propagates an AutumnError when attach fails", async () => {
    const error = await failureOf(checkout(), failingAutumnLayer("attach"));
    expect(error).toBeInstanceOf(AutumnError);
  });
});

describe("trackSeatUsed (record consumption after membership)", () => {
  it("records exactly one seat for the customer", async () => {
    const trackCalls: Array<{ customerId: string; value: number }> = [];
    await run(
      Effect.gen(function* () {
        const svc = yield* SeatsService;
        return yield* svc.trackSeatUsed(CUSTOMER);
      }),
      fakeAutumnLayer({ trackCalls }),
    );
    expect(trackCalls).toEqual([{ customerId: CUSTOMER, value: 1 }]);
  });

  it("fails with AutumnError when the track call errors", async () => {
    const error = await failureOf(
      Effect.gen(function* () {
        const svc = yield* SeatsService;
        return yield* svc.trackSeatUsed(CUSTOMER);
      }),
      failingAutumnLayer("track"),
    );
    expect(error).toBeInstanceOf(AutumnError);
  });
});
