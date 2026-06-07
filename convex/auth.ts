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
import { Email } from "@convex-dev/auth/providers/Email";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import {
  emailEnabled,
  passwordResetEmail,
  sendEmail,
  verificationEmail,
} from "./email.js";
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

/**
 * The custom desktop URL scheme the packaged Tauri app registers for its OAuth
 * deep-link callback (C29): `gtmgrid://auth/callback?code=…`. Must match
 * `plugins.deep-link.desktop.schemes` in tauri.conf.json and the `redirectTo`
 * the desktop client passes to `signIn`.
 */
const DESKTOP_DEEP_LINK_PREFIX = "gtmgrid://";

/**
 * Whether email-backed account flows (sign-up VERIFICATION + password RESET) are
 * active. Both require Resend; without `AUTH_RESEND_KEY` the Password provider is
 * registered WITHOUT `verify`/`reset` so sign-up still works (no verification)
 * and the deployment stays usable — exactly the OAuth-conditional pattern above.
 */
const emailAuthEnabled = emailEnabled();

/**
 * Generate a high-entropy 8-digit numeric OTP using Web Crypto (available in
 * Convex's default runtime). Numeric so it's easy to type from an email; the
 * verification/reset flows always also carry the `email`, so the OTP only needs
 * to be unguessable within its 15-minute window.
 */
function generateOtp(): string {
  const buf = new Uint32Array(8);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (n) => (n % 10).toString()).join("");
}

/**
 * OTP provider for SIGN-UP email verification. Mints a code, emails it via the
 * shared Resend seam (convex/email.ts), and Convex Auth checks it against the
 * `email` on the `email-verification` flow. 15-minute expiry.
 */
const ResendOtpVerification = Email({
  id: "resend-otp",
  maxAge: 60 * 15,
  generateVerificationToken() {
    return Promise.resolve(generateOtp());
  },
  async sendVerificationRequest({ identifier: email, token }) {
    await sendEmail(verificationEmail(email, token));
  },
});

/** OTP provider for PASSWORD RESET (the `reset` / `reset-verification` flows). */
const ResendOtpPasswordReset = Email({
  id: "resend-otp-password-reset",
  maxAge: 60 * 15,
  generateVerificationToken() {
    return Promise.resolve(generateOtp());
  },
  async sendVerificationRequest({ identifier: email, token }) {
    await sendEmail(passwordResetEmail(email, token));
  },
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password({
      verify: emailAuthEnabled ? ResendOtpVerification : undefined,
      reset: emailAuthEnabled ? ResendOtpPasswordReset : undefined,
    }),
    ...(githubEnabled ? [GitHub] : []),
    ...(googleEnabled ? [Google] : []),
  ],
  callbacks: {
    /**
     * Allow the packaged-desktop deep-link redirect (C29) IN ADDITION to the
     * default `SITE_URL` web flow. Convex Auth only runs this during OAuth
     * sign-in: the web redirect passes a `SITE_URL`-based `redirectTo` (or
     * none), while the Tauri client passes `gtmgrid://auth/callback`. We permit
     * the custom scheme explicitly and otherwise reproduce the default
     * `SITE_URL`-anchored behaviour so the existing web OAuth (#17) is unchanged.
     */
    async redirect({ redirectTo }) {
      if (redirectTo.startsWith(DESKTOP_DEEP_LINK_PREFIX)) {
        return redirectTo;
      }
      const siteUrl = process.env.SITE_URL;
      if (
        siteUrl !== undefined &&
        (redirectTo.startsWith(siteUrl) || redirectTo.startsWith("/"))
      ) {
        return redirectTo;
      }
      throw new Error(`Invalid redirectTo ${redirectTo}`);
    },
  },
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
    /**
     * Whether email verification + password reset are active (Resend configured).
     * The UI uses this to show the verification-code step after sign-up and the
     * "Forgot password?" link; when false those flows are hidden because no email
     * would ever arrive. Booleans only — never a secret.
     */
    emailAuth: emailAuthEnabled,
  }),
});
