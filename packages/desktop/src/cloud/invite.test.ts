/**
 * Invite + upgrade orchestration tests (T10).
 *
 * The orchestration is client-side LOGIC (an Effect service), so we test it by
 * providing FAKE {@link InviteRunner} + {@link UrlOpener} Layers — no real
 * Convex, no real browser. We assert it:
 *   1. refuses to invite without a signed-in session (typed error, runner never
 *      called),
 *   2. on the `added` result, forwards the request and returns `added` WITHOUT
 *      opening any URL,
 *   3. on the `checkout` (over-limit) result, opens the checkout URL in the
 *      system browser and returns `checkout` with that URL, and
 *   4. surfaces a runner failure as a typed {@link InviteError}.
 */

import { Cause, Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  InviteError,
  InviteRunner,
  InviteService,
  InviteServiceLive,
  UrlOpener,
  type InviteActionResult,
  type InviteInput,
} from "./invite";

const input: InviteInput = {
  workspaceId: "ws1",
  userId: "user-2",
  role: "member",
};

/**
 * Build a Live invite Layer over a fake runner (returns `result` and records the
 * call) and a fake opener (records the opened URLs).
 */
function fakeInvite(result: InviteActionResult) {
  const calls: InviteInput[] = [];
  const opened: string[] = [];
  const layer = InviteServiceLive.pipe(
    Layer.provide(
      Layer.succeed(InviteRunner, {
        invite: (i) => {
          calls.push(i);
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

/** A Live invite Layer whose runner always fails. */
const failingLayer = InviteServiceLive.pipe(
  Layer.provide(
    Layer.succeed(InviteRunner, {
      invite: () => Effect.fail(new InviteError({ message: "backend error" })),
    }),
  ),
  Layer.provide(
    Layer.succeed(UrlOpener, { open: () => Effect.void }),
  ),
);

const run = <A>(
  program: Effect.Effect<A, InviteError, InviteService>,
  layer: Layer.Layer<InviteService>,
) => Effect.runPromiseExit(program.pipe(Effect.provide(layer)));

const invite = (hasSession: boolean) =>
  Effect.gen(function* () {
    const svc = yield* InviteService;
    return yield* svc.inviteMember(hasSession, input);
  });

describe("InviteService", () => {
  it("fails with a typed InviteError when there is no session", async () => {
    const { layer, calls, opened } = fakeInvite({
      status: "added",
      memberId: "m1",
    });

    const exit = await run(invite(false), layer);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag).toBe("Some");
      if (err._tag === "Some") {
        expect(err.value).toBeInstanceOf(InviteError);
        expect(err.value.message).toMatch(/sign in/i);
      }
    }
    // Short-circuited: neither the runner nor the opener was called.
    expect(calls).toHaveLength(0);
    expect(opened).toHaveLength(0);
  });

  it("adds the member and opens NO url on the added result", async () => {
    const { layer, calls, opened } = fakeInvite({
      status: "added",
      memberId: "m9",
    });

    const exit = await run(invite(true), layer);

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual({ status: "added", memberId: "m9" });
    }
    expect(calls).toEqual([input]);
    expect(opened).toHaveLength(0);
  });

  it("opens the checkout url in the browser on the over-limit result", async () => {
    const { layer, calls, opened } = fakeInvite({
      status: "checkout",
      checkoutUrl: "https://checkout.example/upgrade",
    });

    const exit = await run(invite(true), layer);

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual({
        status: "checkout",
        checkoutUrl: "https://checkout.example/upgrade",
      });
    }
    // The invite was attempted, then the checkout URL was opened exactly once.
    expect(calls).toEqual([input]);
    expect(opened).toEqual(["https://checkout.example/upgrade"]);
  });

  it("surfaces a runner failure as a typed InviteError", async () => {
    const exit = await run(invite(true), failingLayer);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag === "Some" && err.value instanceof InviteError).toBe(true);
      if (err._tag === "Some") {
        expect(err.value.message).toBe("backend error");
      }
    }
  });
});
