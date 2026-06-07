/**
 * Better Auth desktop OAuth + sidecar-token logic for the NEW Postgres-tier
 * path (TRI-3252). This is the strangler-fig counterpart to `desktop-oauth.ts`
 * (which drives the legacy Convex deep-link flow): the SAME `gtmgrid://` deep
 * link, but completed by Better Auth instead of Convex Auth.
 *
 * The packaged Tauri webview cannot use a same-window OAuth redirect, so the
 * desktop flow is:
 *
 *   1. ask Better Auth for the provider URL WITHOUT navigating
 *      (`signIn.social({ provider, callbackURL: "gtmgrid://auth/callback",
 *      disableRedirect: true })` → `{ url }`);
 *   2. open that URL in the SYSTEM browser (Tauri opener plugin);
 *   3. the provider → Better Auth callback sets the session cookie and
 *      redirects to `gtmgrid://auth/callback`, which the OS routes back to the
 *      running app as a deep link;
 *   4. the deep-link listener re-reads the Better Auth session
 *      (`getSession`), which now resolves authenticated — no `code` exchange is
 *      needed because Better Auth already established the session server-side.
 *
 * The pure helpers here (`apiOAuthCallbackUrl`, `isApiOAuthCallback`,
 * `sidecarTokenFromSession`) carry the URL + token logic so they are
 * unit-testable without a webview OR a live server. Nothing in this module runs
 * on the web build (the listener is Tauri-gated in `useDeepLinkOAuth.ts`).
 */

import { OAUTH_REDIRECT_URL } from "./desktop-oauth";

/**
 * The OAuth providers the desktop supports, matching the social providers
 * registered in the Better Auth server (`packages/auth/src/server.ts`).
 */
export type ApiOAuthProvider = "github" | "google";

/**
 * The custom desktop URL the packaged app registers for its OAuth callback,
 * reused from the legacy flow so a single scheme is registered with the OS and
 * allow-listed in the Better Auth `trustedOrigins` (`gtmgrid://`).
 */
export const API_OAUTH_REDIRECT_URL = OAUTH_REDIRECT_URL;

/**
 * The `callbackURL` to hand Better Auth for the desktop deep-link flow. A thin
 * named wrapper so the value is asserted in one place and easy to evolve. Pure.
 */
export function apiOAuthCallbackUrl(): string {
  return API_OAUTH_REDIRECT_URL;
}

/**
 * Whether an incoming deep-link URL is our OAuth callback (scheme + path match
 * `gtmgrid://auth/callback`). Pure + defensive: a malformed or unrelated deep
 * link returns `false` so the listener ignores it instead of throwing. Unlike
 * the legacy flow this does NOT require a `code` query param, because Better
 * Auth completes the session server-side before redirecting back.
 */
export function isApiOAuthCallback(url: string): boolean {
  try {
    const parsed = new URL(url);
    const expected = new URL(API_OAUTH_REDIRECT_URL);
    return (
      parsed.protocol === expected.protocol &&
      parsed.host === expected.host &&
      parsed.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}

/**
 * The minimal Better Auth session shape this module reads: the bearer token
 * carried on the session, used as the sidecar token for cloud-column runs. Both
 * the session row's `token` and (when present) the user id are tolerated as
 * `null`/absent so loading/signed-out states resolve to `null` cleanly.
 */
export interface ApiSessionLike {
  readonly session?: { readonly token?: string | null } | null;
}

/**
 * Resolve the sidecar token from a Better Auth session, or `null` when there is
 * no active session. This is the `useAuthToken()` REPLACEMENT (useCloudGrid.ts:20):
 * cloud-column runs send this token to the apps/web API so the sidecar can act
 * as the signed-in user. Pure so the token-resolution branch is unit-testable
 * without a live session:
 *   - no session / loading           → `null`
 *   - session present, empty token   → `null`
 *   - session present, real token    → that token
 */
export function sidecarTokenFromSession(
  session: ApiSessionLike | null | undefined,
): string | null {
  const token = session?.session?.token;
  return token !== undefined && token !== null && token.length > 0
    ? token
    : null;
}

/**
 * The `{ data, error }` envelope every Better Auth client method resolves to:
 * unlike Convex Auth (which throws), the Better Auth client RETURNS errors
 * instead of rejecting. We model only what we read — the optional `data` and a
 * possible `error` carrying a message/code.
 */
export interface BetterAuthResult<T> {
  readonly data?: T | null;
  readonly error?:
    | { readonly message?: string | null; readonly code?: string | null }
    | null;
}

/**
 * Normalize a Better Auth client result to the throw-on-failure contract the
 * desktop UI already relies on (its handlers `try/catch` and run the message
 * through {@link friendlyAuthError}). Better Auth resolves `{ error }` rather
 * than rejecting, so this re-raises that error as a real `Error` (carrying the
 * server message, or the code, or a generic fallback) and otherwise returns the
 * `data`. Pure so the failure/success mapping is unit-testable without a live
 * server:
 *   - `{ error: { message } }` → throws `Error(message)`
 *   - `{ error: { code } }` (no message) → throws `Error(code)`
 *   - `{ error: {} }` → throws a generic `Error`
 *   - `{ data }` → returns `data`
 */
export function unwrapAuthResult<T>(result: BetterAuthResult<T>): T | null {
  if (result.error !== undefined && result.error !== null) {
    const message =
      (result.error.message ?? undefined) ||
      (result.error.code ?? undefined) ||
      "Authentication failed.";
    throw new Error(message);
  }
  return result.data ?? null;
}
