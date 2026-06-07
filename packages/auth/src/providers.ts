/**
 * Provider-enable gating, derived PURELY from environment-variable presence
 * (TRI-3244). Ported from convex/auth.ts:46-69,153-166.
 *
 * A provider is "enabled" only when its full credential set is present, so a
 * half-configured provider is treated as OFF rather than registered in a broken
 * state. {@link enabledProviders} returns BOOLEANS ONLY — never client ids or
 * secrets — so it is safe to expose to the client (the UI shows/hides the OAuth
 * buttons and the email-verification / forgot-password steps off these flags).
 */

import { emailEnabled } from "@gtmgrid/email";

/**
 * Whether the GitHub OAuth provider is configured: BOTH the client id and secret
 * must be present (`AUTH_GITHUB_ID` + `AUTH_GITHUB_SECRET`).
 */
export function githubEnabled(): boolean {
  return (
    Boolean(process.env.AUTH_GITHUB_ID) &&
    Boolean(process.env.AUTH_GITHUB_SECRET)
  );
}

/**
 * Whether the Google OAuth provider is configured: BOTH the client id and secret
 * must be present (`AUTH_GOOGLE_ID` + `AUTH_GOOGLE_SECRET`).
 */
export function googleEnabled(): boolean {
  return (
    Boolean(process.env.AUTH_GOOGLE_ID) &&
    Boolean(process.env.AUTH_GOOGLE_SECRET)
  );
}

/** The shape returned by {@link enabledProviders} — booleans only, no secrets. */
export interface EnabledProviders {
  /** GitHub OAuth is configured (id + secret present). */
  readonly github: boolean;
  /** Google OAuth is configured (id + secret present). */
  readonly google: boolean;
  /**
   * Email verification + password reset are active (Resend configured via
   * `AUTH_RESEND_KEY`). The UI uses this to show the verification-code step and
   * the "Forgot password?" link; when false those flows are hidden because no
   * email would ever arrive.
   */
  readonly emailAuth: boolean;
}

/**
 * Which auth providers/flows are enabled on this deployment. The
 * `enabledProviders`-style accessor the AC calls for (replaces the Convex public
 * query convex/auth.ts:153). Booleans only — NO secrets are exposed.
 */
export function enabledProviders(): EnabledProviders {
  return {
    github: githubEnabled(),
    google: googleEnabled(),
    emailAuth: emailEnabled(),
  };
}
