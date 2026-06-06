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
  SeatLimitExceededError,
  SeatsService,
  UnknownPlanError,
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

  it("returns the billing URL from Autumn attach (defaults to team)", async () => {
    const url = await run(
      checkout(),
      fakeAutumnLayer({ checkoutUrl: "https://billing.example.com/upgrade/1" }),
    );
    expect(url).toBe("https://billing.example.com/upgrade/1");
  });

  it("attaches each valid paid plan id (C27)", async () => {
    for (const planId of ["team", "business", "unlimited"]) {
      const url = await run(
        checkout(planId),
        fakeAutumnLayer({
          checkoutUrl: `https://billing.example.com/${planId}`,
        }),
      );
      expect(url).toBe(`https://billing.example.com/${planId}`);
    }
  });

  it("rejects an unknown plan id with UnknownPlanError before any Autumn call (C27)", async () => {
    const error = await failureOf(
      checkout("enterprise"),
      // attach would succeed if reached; the validation must fail first.
      fakeAutumnLayer({ checkoutUrl: "https://billing.example.com/should-not" }),
    );
    expect(error).toBeInstanceOf(UnknownPlanError);
    if (error instanceof UnknownPlanError) {
      expect(error.planId).toBe("enterprise");
    }
  });

  it("rejects the free plan id (not a paid, purchasable plan) (C27)", async () => {
    const error = await failureOf(checkout("free"), fakeAutumnLayer());
    expect(error).toBeInstanceOf(UnknownPlanError);
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

describe("currentPlan (derive the workspace's paid plan for the badge)", () => {
  const currentPlan = () =>
    Effect.gen(function* () {
      const svc = yield* SeatsService;
      return yield* svc.currentPlan(CUSTOMER);
    });

  it("returns null for a free-tier workspace", async () => {
    const plan = await run(
      currentPlan(),
      fakeAutumnLayer({ activePlanIds: ["free"] }),
    );
    expect(plan).toBeNull();
  });

  it("returns the active paid plan id (highest tier wins)", async () => {
    expect(
      await run(currentPlan(), fakeAutumnLayer({ activePlanIds: ["free", "team"] })),
    ).toBe("team");
    expect(
      await run(
        currentPlan(),
        fakeAutumnLayer({ activePlanIds: ["free", "business"] }),
      ),
    ).toBe("business");
    expect(
      await run(
        currentPlan(),
        fakeAutumnLayer({ activePlanIds: ["free", "team", "unlimited"] }),
      ),
    ).toBe("unlimited");
  });

  it("fails closed with AutumnError when the plan read errors", async () => {
    const error = await failureOf(
      currentPlan(),
      failingAutumnLayer("getActivePlanIds"),
    );
    expect(error).toBeInstanceOf(AutumnError);
  });
});

describe("enforceSeatCeiling (transactional over-seat race guard)", () => {
  // The Autumn client is irrelevant to this pure guard; any fake works.
  const enforce = (currentCount: number, ceiling: number | null) =>
    Effect.gen(function* () {
      const svc = yield* SeatsService;
      return yield* svc.enforceSeatCeiling(currentCount, ceiling);
    });

  it("allows adding a member while under the ceiling", async () => {
    await run(enforce(2, 3), fakeAutumnLayer());
    // No failure → the insert may proceed.
  });

  it("prevents the over-seat race: rejects once the ceiling is reached", async () => {
    // Two concurrent invites both derive ceiling = 3 from a 2-member workspace
    // with 1 free seat. The first insert makes the live count 3; the second
    // mutation re-reads count = 3 and the guard must reject it (would be the 4th
    // member against a 3-seat ceiling), so seats cannot be exceeded.
    const error = await failureOf(enforce(3, 3), fakeAutumnLayer());
    expect(error).toBeInstanceOf(SeatLimitExceededError);
    if (error instanceof SeatLimitExceededError) {
      expect(error.currentCount).toBe(3);
      expect(error.ceiling).toBe(3);
    }
  });

  it("rejects when the live count already exceeds the ceiling", async () => {
    const error = await failureOf(enforce(5, 3), fakeAutumnLayer());
    expect(error).toBeInstanceOf(SeatLimitExceededError);
  });

  it("always allows when the ceiling is null (unlimited plan)", async () => {
    await run(enforce(9999, null), fakeAutumnLayer());
    // No failure → an unlimited plan is never gated.
  });
});

describe("checkInvite surfaces the seat balance for the ceiling", () => {
  it("carries the free-seat balance on the allowed result", async () => {
    const result = await run(
      checkInvite(),
      fakeAutumnLayer({ allowed: true, balance: 4 }),
    );
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.balance).toBe(4);
    }
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
