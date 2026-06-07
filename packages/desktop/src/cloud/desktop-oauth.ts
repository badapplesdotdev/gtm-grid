/**
 * Pure helpers for the native packaged-desktop OAuth deep-link flow.
 *
 * The web build uses the standard Better Auth browser redirect: `signIn.social`
 * navigates the same window to the provider and back. In a packaged Tauri webview
 * there is no shared browser session to land the redirect, so the desktop flow
 * opens the provider URL in the SYSTEM browser and completes via the
 * `gtmgrid://auth/callback` deep link — Better Auth sets the session cookie
 * server-side before redirecting, so the listener (useApiDeepLinkOAuth) only has
 * to re-read the session.
 *
 * The helpers here (`isTauri`, `extractOAuthCode`, `chooseOAuthFlow`) carry the
 * branch logic + URL parsing so they are unit-testable without a webview. Nothing
 * here runs unless `isTauri()` is true, so the web + email/password flows are
 * untouched.
 */

/**
 * The custom desktop URL scheme + path the packaged app registers for its OAuth
 * callback. Must match `plugins.deep-link.desktop.schemes` ("gtmgrid") in
 * tauri.conf.json and the `callbackURL` passed to Better Auth's `signIn.social`.
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
 * `"web"` (the standard same-window redirect). Pure wrapper over {@link isTauri}
 * so the branch selection is unit-testable in isolation.
 */
export function chooseOAuthFlow(inTauri: boolean): "tauri" | "web" {
  return inTauri ? "tauri" : "web";
}
