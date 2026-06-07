/**
 * Better Auth server instance (TRI-3244) — the Postgres/Drizzle replacement for
 * the Convex Auth setup in convex/auth.ts.
 *
 * PROVIDERS (matching convex/auth.ts:112-120):
 *   - email + password: ALWAYS on (`emailAndPassword`).
 *   - GitHub + Google OAuth: env-gated — registered only when the provider's
 *     id+secret are present (so the deployment runs with no OAuth creds set).
 *   - email-OTP verification + password reset: 6-digit / 15-minute codes
 *     (packages/auth/src/otp.ts) delivered through the ported Resend seam
 *     (@gtmgrid/email), gated on `AUTH_RESEND_KEY`.
 *
 * REDIRECT ALLOW-LIST: `trustedOrigins` preserves the packaged-desktop deep-link
 * `gtmgrid://` (convex/auth.ts:61,130-142) IN ADDITION to `SITE_URL`, so the
 * Tauri OAuth callback keeps working.
 *
 * SCHEMA: the Drizzle adapter binds to `@gtmgrid/db`'s tables. Our cloud tables
 * are PLURAL (`users`/`sessions`/`accounts`/`verifications`), so `usePlural:true`
 * tells Better Auth to use the plural names without renaming the table the rest
 * of the cloud FKs against.
 *
 * NO LIVE DB AT IMPORT: {@link createAuth} takes the Drizzle `db` as an argument
 * and {@link getAuth} imports `@gtmgrid/db/client` LAZILY (dynamic import) and
 * memoizes — so importing this module (e.g. for the pure helpers) never opens a
 * Postgres connection. Live sign-in/OAuth/OTP is a post-provisioning step.
 */

import type { Db } from "@gtmgrid/db/client";
import * as schema from "@gtmgrid/db/schema";
import {
  emailEnabled,
  passwordResetEmail,
  sendEmail,
  verificationEmail,
} from "@gtmgrid/email";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, emailOTP } from "better-auth/plugins";
import { generateOtp, OTP_EXPIRY_SECONDS, OTP_LENGTH } from "./otp.js";
import { githubEnabled, googleEnabled } from "./providers.js";

/**
 * The custom desktop URL scheme the packaged Tauri app registers for its OAuth
 * deep-link callback (convex/auth.ts:61): `gtmgrid://auth/callback?code=…`. Kept
 * on the redirect allow-list so the desktop OAuth flow survives the migration.
 */
export const DESKTOP_DEEP_LINK_PREFIX = "gtmgrid://";

/**
 * The Tauri desktop webview origins. The packaged app loads from a custom scheme
 * (`tauri://localhost` on macOS, `http(s)://tauri.localhost` on Windows/Linux),
 * and dev runs on Vite (`http://localhost:5173`). These must be trusted so Better
 * Auth accepts the desktop's cross-origin auth requests (paired with CORS in
 * apps/web/middleware.ts and Bearer-token sessions — WKWebview blocks 3p cookies).
 */
export const DESKTOP_WEB_ORIGINS = [
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "http://localhost:5173",
];

/** Build the `trustedOrigins` allow-list: SITE_URL (if set) + desktop origins. */
function trustedOrigins(): string[] {
  const origins = [DESKTOP_DEEP_LINK_PREFIX, ...DESKTOP_WEB_ORIGINS];
  const siteUrl = process.env.SITE_URL;
  if (siteUrl !== undefined && siteUrl !== "") origins.push(siteUrl);
  return origins;
}

/** Better Auth social-provider config, populated only for env-enabled providers. */
function socialProviders(): Record<string, { clientId: string; clientSecret: string }> {
  const providers: Record<string, { clientId: string; clientSecret: string }> =
    {};
  if (githubEnabled()) {
    providers.github = {
      clientId: process.env.AUTH_GITHUB_ID ?? "",
      clientSecret: process.env.AUTH_GITHUB_SECRET ?? "",
    };
  }
  if (googleEnabled()) {
    providers.google = {
      clientId: process.env.AUTH_GOOGLE_ID ?? "",
      clientSecret: process.env.AUTH_GOOGLE_SECRET ?? "",
    };
  }
  return providers;
}

/**
 * The email-OTP plugin instance: 6-digit / 15-minute codes (our own generator,
 * so the format matches the email design) delivered via the Resend seam. Handles
 * the `email-verification` and `forget-password` (password reset) flow types;
 * unknown types fall through to the verification template.
 */
function otpPlugin(): ReturnType<typeof emailOTP> {
  return emailOTP({
    otpLength: OTP_LENGTH,
    expiresIn: OTP_EXPIRY_SECONDS,
    overrideDefaultEmailVerification: true,
    generateOTP: () => generateOtp(),
    async sendVerificationOTP({ email, otp, type }) {
      const message =
        type === "forget-password"
          ? passwordResetEmail(email, otp)
          : verificationEmail(email, otp);
      await sendEmail(message);
    },
  });
}

/**
 * Create a Better Auth instance bound to the given Drizzle `db`. Pure: no env is
 * read at module load, only inside this call, so tests/consumers can construct
 * an instance against any db without a live connection at import time.
 */
export function createAuth(db: Db): ReturnType<typeof betterAuth> {
  // Typed as the WIDE `BetterAuthOptions` so the inferred instance is the
  // portable `Auth<BetterAuthOptions>` (avoids a non-nameable type in the
  // emitted .d.ts that would otherwise reference Better Auth's bundled zod).
  const options: BetterAuthOptions = {
    database: drizzleAdapter(db, {
      provider: "pg",
      usePlural: true,
      schema: {
        users: schema.users,
        sessions: schema.sessions,
        accounts: schema.accounts,
        verifications: schema.verifications,
      },
    }),
    // Email + password is ALWAYS available (convex/auth.ts:114). When Resend is
    // configured we require a verified email before sign-in; otherwise sign-up
    // still works without verification, exactly as the Convex setup degraded.
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: emailEnabled(),
    },
    socialProviders: socialProviders(),
    trustedOrigins: trustedOrigins(),
    // `bearer` lets the desktop carry its session via `Authorization: Bearer
    // <token>` instead of a cookie (WKWebview blocks third-party cookies). The
    // client reads the `set-auth-token` response header on sign-in and replays it.
    plugins: [otpPlugin(), bearer()],
  };
  return betterAuth(options);
}

/** The concrete Better Auth instance type our config produces. */
export type GtmGridAuth = ReturnType<typeof createAuth>;

/** Memoized lazily-constructed default instance (see {@link getAuth}). */
let cached: GtmGridAuth | undefined;

/**
 * The process-wide Better Auth instance, constructed on first use against the
 * live `@gtmgrid/db` client. Imports the client LAZILY so merely importing this
 * module never throws on a missing `DATABASE_URL`. Use in the cloud handlers;
 * tests use {@link createAuth} with an in-memory/fake db instead.
 */
export async function getAuth(): Promise<GtmGridAuth> {
  if (cached === undefined) {
    const { db } = await import("@gtmgrid/db/client");
    cached = createAuth(db);
  }
  return cached;
}
