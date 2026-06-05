/**
 * Convex Auth setup (T3) — sign-up / sign-in + sessions.
 *
 * Providers:
 *   - `Password` (active): email + password sign-up / sign-in. Backed by the
 *     `authAccounts` / `users` tables registered via `authTables` in schema.ts.
 *   - GitHub OAuth (scaffolded, DISABLED-but-wired): the import and provider
 *     entry are present so wiring a second provider later is a one-line change.
 *     It is only added to the active provider list when both `AUTH_GITHUB_ID`
 *     and `AUTH_GITHUB_SECRET` are set on the deployment, so the disabled state
 *     is the default and `convex dev` deploys cleanly without OAuth secrets.
 *
 * Exports `auth` (used by http.ts for the HTTP routes), `signIn` / `signOut`
 * (called from the client), `store` (auth-state mutation), and `isAuthenticated`.
 */

import GitHub from "@auth/core/providers/github";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";

/**
 * Scaffolded OAuth provider. Wired but inert unless the GitHub OAuth app
 * credentials are configured on the deployment — flip it on by setting
 * `AUTH_GITHUB_ID` + `AUTH_GITHUB_SECRET` (no code change needed).
 */
const githubEnabled =
  Boolean(process.env.AUTH_GITHUB_ID) &&
  Boolean(process.env.AUTH_GITHUB_SECRET);

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password, ...(githubEnabled ? [GitHub] : [])],
});
