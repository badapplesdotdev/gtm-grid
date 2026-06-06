/**
 * Onboarding flow — client-side LOGIC (C28).
 *
 * The full-screen cloud onboarding wizard (sign in → sign up → create workspace
 * → invite team → plan → connect AI key → done) has three pieces of logic that
 * are pure, testable, and kept OUT of the React components per the repo
 * convention (docs/effect-conventions.md — React stays React, logic is pure /
 * Effect):
 *
 *   1. {@link nextScreen} / {@link backScreen} — the screen state machine, which
 *      encodes the paid-vs-free routing (a FREE plan skips checkout straight to
 *      "connect"; a PAID plan goes through the plan step's checkout action).
 *   2. {@link resolveCheckoutPlanId} — the (tier, billing) → Autumn plan id
 *      resolution, delegating to the shared `@gtmgrid/cloud` catalog so the id
 *      derivation lives in ONE place (no duplication with the upgrade modal).
 *   3. {@link OnboardingCheckoutService} — the checkout orchestration: resolve the
 *      plan id, then drive the existing C27 {@link CheckoutService} (which calls
 *      the Convex `billing.checkout` action and opens the Autumn/Stripe hosted
 *      checkout URL in the system browser). Free plans short-circuit with no
 *      checkout.
 *
 * The state machine is a plain pure function (no Effect runtime needed); the
 * checkout orchestration is an Effect service so it is unit-tested with a FAKE
 * {@link CheckoutService} layer — no real Convex, no real browser.
 */

import {
  type BillingCycle,
  type PaidPlanId,
  resolvePlanId,
} from "@gtmgrid/cloud";
import { Context, Effect, Layer } from "effect";
import {
  CheckoutError,
  CheckoutService,
  type CheckoutOutcome,
} from "../checkout.js";

/**
 * The onboarding screens, in order. `signin`/`signup` are the auth entry; the
 * four wizard steps are `workspace` → `invite` → `plan` → `connect`; `done` is
 * the handoff. The plan step's "plan" id covers both the free + paid choices —
 * the paid-vs-free branch happens on Continue (see {@link nextScreen}).
 */
export type OnboardingScreen =
  | "signin"
  | "signup"
  | "workspace"
  | "invite"
  | "plan"
  | "connect"
  | "done";

/**
 * The plan tier a user can pick in the onboarding plan step: the free (local)
 * tier OR one of the paid tiers. Distinct from the paid-only {@link PaidPlanId}
 * so "free" is representable in the UI state without it being attachable.
 */
export type SelectablePlan = "free" | PaidPlanId;

/**
 * The screen the plan step advances to on Continue:
 *   - "free"     → skip checkout, go straight to the AI-key step,
 *   - a paid tier → run checkout (the plan id is resolved from tier + billing).
 * A discriminated union so the React layer handles each branch exhaustively.
 */
export type PlanContinue =
  | { readonly kind: "free"; readonly next: "connect" }
  | { readonly kind: "paid"; readonly tier: PaidPlanId };

/**
 * Resolve what happens when the user clicks Continue on the plan step. FREE
 * routes forward with no checkout; a PAID tier signals the caller to run the
 * checkout orchestration. Pure so the paid-vs-free routing is unit-tested.
 */
export function planContinue(plan: SelectablePlan): PlanContinue {
  return plan === "free"
    ? { kind: "free", next: "connect" }
    : { kind: "paid", tier: plan };
}

/**
 * The forward transition for the wizard's "Continue"/primary action. Pure: given
 * the current screen (and, on the plan step, the selected plan) it returns the
 * next screen. The auth screens advance into the wizard; the plan step routes
 * free → connect (paid → connect happens AFTER checkout, so the post-checkout
 * next is also "connect"). `done` is terminal.
 */
export function nextScreen(
  screen: OnboardingScreen,
  plan: SelectablePlan = "free",
): OnboardingScreen {
  switch (screen) {
    case "signin":
    case "signup":
      return "workspace";
    case "workspace":
      return "invite";
    case "invite":
      return "plan";
    case "plan":
      // Free skips checkout; a paid plan ALSO lands on connect once its checkout
      // has been launched (checkout is a side-step, not a screen here).
      return "connect";
    case "connect":
      return "done";
    case "done":
      return "done";
  }
}

/**
 * The backward transition (the wizard's "Back"). Pure mirror of
 * {@link nextScreen}. `signin`/`signup` are entry screens with no back target
 * (they return themselves); the wizard steps walk back one each.
 */
export function backScreen(screen: OnboardingScreen): OnboardingScreen {
  switch (screen) {
    case "signin":
      return "signin";
    case "signup":
      return "signin";
    case "workspace":
      return "signup";
    case "invite":
      return "workspace";
    case "plan":
      return "invite";
    case "connect":
      return "plan";
    case "done":
      return "connect";
  }
}

