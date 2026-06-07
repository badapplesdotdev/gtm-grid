/**
 * `@gtmgrid/auth` — the Better Auth server for the Postgres cloud tier
 * (TRI-3244), replacing `@convex-dev/auth`.
 *
 * Surface:
 *   - {@link createAuth} / {@link getAuth} — build the Better Auth instance
 *     (Drizzle adapter over `@gtmgrid/db`, email+password always, GitHub/Google
 *     env-gated, email-OTP verify + reset via the Resend seam, `gtmgrid://` kept
 *     on the redirect allow-list).
 *   - {@link resolveSession} / {@link getSessionUserId} — session resolution for
 *     the tRPC context (replaces `getAuthUserId`).
 *   - {@link enabledProviders} — booleans-only provider/flow gating (no secrets).
 *   - {@link mintSupabaseJwt} — Supabase-compatible HS256 JWT carrying the user
 *     id, for W3 realtime.
 *   - {@link generateOtp} — the 6-digit OTP generator the email flows use.
 *
 * Importing this barrel is side-effect-free: no Postgres connection is opened
 * until {@link getAuth} is awaited.
 */

export {
  createAuth,
  getAuth,
  DESKTOP_DEEP_LINK_PREFIX,
  type GtmGridAuth,
} from "./server.js";
export {
  resolveSession,
  getSessionUserId,
  type ResolvedSession,
} from "./session.js";
export {
  enabledProviders,
  githubEnabled,
  googleEnabled,
  type EnabledProviders,
} from "./providers.js";
export {
  mintSupabaseJwt,
  SUPABASE_JWT_TTL_SECONDS,
  type MintSupabaseJwtOptions,
} from "./jwt.js";
export { generateOtp, OTP_LENGTH, OTP_EXPIRY_SECONDS } from "./otp.js";
