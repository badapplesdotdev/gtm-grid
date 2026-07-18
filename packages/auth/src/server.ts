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
  passwordResetEmail,
  sendEmail,
  verificationEmail,
} from "@gtmgrid/email";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, emailOTP } from "better-auth/plugins";
import { captureUserSignedUp } from "./analytics.js";
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
  "app://gtmgrid", // packaged Electron desktop (custom app:// renderer scheme)
  // Legacy Tauri webview origins — kept so already-installed Tauri builds keep
  // working through the Electron cut-over (remove once Tauri installs age out).
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "http://localhost:5173", // desktop dev (vite)
];

/**
 * Whether sign-in is gated on a verified email. Opt-in via
 * `AUTH_REQUIRE_EMAIL_VERIFICATION="true"` (default OFF). Deliberately decoupled
 * from `emailEnabled()`: turning it on while Resend is unconfigured would lock
 * everyone out (no way to receive the code), and the desktop's WKWebview bearer
 * needs sign-up to mint a session immediately rather than via the OTP-verify
 * round-trip. Verification mail still sends whenever `emailEnabled()`.
 */
function requireEmailVerification(): boolean {
  return process.env.AUTH_REQUIRE_EMAIL_VERIFICATION === "true";
}

/** Build the `trustedOrigins` allow-list: SITE_URL (if set) + desktop origins
 *  + any GTMGRID_DEV_ORIGINS (comma-separated extra DEV origins for
 *  parallel-worktree development — paired with the same env in the CORS
 *  middleware; unset in production). */
function trustedOrigins(): string[] {
  const origins = [DESKTOP_DEEP_LINK_PREFIX, ...DESKTOP_WEB_ORIGINS];
  const siteUrl = process.env.SITE_URL;
  if (siteUrl !== undefined && siteUrl !== "") origins.push(siteUrl);
  for (const o of process.env.GTMGRID_DEV_ORIGINS?.split(",") ?? []) {
    if (o.trim() !== "") origins.push(o.trim());
  }
  return origins;
}

/**
 * Read the Better Auth signing secret, failing fast with a clear error when it
 * is unset. Passing no `secret` lets Better Auth silently fall back to its
 * hardcoded DEFAULT secret and then throw a generic `BetterAuthError` in
 * production — breaking sign-in/sign-up entirely — so we surface the real cause
 * here at construction time instead. The same secret also signs CRM OAuth state
 * (apps/web/lib/trpc/routers/crm.ts) and email-unsubscribe tokens
 * (apps/web/lib/lifecycle-email/unsubscribe-token.ts), so running on the default
 * would be a signing-security weakness too, not just an outage.
 */
function authSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (secret === undefined || secret === "") {
    throw new Error(
      "BETTER_AUTH_SECRET is not set. It is required to sign Better Auth " +
        "sessions/tokens (and CRM OAuth state + email-unsubscribe tokens). " +
        "Generate one with `openssl rand -hex 32` and set it. See .env.example.",
    );
  }
  return secret;
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
    // Explicit signing secret — never let Better Auth fall back to its hardcoded
    // default (which throws a `BetterAuthError` in production). Fails fast with a
    // clear message when unset (see {@link authSecret}).
    secret: authSecret(),
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
    // Email + password is ALWAYS available (convex/auth.ts:114). Sign-up
    // auto-creates a session (Better Auth `autoSignIn` default) so the desktop
    // captures its `set-auth-token` bearer immediately — the WKWebview path can't
    // rely on the cross-origin OTP-verify response to mint the token. Requiring a
    // verified email BEFORE sign-in is opt-in via `AUTH_REQUIRE_EMAIL_VERIFICATION`
    // (default off); decoupled from `emailEnabled()` so Resend can send OTP /
    // password-reset mail without gating account creation.
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: requireEmailVerification(),
    },
    socialProviders: socialProviders(),
    trustedOrigins: trustedOrigins(),
    // Record every new account as an identified PostHog person, server-side.
    // `user.create.after` fires exactly once per new user (password OR OAuth),
    // and the `user.id` here is the same distinct id the desktop later identifies
    // with — so signups are captured with name/email even if the client identify
    // never runs. Awaited so the serverless function doesn't suspend before the
    // event flushes; the helper guards itself so this can't break sign-up.
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await captureUserSignedUp({
              id: user.id,
              email: user.email,
              name: user.name,
            });
          },
        },
      },
    },
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
