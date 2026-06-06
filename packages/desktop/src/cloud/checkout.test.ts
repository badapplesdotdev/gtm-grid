/**
 * Plan-selection checkout orchestration tests (C27).
 *
 * The orchestration is client-side LOGIC (an Effect service), so we test it by
 * providing FAKE {@link CheckoutRunner} + {@link UrlOpener} Layers — no real
 * Convex, no real browser. We assert it:
 *   1. refuses to checkout without a signed-in session (typed error, runner
 *      never called),
 *   2. refuses an unknown plan id BEFORE calling the backend,
 *   3. attaches each valid plan id and opens the returned URL in the browser,
 *   4. surfaces a runner failure as a typed {@link CheckoutError}.
 */

import { Cause, Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { UrlOpener } from "./invite";
import {
  CheckoutError,
  CheckoutRunner,
  CheckoutService,
  CheckoutServiceLive,
  type CheckoutActionResult,
} from "./checkout";

/**
 * Build a Live checkout Layer over a fake runner (returns `result` and records
 * the call) and a fake opener (records the opened URLs).
 */
function fakeCheckout(result: CheckoutActionResult) {
  const calls: Array<{ workspaceId: string; planId: string }> = [];
  const opened: string[] = [];
  const layer = CheckoutServiceLive.pipe(
    Layer.provide(
      Layer.succeed(CheckoutRunner, {
        checkout: (args) => {
          calls.push(args);
          return Effect.succeed(result);
        },
      }),
    ),
    Layer.provide(
      Layer.succeed(UrlOpener, {
        open: (url) => {
          opened.push(url);
          return Effect.void;
        },
      }),
    ),
  );
  return { layer, calls, opened };
}

const failingLayer = CheckoutServiceLive.pipe(
  Layer.provide(
    Layer.succeed(CheckoutRunner, {
      checkout: () =>
        Effect.fail(new CheckoutError({ message: "backend error" })),
    }),
  ),
  Layer.provide(Layer.succeed(UrlOpener, { open: () => Effect.void })),
);

const run = <A>(
  program: Effect.Effect<A, CheckoutError, CheckoutService>,
  layer: Layer.Layer<CheckoutService>,
) => Effect.runPromiseExit(program.pipe(Effect.provide(layer)));

const start = (hasSession: boolean, planId: string) =>
  Effect.gen(function* () {
    const svc = yield* CheckoutService;
    return yield* svc.startCheckout(hasSession, { workspaceId: "ws1", planId });
  });

describe("CheckoutService", () => {
  it("fails with a typed CheckoutError when there is no session", async () => {
    const { layer, calls, opened } = fakeCheckout({
      checkoutUrl: "https://checkout.example/x",
    });

    const exit = await run(start(false, "team"), layer);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag === "Some" && err.value instanceof CheckoutError).toBe(
        true,
      );
      if (err._tag === "Some") expect(err.value.message).toMatch(/sign in/i);
    }
    expect(calls).toHaveLength(0);
    expect(opened).toHaveLength(0);
  });

  it("rejects an unknown plan id before calling the backend", async () => {
    const { layer, calls, opened } = fakeCheckout({
      checkoutUrl: "https://checkout.example/x",
    });

    const exit = await run(start(true, "enterprise"), layer);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag === "Some" && err.value instanceof CheckoutError).toBe(
        true,
      );
    }
    // Defence in depth: the runner was never called for a forged plan.
    expect(calls).toHaveLength(0);
    expect(opened).toHaveLength(0);
  });

  it("attaches each valid plan id and opens the returned URL", async () => {
    for (const planId of ["team", "business", "unlimited"]) {
      const { layer, calls, opened } = fakeCheckout({
        checkoutUrl: `https://checkout.example/${planId}`,
      });

      const exit = await run(start(true, planId), layer);

      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value).toEqual({
          checkoutUrl: `https://checkout.example/${planId}`,
        });
      }
      expect(calls).toEqual([{ workspaceId: "ws1", planId }]);
      expect(opened).toEqual([`https://checkout.example/${planId}`]);
    }
  });

  it("surfaces a runner failure as a typed CheckoutError", async () => {
    const exit = await run(start(true, "team"), failingLayer);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag === "Some" && err.value instanceof CheckoutError).toBe(
        true,
      );
      if (err._tag === "Some") expect(err.value.message).toBe("backend error");
    }
  });
});
