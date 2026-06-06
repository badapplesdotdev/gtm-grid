/**
 * Plan-selection upgrade orchestration (C27) — client-side LOGIC as an Effect
 * service, mirroring ./invite.ts.
 *
 * The upgrade modal presents the paid plans (team / business / unlimited) from
 * the shared `PLAN_CATALOG` (@gtmgrid/cloud) and, when the user picks one, calls
 * the Convex `billing.checkout` ACTION with that planId and opens the returned
 * Autumn URL in the SYSTEM browser. This service owns that flow:
 *
 *   1. validate there is a signed-in session (typed error otherwise),
 *   2. validate the chosen plan id against the paid-plan allow-list
 *      ({@link isPaidPlanId}) BEFORE the backend call (defence in depth — the
 *      Convex action re-validates server-side),
 *   3. delegate to the injected {@link CheckoutRunner} (the Convex action call),
 *   4. open the returned checkout URL via the injected {@link UrlOpener} (the
 *      SYSTEM browser) and report it so the UI can show its modal.
 *
 * Per the repo convention React components stay plain React; this orchestration
 * is an Effect service with typed errors + Layers so it is unit-tested by
 * providing FAKE `CheckoutRunner` / `UrlOpener` Layers — no real Convex, no real
 * browser. The thin React glue lives in WorkspaceSettings.tsx. The `UrlOpener`
 * port is shared with ./invite.ts so both flows open URLs the same way.
 */

import { isPaidPlanId } from "@gtmgrid/cloud";
import { Context, Data, Effect, Layer } from "effect";
import { UrlOpener } from "./invite.js";

/**
 * The Convex `billing.checkout` action result, mirrored from convex/billing.ts:
 * the Autumn hosted-billing URL to open.
 */
export interface CheckoutActionResult {
  readonly checkoutUrl: string;
}

/** The outcome the UI acts on: the checkout URL (already opened in the browser). */
export interface CheckoutOutcome {
  readonly checkoutUrl: string;
}

/** Raised when checkout cannot proceed (no session, bad plan, or backend error). */
export class CheckoutError extends Data.TaggedError("CheckoutError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Port: performs the Convex `billing.checkout` action for a workspace + plan.
 * Abstracted behind a tag so the orchestration is testable without a real Convex
 * client. The Live Layer is built in WorkspaceSettings.tsx from the `useAction`
 * hook (React-bound), so no default Layer lives here.
 */
export interface CheckoutRunnerShape {
  readonly checkout: (args: {
    readonly workspaceId: string;
    readonly planId: string;
  }) => Effect.Effect<CheckoutActionResult, CheckoutError>;
}

export class CheckoutRunner extends Context.Tag("CheckoutRunner")<
  CheckoutRunner,
  CheckoutRunnerShape
>() {}

/** The checkout orchestration the UI calls. */
export interface CheckoutServiceShape {
  /**
   * Start a plan upgrade. Fails with {@link CheckoutError} when there is no
   * signed-in session, the plan id is unknown, or the backend call fails. On
   * success it opens the checkout URL in the system browser before resolving.
   */
  readonly startCheckout: (
    hasSession: boolean,
    args: { readonly workspaceId: string; readonly planId: string },
  ) => Effect.Effect<CheckoutOutcome, CheckoutError>;
}

export class CheckoutService extends Context.Tag("CheckoutService")<
  CheckoutService,
  CheckoutServiceShape
>() {}

/**
 * The orchestration: guard on a session + a valid plan, delegate to
 * {@link CheckoutRunner}, then open the URL via {@link UrlOpener}. Requiring both
 * ports means the same service runs against real Convex/browser (Live) or fakes
 * (tests). The {@link UrlOpener} comes from ./invite.ts (shared opener).
 */
export const CheckoutServiceLive: Layer.Layer<
  CheckoutService,
  never,
  CheckoutRunner | UrlOpener
> = Layer.effect(
  CheckoutService,
  Effect.gen(function* () {
    const runner = yield* CheckoutRunner;
    const opener = yield* UrlOpener;
    return {
      startCheckout: (hasSession, args) => {
        if (!hasSession) {
          return Effect.fail(
            new CheckoutError({
              message: "Sign in to a workspace to upgrade.",
            }),
          );
        }
        if (!isPaidPlanId(args.planId)) {
          return Effect.fail(
            new CheckoutError({
              message: `Unknown plan "${args.planId}".`,
            }),
          );
        }
        return runner.checkout(args).pipe(
          Effect.flatMap((result) =>
            // Open the checkout in the system browser, then report the URL so the
            // UI can show its modal (with a manual "open" fallback link). The
            // UrlOpener fails with InviteError, which we remap to CheckoutError.
            opener.open(result.checkoutUrl).pipe(
              Effect.mapError(
                (e) => new CheckoutError({ message: e.message, cause: e }),
              ),
              Effect.as<CheckoutOutcome>({ checkoutUrl: result.checkoutUrl }),
            ),
          ),
        );
      },
    } satisfies CheckoutServiceShape;
  }),
);

/**
 * Convenience: run the checkout orchestration, returning a Promise (so the React
 * glue can `await` it). Accepts the composed Layer so callers/tests choose the
 * transport. There is no module-level Live Layer because the
 * {@link CheckoutRunner} is built from a React hook (Convex `useAction`) at the
 * call site.
 */
export function runCheckout(
  hasSession: boolean,
  args: { readonly workspaceId: string; readonly planId: string },
  layer: Layer.Layer<CheckoutService>,
): Promise<CheckoutOutcome> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* CheckoutService;
      return yield* svc.startCheckout(hasSession, args);
    }).pipe(Effect.provide(layer)),
  );
}