/**
 * Resolve the concrete Autumn plan id for a PAID tier + billing cycle, used by
 * the checkout action. Thin re-export of the shared catalog's
 * {@link resolvePlanId} so the onboarding flow imports one symbol and the id
 * derivation stays single-sourced.
 */
export function resolveCheckoutPlanId(
  tier: PaidPlanId,
  billing: BillingCycle,
): string {
  return resolvePlanId(tier, billing);
}

/**
 * The outcome of the onboarding plan step's Continue action:
 *   - `free`     → no checkout ran; advance to the AI-key step,
 *   - `checkout` → a paid plan's checkout was launched (the Autumn/Stripe URL was
 *      opened in the system browser); `checkoutUrl` is returned so the UI can
 *      keep a fallback link. The caller advances to the AI-key step too.
 */
export type OnboardingPlanOutcome =
  | { readonly kind: "free" }
  | { readonly kind: "checkout"; readonly checkoutUrl: string };

/** The onboarding plan step's checkout orchestration (a thin C27 wrapper). */
export interface OnboardingCheckoutServiceShape {
  /**
   * Run the plan step's Continue action. For the FREE plan this is a no-op that
   * resolves `{ kind: "free" }` (no Convex, no browser). For a PAID tier it
   * resolves the (tier, billing) → plan id and delegates to the C27
   * {@link CheckoutService} (Convex `billing.checkout` + open the hosted URL),
   * resolving `{ kind: "checkout", checkoutUrl }`. Fails with
   * {@link CheckoutError} on no session / backend / open error.
   */
  readonly continueFromPlan: (
    args: {
      readonly hasSession: boolean;
      readonly workspaceId: string;
      readonly plan: SelectablePlan;
      readonly billing: BillingCycle;
    },
  ) => Effect.Effect<OnboardingPlanOutcome, CheckoutError>;
}

export class OnboardingCheckoutService extends Context.Tag(
  "OnboardingCheckoutService",
)<OnboardingCheckoutService, OnboardingCheckoutServiceShape>() {}

/**
 * Live orchestration: free → succeed with no checkout; paid → resolve the plan
 * id and delegate to the injected {@link CheckoutService}. Requiring the C27
 * service means this reuses the existing checkout path verbatim (no duplicated
 * Convex/browser logic) and is unit-tested against a fake CheckoutService layer.
 */
export const OnboardingCheckoutServiceLive: Layer.Layer<
  OnboardingCheckoutService,
  never,
  CheckoutService
> = Layer.effect(
  OnboardingCheckoutService,
  Effect.gen(function* () {
    const checkout = yield* CheckoutService;
    return {
      continueFromPlan: ({ hasSession, workspaceId, plan, billing }) => {
        const branch = planContinue(plan);
        if (branch.kind === "free") {
          return Effect.succeed<OnboardingPlanOutcome>({ kind: "free" });
        }
        const planId = resolveCheckoutPlanId(branch.tier, billing);
        return checkout
          .startCheckout(hasSession, { workspaceId, planId })
          .pipe(
            Effect.map(
              (outcome: CheckoutOutcome): OnboardingPlanOutcome => ({
                kind: "checkout",
                checkoutUrl: outcome.checkoutUrl,
              }),
            ),
          );
      },
    } satisfies OnboardingCheckoutServiceShape;
  }),
);

/**
 * Convenience: run the plan step's Continue orchestration, returning a Promise so
 * the React glue can `await` it. Accepts the composed Layer so the caller (real
 * Convex/browser) or a test (fakes) chooses the transport.
 */
export function runOnboardingPlanContinue(
  args: {
    readonly hasSession: boolean;
    readonly workspaceId: string;
    readonly plan: SelectablePlan;
    readonly billing: BillingCycle;
  },
  layer: Layer.Layer<OnboardingCheckoutService>,
): Promise<OnboardingPlanOutcome> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* OnboardingCheckoutService;
      return yield* svc.continueFromPlan(args);
    }).pipe(Effect.provide(layer)),
  );
}

/**
 * Derive a URL-safe workspace slug from a display name, for the LIVE
 * `gtmgrid.app/<slug>` preview shown in the create-workspace step. Lowercase,
 * non-alphanumerics → single hyphens, trimmed, capped at 32 chars. Pure +
 * tested so the preview matches what the backend would store.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

/**
 * The live SEAT count for the invite step + plan pricing: the owner (1) plus
 * every invite row with a non-blank value. Pure so the "N seats" affordance and
 * the per-seat totals stay consistent across the wizard.
 */
export function seatCount(invites: readonly { readonly value: string }[]): number {
  return 1 + invites.filter((i) => i.value.trim().length > 0).length;
}
