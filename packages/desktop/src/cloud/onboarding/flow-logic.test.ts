/**
 * Tests for the onboarding flow logic (C28).
 *
 * Outcome-focused per docs/effect-conventions.md: the pure state machine +
 * plan/billing resolution are plain assertions; the checkout orchestration is
 * tested against a FAKE {@link CheckoutService} layer (no real Convex/browser),
 * asserting paid-vs-free routing, plan-id resolution, and the typed-error path.
 */

import { resolvePlanId } from "@gtmgrid/cloud";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  CheckoutError,
  CheckoutService,
  type CheckoutOutcome,
} from "../checkout.js";
import {
  backScreen,
  nextScreen,
  OnboardingCheckoutService,
  OnboardingCheckoutServiceLive,
  planContinue,
  resolveCheckoutPlanId,
  runOnboardingPlanContinue,
  seatCount,
  slugify,
} from "./flow-logic.js";

describe("nextScreen / backScreen (state machine)", () => {
  it("auth screens advance into the wizard at workspace", () => {
    expect(nextScreen("signin")).toBe("workspace");
    expect(nextScreen("signup")).toBe("workspace");
  });

  it("walks the wizard forward workspace → invite → plan → connect → done", () => {
    expect(nextScreen("workspace")).toBe("invite");
    expect(nextScreen("invite")).toBe("plan");
    expect(nextScreen("plan")).toBe("connect");
    expect(nextScreen("connect")).toBe("done");
  });

  it("done is terminal", () => {
    expect(nextScreen("done")).toBe("done");
  });

  it("walks back one step at a time", () => {
    expect(backScreen("connect")).toBe("plan");
    expect(backScreen("plan")).toBe("invite");
    expect(backScreen("invite")).toBe("workspace");
    expect(backScreen("workspace")).toBe("signup");
    expect(backScreen("signup")).toBe("signin");
    expect(backScreen("signin")).toBe("signin");
  });
});

describe("planContinue (paid-vs-free routing)", () => {
  it("routes free straight to connect with no checkout", () => {
    expect(planContinue("free")).toEqual({ kind: "free", next: "connect" });
  });

  it("routes a paid tier to a checkout branch carrying the tier", () => {
    expect(planContinue("team")).toEqual({ kind: "paid", tier: "team" });
    expect(planContinue("business")).toEqual({
      kind: "paid",
      tier: "business",
    });
    expect(planContinue("unlimited")).toEqual({
      kind: "paid",
      tier: "unlimited",
    });
  });
});

describe("resolveCheckoutPlanId (tier + billing → Autumn id)", () => {
  it("matches the shared catalog resolver for every combination", () => {
    for (const tier of ["team", "business", "unlimited"] as const) {
      expect(resolveCheckoutPlanId(tier, "monthly")).toBe(
        resolvePlanId(tier, "monthly"),
      );
      expect(resolveCheckoutPlanId(tier, "annual")).toBe(
        resolvePlanId(tier, "annual"),
      );
    }
  });

  it("produces the annual variant id for annual billing", () => {
    expect(resolveCheckoutPlanId("business", "annual")).toBe("business_annual");
  });
});

describe("slugify + seatCount (live preview helpers)", () => {
  it("derives a url-safe slug from a workspace name", () => {
    expect(slugify("Trigify GTM")).toBe("trigify-gtm");
    expect(slugify("  Acme   Inc!! ")).toBe("acme-inc");
    expect(slugify("a".repeat(40)).length).toBe(32);
  });

  it("counts the owner plus every non-blank invite", () => {
    expect(seatCount([])).toBe(1);
    expect(seatCount([{ value: "" }, { value: "  " }])).toBe(1);
    expect(seatCount([{ value: "a@b.com" }, { value: "" }])).toBe(2);
    expect(seatCount([{ value: "x" }, { value: "y" }])).toBe(3);
  });
});

// ── Checkout orchestration (against a fake CheckoutService) ────────────────────

/** A fake C27 CheckoutService that records the planId it was asked to attach. */
function fakeCheckoutLayer(
  impl: (args: {
    hasSession: boolean;
    workspaceId: string;
    planId: string;
  }) => Effect.Effect<CheckoutOutcome, CheckoutError>,
): Layer.Layer<CheckoutService> {
  return Layer.succeed(CheckoutService, {
    startCheckout: (hasSession, args) =>
      impl({ hasSession, workspaceId: args.workspaceId, planId: args.planId }),
  });
}

const layerWith = (fake: Layer.Layer<CheckoutService>) =>
  OnboardingCheckoutServiceLive.pipe(Layer.provide(fake));

describe("OnboardingCheckoutService.continueFromPlan", () => {
  it("free → no checkout, resolves { kind: free }", async () => {
    let called = false;
    const layer = layerWith(
      fakeCheckoutLayer(() => {
        called = true;
        return Effect.succeed({ checkoutUrl: "x" });
      }),
    );
    const out = await runOnboardingPlanContinue(
      { hasSession: true, workspaceId: "w1", plan: "free", billing: "monthly" },
      layer,
    );
    expect(out).toEqual({ kind: "free" });
    expect(called).toBe(false);
  });

  it("paid monthly → resolves the base plan id and opens checkout", async () => {
    let seenPlanId: string | null = null;
    const layer = layerWith(
      fakeCheckoutLayer(({ planId }) => {
        seenPlanId = planId;
        return Effect.succeed({ checkoutUrl: "https://pay/team" });
      }),
    );
    const out = await runOnboardingPlanContinue(
      { hasSession: true, workspaceId: "w1", plan: "team", billing: "monthly" },
      layer,
    );
    expect(seenPlanId).toBe("team");
    expect(out).toEqual({ kind: "checkout", checkoutUrl: "https://pay/team" });
  });

  it("paid annual → resolves the _annual plan id", async () => {
    let seenPlanId: string | null = null;
    const layer = layerWith(
      fakeCheckoutLayer(({ planId }) => {
        seenPlanId = planId;
        return Effect.succeed({ checkoutUrl: "https://pay/biz-annual" });
      }),
    );
    await runOnboardingPlanContinue(
      {
        hasSession: true,
        workspaceId: "w1",
        plan: "business",
        billing: "annual",
      },
      layer,
    );
    expect(seenPlanId).toBe("business_annual");
  });

  it("propagates a CheckoutError from the underlying service", async () => {
    const layer = layerWith(
      fakeCheckoutLayer(() =>
        Effect.fail(new CheckoutError({ message: "no session" })),
      ),
    );
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* OnboardingCheckoutService;
        return yield* svc.continueFromPlan({
          hasSession: false,
          workspaceId: "w1",
          plan: "team",
          billing: "monthly",
        });
      }).pipe(Effect.provide(layer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(CheckoutError);
      }
    }
  });
});
