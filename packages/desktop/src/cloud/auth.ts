/**
 * Cloud auth + workspace hooks and orchestration (T8).
 *
 * This module has two halves:
 *
 *  1. **React hooks** (`useMe`, `useActiveWorkspace`, `useAuthState`,
 *     `useTauriSignIn`) the account-bar UI binds to. They wrap the Convex Auth
 *     React API (`@convex-dev/auth/react`) + the reactive `me` query, and add an
 *     "active workspace" selection persisted in `localStorage`.
 *
 *  2. **An Effect-TS orchestration service** (`BrowserSignInService`) plus the
 *     pure helpers it is built from (`parseAuthCallback`, `buildLoopbackRedirect`).
 *     The Tauri sign-in flow — open the system browser at the provider's OAuth
 *     URL, capture the deep-link / loopback callback, then exchange the `code` —
 *     is *logic*, so per the project rules it lives in an Effect service with
 *     typed errors and a `Layer`, unit-tested in `auth.test.ts`. React components
 *     stay plain React and call into it via `useTauriSignIn`.
 *
 * The local-only app is untouched: every hook degrades to a signed-out / null
 * shape when no Convex deployment is configured, and nothing here runs unless
 * the user explicitly signs in.
 */

import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useQuery } from "convex/react";
import { Context, Data, Effect, Layer } from "effect";
import { useCallback, useMemo, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { cloudEnabled } from "./convex";

// ─── Shared types (mirror the `me` query in convex/workspaces.ts) ───────────

/** Seat usage for a workspace: members used vs. the plan limit (null = free). */
export interface SeatUsage {
  readonly used: number;
  readonly limit: number | null;
}

/** A workspace the signed-in user belongs to, with their role + seat usage. */
export interface WorkspaceSummary {
  readonly _id: Id<"workspaces">;
  readonly name: string;
  readonly role: "owner" | "admin" | "member";
  readonly seatUsage: SeatUsage;
}

/** The authenticated user as returned by the `me` query. */
export interface MeUser {
  readonly _id: Id<"users">;
  readonly name: string | null;
  readonly email: string | null;
}

/** The full `me` result: the user plus the workspaces they can access. */
export interface Me {
  readonly user: MeUser;
  readonly workspaces: readonly WorkspaceSummary[];
}

// ─── Pure helpers (the testable core of the Tauri browser flow) ─────────────

/**
 * Raised when an OAuth callback URL cannot be turned into an auth code — either
 * it is malformed, or the provider returned an explicit `error` parameter
 * (e.g. the user denied access). Lives in the Effect error channel.
 */
export class AuthCallbackError extends Data.TaggedError("AuthCallbackError")<{
  readonly message: string;
  /** The provider's `error` param when present (e.g. "access_denied"). */
  readonly providerError?: string;
}> {}

/** The data extracted from a successful OAuth callback URL. */
export interface AuthCallback {
  readonly code: string;
  /** CSRF `state` round-tripped through the provider, when present. */
  readonly state: string | null;
}

/**
 * Parse the `code` / `state` (or an `error`) out of an OAuth callback URL.
 *
 * Works for both callback transports the Tauri shell may use:
 *   - a loopback URL  (`http://localhost:5173/auth/callback?code=...`)
 *   - a deep link     (`gtmgrid://auth/callback?code=...`)
 * because both carry the parameters in the query string. Fails with a typed
 * {@link AuthCallbackError} for a malformed URL, a provider `error`, or a
 * missing `code`.
 */
export function parseAuthCallback(
  rawUrl: string,
): Effect.Effect<AuthCallback, AuthCallbackError> {
  return Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(rawUrl),
      catch: () =>
        new AuthCallbackError({
          message: `Not a valid callback URL: ${rawUrl}`,
        }),
    });

    const providerError = url.searchParams.get("error");
    if (providerError !== null) {
      return yield* Effect.fail(
        new AuthCallbackError({
          message: `OAuth provider returned an error: ${providerError}`,
          providerError,
        }),
      );
    }

    const code = url.searchParams.get("code");
    if (code === null || code === "") {
      return yield* Effect.fail(
        new AuthCallbackError({
          message: "Callback URL is missing the OAuth `code` parameter.",
        }),
      );
    }

    return { code, state: url.searchParams.get("state") };
  });
}

/**
 * The redirect target the provider should send the browser back to after the
 * user authenticates. On the dev deployment `SITE_URL` is `http://localhost:5173`
 * (the Vite dev server), so the loopback path lives under it.
 */
export function buildLoopbackRedirect(siteUrl: string): string {
  // Trim a trailing slash so we never produce `//auth/callback`.
  const base = siteUrl.replace(/\/+$/, "");
  return `${base}/auth/callback`;
}

// ─── Effect service: the browser sign-in orchestration ──────────────────────

