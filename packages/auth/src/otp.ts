/**
 * OTP generation for the email-verification + password-reset flows (TRI-3244).
 *
 * Ported from convex/auth.ts:78-82. We mint our OWN code (rather than relying on
 * Better Auth's built-in generator) so the format stays EXACTLY what today's
 * email design and verify-screen copy expect: a 6-digit NUMERIC code, rendered
 * "123 456" by the email template (packages/email). The code only needs to be
 * unguessable within its 15-minute window — the flow always also carries the
 * `email`, so a 6-digit numeric space is sufficient.
 *
 * Uses Web Crypto (`globalThis.crypto.getRandomValues`), available in Node 20+
 * and edge runtimes, so this is portable across the cloud handlers.
 */

/** Number of digits in a generated OTP — matches the email design + copy. */
export const OTP_LENGTH = 6;

/** OTP validity window in SECONDS (15 minutes), shared with the auth config. */
export const OTP_EXPIRY_SECONDS = 60 * 15;

/**
 * Generate a cryptographically-random {@link OTP_LENGTH}-digit numeric OTP as a
 * string (leading zeros preserved). Each digit is drawn from a fresh random
 * 32-bit word reduced mod 10.
 */
export function generateOtp(): string {
  const buf = new Uint32Array(OTP_LENGTH);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (n) => (n % 10).toString()).join("");
}
