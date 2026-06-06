/**
 * Convex Auth setup (T3 / C17) — sign-up / sign-in + sessions.
 *
 * Providers:
 *   - `Password` (always active): email + password sign-up / sign-in. Backed by
 *     the `authAccounts` / `users` tables registered via `authTables` in
 *     schema.ts.
 *   - GitHub + Google OAuth (web redirect flow, C17): each provider is registered
 *     ONLY when its OAuth-app credentials are present on the deployment, so the
 *     deployment still builds/deploys cleanly with no creds set (the provider is
 *     simply not registered). This keeps `npx convex dev --once` green without
 *     OAuth secrets — flip a provider on by setting its env vars, no code change:
 *       - GitHub: `AUTH_GITHUB_ID` + `AUTH_GITHUB_SECRET`
 *       - Google: `AUTH_GOOGLE_ID` + `AUTH_GOOGLE_SECRET`
 *
 * The OAuth path is the STANDARD Convex Auth web redirect: the client calls
 * `signIn(provider)`, the browser is redirected to the provider, back to the
 * Convex callback (`<SITE>/api/auth/callback/<provider>`), and finally back to
 * `SITE_URL`. This is the browser path; the native Tauri deep-link callback for
 * the packaged app is a separate follow-up (task #17) and is NOT handled here.
 *
 * Exports `auth` (used by http.ts for the HTTP routes), `signIn` / `signOut`
 * (called from the client), `store` (auth-state mutation), `isAuthenticated`,
 * and `enabledProviders` (a public query exposing WHICH OAuth providers are
 * enabled — booleans only, never secrets — so the UI can show/hide buttons).
 */

import GitHub from "@auth/core/providers/github";
import Google from "@auth/core/providers/google";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import { query } from "./_generated/server.js";

/**
 * Whether the GitHub OAuth provider is configured on this deployment. True only
 * when BOTH the client id and secret are present, so a half-configured provider
 * is treated as disabled rather than registered in a broken state.
 */
const githubEnabled =
  Boolean(process.env.AUTH_GITHUB_ID) &&
  Boolean(process.env.AUTH_GITHUB_SECRET);

/** Whether the Google OAuth provider is configured on this deployment. */
const googleEnabled =
  Boolean(process.env.AUTH_GOOGLE_ID) &&
  Boolean(process.env.AUTH_GOOGLE_SECRET);

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password,
    ...(githubEnabled ? [GitHub] : []),
    ...(googleEnabled ? [Google] : []),
  ],
});

/**
 * Which OAuth providers are enabled on this deployment, derived purely from env
 * presence. Returns booleans only — NO client ids or secrets are exposed. The
 * client uses this to decide which OAuth buttons to render (and to hide the whole
 * OAuth row when nothing is enabled), so the UI stays clean before any OAuth app
 * is configured. Public (no auth required): the booleans are not sensitive.
 */
export const enabledProviders = query({
  args: {},
  handler: async () => ({
    github: githubEnabled,
    google: googleEnabled,
  }),
});