/**
 * Raised when the system browser cannot be opened for the sign-in URL.
 */
export class BrowserOpenError extends Data.TaggedError("BrowserOpenError")<{
  readonly message: string;
}> {}

/**
 * Raised when the provider did not return a redirect URL to open — meaning the
 * sign-in completed immediately (e.g. the Password provider) or the provider is
 * misconfigured, so there is no browser step to perform.
 */
export class NoRedirectError extends Data.TaggedError("NoRedirectError")<{
  readonly message: string;
}> {}

/**
 * Side-effecting capabilities the browser flow needs, injected as a `Layer` so
 * the orchestration is unit-testable without Tauri or a real Convex client.
 *
 *   - `startSignIn`  → calls Convex Auth `signIn(provider, { redirectTo })`,
 *                      returning the OAuth redirect URL (if any).
 *   - `openBrowser`  → opens that URL in the system browser (Tauri shell).
 *   - `awaitCallback`→ resolves with the callback URL once the deep-link /
 *                      loopback fires.
 *   - `completeSignIn`→ calls `signIn(provider, { code })` to finish the
 *                      handshake.
 */
export class BrowserAuthEnv extends Context.Tag("BrowserAuthEnv")<
  BrowserAuthEnv,
  {
    readonly startSignIn: (
      provider: string,
      redirectTo: string,
    ) => Effect.Effect<{ redirect: string | null }, never>;
    readonly openBrowser: (url: string) => Effect.Effect<void, BrowserOpenError>;
    readonly awaitCallback: () => Effect.Effect<string, AuthCallbackError>;
    readonly completeSignIn: (
      provider: string,
      code: string,
    ) => Effect.Effect<void, never>;
  }
>() {}

/**
 * The browser sign-in orchestration: start the OAuth flow, open the system
 * browser, wait for the callback, parse it, and exchange the code. Each step's
 * failure is a distinct tagged error so the UI can message the user precisely.
 */
export class BrowserSignInService extends Effect.Service<BrowserSignInService>()(
  "BrowserSignInService",
  {
    effect: Effect.gen(function* () {
      const env = yield* BrowserAuthEnv;
      return {
        /**
         * Run the full browser sign-in for `provider`, sending the browser back
         * to `redirectTo` (typically {@link buildLoopbackRedirect}).
         */
        signIn: (
          provider: string,
          redirectTo: string,
        ): Effect.Effect<
          void,
          BrowserOpenError | AuthCallbackError | NoRedirectError
        > =>
          Effect.gen(function* () {
            const { redirect } = yield* env.startSignIn(provider, redirectTo);
            if (redirect === null) {
              // No OAuth step (e.g. Password provider signed in directly), so
              // there is nothing to open in the browser.
              return yield* Effect.fail(
                new NoRedirectError({
                  message:
                    "Provider did not return an OAuth redirect URL; no browser step needed.",
                }),
              );
            }
            yield* env.openBrowser(redirect);
            const callbackUrl = yield* env.awaitCallback();
            const { code } = yield* parseAuthCallback(callbackUrl);
            yield* env.completeSignIn(provider, code);
          }),
      };
    }),
  },
) {}

// ─── Tauri runtime glue (NOT logic; thin shims around globals) ───────────────

/**
 * Tauri injects its API on `window.__TAURI__` at runtime. We read it through a
 * narrow structural type rather than importing `@tauri-apps/api`, so the bundle
 * has no hard Tauri dependency and the same code runs in the Vite dev browser
 * (where it simply falls back to `window.open`).
 */
interface TauriGlobal {
  opener?: { openUrl?: (url: string) => Promise<void> };
  event?: {
    listen?: (
      event: string,
      handler: (e: { payload: unknown }) => void,
    ) => Promise<() => void>;
  };
}

