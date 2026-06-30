/**
 * Pure helpers for the native packaged-desktop OAuth deep-link flow.
 *
 * The web build uses the standard Better Auth browser redirect: `signIn.social`
 * navigates the same window to the provider and back. In the packaged desktop app
 * there is no shared browser session to land the redirect, so the desktop flow
 * opens the provider URL in the SYSTEM browser and completes via the
 * `gtmgrid://auth/callback` deep link — Better Auth sets the session cookie
 * server-side before redirecting, so the listener (useApiDeepLinkOAuth) only has
 * to re-read the session.
 *
 * The helpers here (`isDesktop`, `extractOAuthCode`, `chooseOAuthFlow`) carry the
 * branch logic + URL parsing so they are unit-testable without a webview. Nothing
 * here runs unless `isDesktop()` is true, so the web + email/password flows are
 * untouched.
 */

import { isDesktop } from "../electron";

export { isDesktop };

/**
 * The custom desktop URL scheme + path the app registers for its OAuth callback.
 * Must match the `gtmgrid` scheme registered by the Electron main
 * (`setAsDefaultProtocolClient`) and the `callbackURL` passed to Better Auth's
 * `signIn.social`.
 */
export const OAUTH_REDIRECT_URL = "gtmgrid://auth/callback";

/** The IPC channel the Electron main forwards the incoming deep-link URL on. */
export const OAUTH_CALLBACK_EVENT = "oauth-callback";

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
 * Which OAuth flow a button should run: `"desktop"` (open the provider URL in the
 * system browser, complete via deep link) when inside the packaged app, else
 * `"web"` (the standard same-window redirect). Pure wrapper over {@link isDesktop}
 * so the branch selection is unit-testable in isolation.
 */
export function chooseOAuthFlow(inDesktop: boolean): "desktop" | "web" {
  return inDesktop ? "desktop" : "web";
}
