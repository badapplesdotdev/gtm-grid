/**
 * The party server's auth seam (TRI-3261).
 *
 * The TENANT-ISOLATION decision (verify a token + match its workspace to the
 * room) lives in `@gtmgrid/auth` `authorizeGridConnection` — a PURE function so
 * it is unit-tested independently of PartyKit. This module adds only the tiny,
 * party-specific bits:
 *   - {@link tokenFromUrl}  — read `?token=` from the connect request URL.
 *   - {@link isAuthorizedPublish} — constant-time `Authorization: Bearer
 *     PARTY_PUBLISH_SECRET` check for the SERVER publish path (`onRequest`).
 *
 * Re-export the pure authorizer so the server imports one module.
 */

export {
  authorizeGridConnection,
  type GridConnectionDecision,
  type GridRejectReason,
  type PartyTokenClaims,
  workspaceIdFromRoomId,
} from "@gtmgrid/auth";

/** Read the `?token=` query param from a connect request URL, or null. */
export const tokenFromUrl = (url: string): string | null => {
  try {
    return new URL(url).searchParams.get("token");
  } catch {
    return null;
  }
};

/**
 * Constant-time string compare — equal-length inputs are compared byte-by-byte so
 * timing does not reveal a prefix match. Length differing returns false fast
 * (length is not the secret).
 */
export const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
};

const BEARER_PREFIX = "Bearer ";

/**
 * Validate an `Authorization: Bearer <secret>` header against the configured
 * `PARTY_PUBLISH_SECRET`. Returns true only when the secret is configured AND the
 * bearer matches it in constant time. Fail-closed: an unset/empty secret rejects
 * everything, so the server-publish boundary is never open by default.
 */
export const isAuthorizedPublish = (
  authHeader: string | null,
  secret: string | undefined,
): boolean => {
  if (secret === undefined || secret === "") return false;
  if (authHeader === null) return false;
  if (!authHeader.startsWith(BEARER_PREFIX)) return false;
  return timingSafeEqual(authHeader.slice(BEARER_PREFIX.length), secret);
};
