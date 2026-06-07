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
 *   - {@link mintPartyToken} / {@link verifyPartyToken} /
 *     {@link authorizeGridConnection} — workspace-scoped HS256 tokens for the
 *     server-gated PartyKit realtime provider (TRI-3261). The token binds a
 *     connection to ONE workspace; the party authorizes by matching the claim to
 *     the room, fixing the cross-tenant leak.
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
  authorizeGridConnection,
  type GridConnectionDecision,
  type GridRejectReason,
  gridRoomId,
  mintPartyToken,
  type MintPartyTokenOptions,
  PARTY_TOKEN_TTL_SECONDS,
  type PartyTokenClaims,
  verifyPartyToken,
  workspaceIdFromRoomId,
} from "./party-token.js";
export { generateOtp, OTP_LENGTH, OTP_EXPIRY_SECONDS } from "./otp.js";
