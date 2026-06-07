/**
 * Invite + upgrade orchestration tests (T10).
 *
 * The orchestration is client-side LOGIC (an Effect service), so we test it by
 * providing FAKE {@link InviteRunner} + {@link UrlOpener} Layers — no real
 * Convex, no real browser. We assert it:
 *   1. refuses to invite without a signed-in session (typed error, runner never
 *      called),
 *   2. on the `invited` result, forwards the request and returns `invited`
 *      (email + acceptUrl + emailSent) WITHOUT opening any URL,
 *   3. on the `already_member` result, passes it through WITHOUT opening any URL,
 *   4. on the `checkout` (over-limit) result, opens the checkout URL in the
 *      system browser and returns `checkout` with that URL, and
 *   5. surfaces a runner failure as a typed {@link InviteError}.
 */

import { Cause, Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  apiInviteRunner,
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
  email: "teammate@company.com",
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
      status: "invited",
      email: input.email,
      acceptUrl: "https://app.example/invite/tok",
      emailSent: true,
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

  it("creates the invite and opens NO url on the invited result", async () => {
    const { layer, calls, opened } = fakeInvite({
      status: "invited",
      email: input.email,
      acceptUrl: "https://app.example/invite/tok9",
      emailSent: true,
    });

    const exit = await run(invite(true), layer);

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual({
        status: "invited",
        email: input.email,
        acceptUrl: "https://app.example/invite/tok9",
        emailSent: true,
      });
    }
    expect(calls).toEqual([input]);
    expect(opened).toHaveLength(0);
  });

  it("passes through already_member and opens NO url", async () => {
    const { layer, calls, opened } = fakeInvite({
      status: "already_member",
      email: input.email,
    });

    const exit = await run(invite(true), layer);

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual({
        status: "already_member",
        email: input.email,
      });
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

// ─── apiInviteRunner — the NEW tRPC `invitations.invite` branch (TRI-3255) ─────
//
// The strangler-fig replacement for the inline Convex `useAction`-derived runner.
// We inject a fake `mutate` (the tRPC call) to assert it forwards the args and
// passes through EACH of the three result shapes (invited / already_member /
// checkout) unchanged, and maps a tRPC/transport failure to a typed InviteError —
// no live client. The three-way branch itself is exercised by the InviteService
// tests above; here we prove the runner is a transparent transport.

describe("apiInviteRunner", () => {
  it("forwards the args to the tRPC mutate and returns the invited result", async () => {
    const calls: Array<{ workspaceId: string; email: string; role: string }> =
      [];
    const result: InviteActionResult = {
      status: "invited",
      email: input.email,
      acceptUrl: "https://app.example/invite/tok",
      emailSent: true,
    };
    const runner = apiInviteRunner(async (args) => {
      calls.push(args);
      return result;
    });

    const got = await Effect.runPromise(runner.invite(input));

    expect(got).toEqual(result);
    expect(calls).toEqual([
      { workspaceId: input.workspaceId, email: input.email, role: input.role },
    ]);
  });

  it("passes through the already_member result unchanged", async () => {
    const runner = apiInviteRunner(async () => ({
      status: "already_member" as const,
      email: input.email,
    }));

    const got = await Effect.runPromise(runner.invite(input));

    expect(got).toEqual({ status: "already_member", email: input.email });
  });

  it("passes through the checkout (over-limit) result unchanged", async () => {
    const runner = apiInviteRunner(async () => ({
      status: "checkout" as const,
      checkoutUrl: "https://checkout.example/upgrade",
    }));

    const got = await Effect.runPromise(runner.invite(input));

    expect(got).toEqual({
      status: "checkout",
      checkoutUrl: "https://checkout.example/upgrade",
    });
  });

  it("maps a tRPC/transport failure to a typed InviteError", async () => {
    const runner = apiInviteRunner(async () => {
      throw new Error("FORBIDDEN");
    });

    const exit = await Effect.runPromiseExit(runner.invite(input));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag === "Some" && err.value instanceof InviteError).toBe(true);
      if (err._tag === "Some") expect(err.value.message).toBe("FORBIDDEN");
    }
  });
});
