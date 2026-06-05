/**
 * Tests for the cloud-auth orchestration logic (T8).
 *
 * Covers the testable Effect core of the Tauri browser sign-in flow:
 *   - `parseAuthCallback`     — code/state/error extraction, happy + error paths
 *   - `buildLoopbackRedirect` — redirect-URL construction
 *   - `BrowserSignInService`  — the full orchestration, driven by a stub
 *     `BrowserAuthEnv` Layer (no Tauri, no Convex), asserting OUTCOMES: the
 *     browser is opened with the provider's URL and the code is exchanged; each
 *     failure surfaces as its distinct tagged error.
 */

import { Cause, Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AuthCallbackError,
  BrowserAuthEnv,
  BrowserOpenError,
  BrowserSignInService,
  NoRedirectError,
  buildLoopbackRedirect,
  parseAuthCallback,
} from "./auth";

const run = <A, E>(program: Effect.Effect<A, E>) =>
  Effect.runPromise(program);
const runExit = <A, E>(program: Effect.Effect<A, E>) =>
  Effect.runPromiseExit(program);

/** Pull the typed failure value out of an Exit for assertions. */
function failureOf<A, E>(exit: Exit.Exit<A, E>): E {
  if (!Exit.isFailure(exit)) throw new Error("expected a failure");
  const opt = Cause.failureOption(exit.cause);
  if (opt._tag !== "Some") throw new Error("expected a typed failure");
  return opt.value;
}

describe("parseAuthCallback", () => {
  it("extracts the code and state from a loopback callback URL", async () => {
    const result = await run(
      parseAuthCallback(
        "http://localhost:5173/auth/callback?code=abc123&state=xyz",
      ),
    );
    expect(result).toEqual({ code: "abc123", state: "xyz" });
  });

  it("extracts the code from a deep-link callback URL", async () => {
    const result = await run(
      parseAuthCallback("gtmgrid://auth/callback?code=deep-code"),
    );
    expect(result.code).toBe("deep-code");
    expect(result.state).toBeNull();
  });

  it("fails with AuthCallbackError when the provider returns an error", async () => {
    const exit = await runExit(
      parseAuthCallback(
        "http://localhost:5173/auth/callback?error=access_denied",
      ),
    );
    const err = failureOf(exit);
    expect(err).toBeInstanceOf(AuthCallbackError);
    expect(err.providerError).toBe("access_denied");
  });

  it("fails when the code parameter is missing", async () => {
    const exit = await runExit(
      parseAuthCallback("http://localhost:5173/auth/callback?state=only"),
    );
    expect(failureOf(exit)).toBeInstanceOf(AuthCallbackError);
  });

  it("fails on a malformed URL", async () => {
    const exit = await runExit(parseAuthCallback("not a url"));
    expect(failureOf(exit)).toBeInstanceOf(AuthCallbackError);
  });
});

describe("buildLoopbackRedirect", () => {
  it("appends the callback path to the site URL", () => {
    expect(buildLoopbackRedirect("http://localhost:5173")).toBe(
      "http://localhost:5173/auth/callback",
    );
  });

  it("does not double the slash when the site URL has a trailing slash", () => {
    expect(buildLoopbackRedirect("http://localhost:5173/")).toBe(
      "http://localhost:5173/auth/callback",
    );
  });
});

/**
 * Build a stub `BrowserAuthEnv` Layer that records calls, so tests assert the
 * orchestration's observable behaviour rather than its implementation.
 */
function stubEnv(overrides?: {
  redirect?: string | null;
  callbackUrl?: string;
  openFails?: boolean;
  callbackFails?: boolean;
}) {
  const calls = {
    startSignIn: [] as Array<{ provider: string; redirectTo: string }>,
    opened: [] as string[],
    completed: [] as Array<{ provider: string; code: string }>,
  };
  const layer = Layer.succeed(BrowserAuthEnv, {
    startSignIn: (provider, redirectTo) =>
      Effect.sync(() => {
        calls.startSignIn.push({ provider, redirectTo });
        return {
          redirect:
            overrides?.redirect === undefined
              ? "https://provider.example/oauth?x=1"
              : overrides.redirect,
        };
      }),
    openBrowser: (url) =>
      overrides?.openFails
        ? Effect.fail(new BrowserOpenError({ message: "boom" }))
        : Effect.sync(() => {
            calls.opened.push(url);
          }),
    awaitCallback: () =>
      overrides?.callbackFails
        ? Effect.fail(new AuthCallbackError({ message: "no callback" }))
        : Effect.succeed(
            overrides?.callbackUrl ??
              "http://localhost:5173/auth/callback?code=the-code",
          ),
    completeSignIn: (provider, code) =>
      Effect.sync(() => {
        calls.completed.push({ provider, code });
      }),
  });
  return { layer, calls };
}

const runFlow = (
  layer: Layer.Layer<BrowserAuthEnv>,
  provider = "github",
  redirectTo = "http://localhost:5173/auth/callback",
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const svc = yield* BrowserSignInService;
      yield* svc.signIn(provider, redirectTo);
    }).pipe(
      Effect.provide(BrowserSignInService.Default),
      Effect.provide(layer),
    ),
  );

describe("BrowserSignInService", () => {
  it("opens the system browser with the provider URL and exchanges the code", async () => {
    const { layer, calls } = stubEnv();
    const exit = await runFlow(layer);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(calls.startSignIn).toEqual([
      { provider: "github", redirectTo: "http://localhost:5173/auth/callback" },
    ]);
    expect(calls.opened).toEqual(["https://provider.example/oauth?x=1"]);
    expect(calls.completed).toEqual([
      { provider: "github", code: "the-code" },
    ]);
  });

  it("fails with NoRedirectError when the provider returns no redirect", async () => {
    const { layer, calls } = stubEnv({ redirect: null });
    const exit = await runFlow(layer);
    expect(failureOf(exit)).toBeInstanceOf(NoRedirectError);
    // Nothing should have been opened or completed.
    expect(calls.opened).toEqual([]);
    expect(calls.completed).toEqual([]);
  });

  it("surfaces a BrowserOpenError when the browser cannot be opened", async () => {
    const { layer, calls } = stubEnv({ openFails: true });
    const exit = await runFlow(layer);
    expect(failureOf(exit)).toBeInstanceOf(BrowserOpenError);
    expect(calls.completed).toEqual([]);
  });

  it("surfaces an AuthCallbackError when the callback never arrives", async () => {
    const { layer } = stubEnv({ callbackFails: true });
    const exit = await runFlow(layer);
    expect(failureOf(exit)).toBeInstanceOf(AuthCallbackError);
  });

  it("surfaces an AuthCallbackError when the callback URL has no code", async () => {
    const { layer } = stubEnv({
      callbackUrl: "http://localhost:5173/auth/callback?error=denied",
    });
    const exit = await runFlow(layer);
    const err = failureOf(exit);
    expect(err).toBeInstanceOf(AuthCallbackError);
  });
});