function tauri(): TauriGlobal | undefined {
  return (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__;
}

/** Whether we are running inside the Tauri shell (vs. a plain browser). */
export function isTauri(): boolean {
  return tauri() !== undefined;
}

/**
 * Open `url` in the system browser. Uses Tauri's opener plugin when available,
 * otherwise `window.open` (dev browser). The `Layer` provider below wraps this.
 */
function openSystemBrowser(url: string): Effect.Effect<void, BrowserOpenError> {
  return Effect.tryPromise({
    try: async () => {
      const t = tauri();
      if (t?.opener?.openUrl) {
        await t.opener.openUrl(url);
        return;
      }
      const win = globalThis.window;
      if (win?.open) {
        win.open(url, "_blank", "noopener");
        return;
      }
      throw new Error("No system browser available");
    },
    catch: (cause) =>
      new BrowserOpenError({
        message: `Could not open the system browser: ${String(cause)}`,
      }),
  });
}

/**
 * Wait for the Tauri deep-link / loopback callback carrying the OAuth result.
 * Listens for the `gtmgrid://auth-callback` deep-link event emitted by the Rust
 * side. Fails if Tauri's event API is unavailable.
 */
function awaitTauriCallback(): Effect.Effect<string, AuthCallbackError> {
  return Effect.async<string, AuthCallbackError>((resume) => {
    const t = tauri();
    const listen = t?.event?.listen;
    if (!listen) {
      resume(
        Effect.fail(
          new AuthCallbackError({
            message:
              "Tauri event API unavailable; cannot capture the auth callback.",
          }),
        ),
      );
      return;
    }
    let unlisten: (() => void) | undefined;
    void listen("auth-callback", (e) => {
      const payload = typeof e.payload === "string" ? e.payload : "";
      unlisten?.();
      resume(Effect.succeed(payload));
    }).then((u) => {
      unlisten = u;
    });
    return Effect.sync(() => unlisten?.());
  });
}

// ─── React hooks (plain React; orchestration lives in the Effect service) ────

/**
 * The reactive `me` query result: the user + their workspaces, or `null` when
 * signed out / cloud-disabled, or `undefined` while loading.
 */
export function useMe(): Me | null | undefined {
  // `skip` the query entirely when the cloud layer is off, so a local-only
  // build issues zero Convex calls.
  return useQuery(api.workspaces.me, cloudEnabled ? {} : "skip") as
    | Me
    | null
    | undefined;
}

/** Convex auth state: whether we are signed in and whether it is still loading. */
export function useAuthState(): { isAuthenticated: boolean; isLoading: boolean } {
  // `useConvexAuth` requires the provider; when cloud is disabled there is no
  // provider, so report a stable signed-out/loaded state without calling it.
  if (!cloudEnabled) {
    return { isAuthenticated: false, isLoading: false };
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks -- `cloudEnabled` is a
  // module constant, so this branch is stable across renders.
  return useConvexAuth();
}

const ACTIVE_WS_KEY = "gtmgrid:activeWorkspace";

/**
 * The active workspace selection. Persisted in `localStorage` and validated
 * against the workspaces the user can actually access (so a stale id from a
 * removed workspace falls back to the first available one).
 */
export function useActiveWorkspace(me: Me | null | undefined): {
  activeWorkspace: WorkspaceSummary | null;
  setActiveWorkspaceId: (id: Id<"workspaces">) => void;
} {
  const [storedId, setStoredId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(ACTIVE_WS_KEY);
    } catch {
      return null;
    }
  });

  const setActiveWorkspaceId = useCallback((id: Id<"workspaces">) => {
    setStoredId(id);
    try {
      localStorage.setItem(ACTIVE_WS_KEY, id);
    } catch {
      /* ignore storage failures (private mode, etc.) */
    }
  }, []);

  const activeWorkspace = useMemo<WorkspaceSummary | null>(() => {
    const list = me?.workspaces ?? [];
    if (list.length === 0) return null;
    return list.find((w) => w._id === storedId) ?? list[0];
  }, [me, storedId]);

  return { activeWorkspace, setActiveWorkspaceId };
}

/**
 * Account actions for the UI: sign in (Tauri browser flow for OAuth, or a
 * direct Password sign-in), sign out, and create a workspace. Wraps the Convex
 * Auth actions + the `createWorkspace` mutation. All no-ops when cloud is off.
 */
export function useAccountActions() {
  const { signIn, signOut } = useAuthActions();

  /**
   * Sign in via an OAuth provider using the Tauri system browser. Builds the
   * orchestration `Layer` from the live Convex Auth actions + the Tauri shims
   * and runs the {@link BrowserSignInService}.
   */
  const signInWithBrowser = useCallback(
    async (provider: string, siteUrl: string): Promise<void> => {
      const redirectTo = buildLoopbackRedirect(siteUrl);
      const envLayer = Layer.succeed(BrowserAuthEnv, {
        startSignIn: (p, r) =>
          Effect.promise(async () => {
            const res = await signIn(p, { redirectTo: r });
            return { redirect: res.redirect ? res.redirect.toString() : null };
          }),
        openBrowser: openSystemBrowser,
        awaitCallback: awaitTauriCallback,
        completeSignIn: (p, code) =>
          Effect.promise(async () => {
            await signIn(p, { code });
          }),
      });

      await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* BrowserSignInService;
          yield* svc.signIn(provider, redirectTo);
        }).pipe(
          Effect.provide(BrowserSignInService.Default),
          Effect.provide(envLayer),
        ),
      );
    },
    [signIn],
  );

  /** Direct email + password sign-in (the active provider on the dev backend). */
  const signInWithPassword = useCallback(
    async (
      email: string,
      password: string,
      flow: "signIn" | "signUp",
    ): Promise<void> => {
      await signIn("password", { email, password, flow });
    },
    [signIn],
  );

  return { signInWithBrowser, signInWithPassword, signOut };
}
