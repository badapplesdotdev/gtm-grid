/**
 * Native packaged-desktop OAuth via a Tauri deep-link callback (C29).
 *
 * The web build uses the STANDARD Convex Auth browser redirect (#17): `signIn`
 * navigates the SAME window to the provider and back. That does not work in a
 * packaged Tauri webview (there is no shared browser session and no place to
 * land the redirect), so on desktop we use the documented Convex Auth
 * RN/desktop pattern instead:
 *
 *   1. `signIn(provider, { redirectTo: "gtmgrid://auth/callback" })` returns a
 *      `{ redirect }` URL instead of navigating.
 *   2. We open that URL in the user's SYSTEM browser (Tauri opener plugin).
 *   3. The provider → Convex callback → redirects to `gtmgrid://auth/callback?
 *      code=<code>`, which the OS routes back to the running app as a deep link.
 *   4. A listener (the Rust-emitted "oauth-callback" Tauri event AND the
 *      `@tauri-apps/plugin-deep-link` `onOpenUrl` handler) receives that URL,
 *      this module extracts the `code`, and calls `signIn(provider, { code })`
 *      to COMPLETE the session.
 *
 * The pure helpers here (`isTauri`, `extractOAuthCode`, `chooseOAuthFlow`) carry
 * the branch logic and URL parsing so they are unit-testable without a webview.
 * The web path (#17) and email/password are untouched: nothing in this module
 * runs unless `isTauri()` is true.
 */

import type { ConvexAuthActionsContext } from "@convex-dev/auth/react";
import type { OAuthProvider } from "./auth";

/**
 * The exact `signIn` function type Convex Auth exposes, reused directly so our
 * helpers accept the real `useAuthActions().signIn` without any cast and so the
 * `{ redirectTo }` / `{ code }` params + the `{ signingIn, redirect? }` return
 * shape stay in lock-step with the library.
 */
export type SignIn = ConvexAuthActionsContext["signIn"];

/** Open a URL in the system browser (subset of the Tauri opener plugin API). */
export type OpenUrl = (url: string) => Promise<void>;

/**
 * The custom desktop URL scheme + path the packaged app registers for its OAuth
 * callback. Must match `plugins.deep-link.desktop.schemes` ("gtmgrid") in
 * tauri.conf.json and the `redirectTo` allow-listed in `convex/auth.ts`.
 */
export const OAUTH_REDIRECT_URL = "gtmgrid://auth/callback";

/** The Tauri event name the Rust side emits with the incoming deep-link URL. */
export const OAUTH_CALLBACK_EVENT = "oauth-callback";

/**
 * Are we running inside a Tauri webview? Detected via the globals Tauri injects:
 * `__TAURI_INTERNALS__` (v2) or `__TAURI__`. Pure + defensive (no `window` in a
 * non-DOM test/SSR context) so the branch is unit-testable. This is the SINGLE
 * helper every OAuth button uses to choose between the web and desktop flows.
 */
export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  // Detect via the injected globals using `in` (no cast): Tauri sets one of
  // these on `window` only inside its webview.
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
}

/**
 * Extract the OAuth `code` query param from a callback URL string, or `null`
 * when the URL is malformed or carries no `code`. Pure: tolerates the custom
 * `gtmgrid://` scheme (parsed via the `URL` constructor) as well as plain web
 * callback URLs, so it can be unit-tested directly against the deep-link string.
 */
export function extractOAuthCode(url: string): string | null {
  try {
    const code = new URL(url).searchParams.get("code");
    return code !== null && code.length > 0 ? code : null;
  } catch {
    return null;
  }
}

/**
 * Which OAuth flow a button should run: `"tauri"` (open the provider URL in the
 * system browser, complete via deep link) when inside the packaged app, else
 * `"web"` (the standard Convex Auth same-window redirect, #17). Pure wrapper
 * over {@link isTauri} so the branch selection is unit-testable in isolation.
 */
export function chooseOAuthFlow(inTauri: boolean): "tauri" | "web" {
  return inTauri ? "tauri" : "web";
}

/**
 * The provider whose desktop OAuth flow is currently in flight. The deep-link
 * callback URL only carries the `code`, NOT which provider issued it, so we
 * remember it between {@link startDesktopOAuth} and the listener's
 * {@link completeDesktopOAuth}. Module-scoped (a single flow runs at a time) and
 * exported only for direct unit testing of the start→complete handoff.
 */
let pendingProvider: OAuthProvider | null = null;

/** The provider awaiting a deep-link callback, or `null` when none is in flight. */
export function getPendingProvider(): OAuthProvider | null {
  return pendingProvider;
}

/** Reset the in-flight provider (used between tests and after completion). */
export function clearPendingProvider(): void {
  pendingProvider = null;
}

/**
 * START the desktop OAuth flow: ask Convex Auth for the provider redirect URL
 * (without navigating), remember the provider, and open the URL in the system
 * browser. Completion happens later, when the deep-link callback fires (see
 * {@link completeDesktopOAuth}).
 *
 * Throws if Convex Auth did not return a redirect URL (e.g. the provider is not
 * an OAuth provider) so the caller can surface an error instead of silently
 * doing nothing.
 */
export async function startDesktopOAuth(
  provider: OAuthProvider,
  signIn: SignIn,
  openUrl: OpenUrl,
): Promise<void> {
  const { redirect } = await signIn(provider, {
    redirectTo: OAUTH_REDIRECT_URL,
  });
  if (redirect === undefined) {
    throw new Error("OAuth provider did not return a redirect URL.");
  }
  pendingProvider = provider;
  await openUrl(redirect.toString());
}

/**
 * COMPLETE the desktop OAuth flow from an incoming deep-link callback URL:
 * extract the `code` and exchange it for a session via `signIn(provider,
 * { code })`. Returns `true` when a code was found and the exchange was started,
 * `false` when the URL carried no usable code (so an unrelated deep link is a
 * no-op rather than an error).
 */
export async function completeDesktopOAuth(
  url: string,
  provider: OAuthProvider,
  signIn: SignIn,
): Promise<boolean> {
  const code = extractOAuthCode(url);
  if (code === null) return false;
  await signIn(provider, { code });
  return true;
}

/**
 * Listener entry point for an incoming deep-link URL. Resolves the provider from
 * the in-flight flow (set by {@link startDesktopOAuth}), completes the session,
 * and clears the pending provider on success. Returns `false` (a no-op) when no
 * flow is in flight or the URL carries no code, so unrelated deep links are
 * ignored safely. This is what the Tauri event / `onOpenUrl` listener calls.
 */
export async function handleDeepLinkCallback(
  url: string,
  signIn: SignIn,
): Promise<boolean> {
  const provider = pendingProvider;
  if (provider === null) return false;
  const completed = await completeDesktopOAuth(url, provider, signIn);
  if (completed) pendingProvider = null;
  return completed;
}
