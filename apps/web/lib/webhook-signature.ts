/**
 * Inbound-webhook signature verification, used by the public receiver route
 * (`app/api/webhooks/[token]/route.ts`). Lives outside the route file so it can
 * be unit-tested (App Router route files may only export handlers).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify `hex(HMAC-SHA256(secret, rawBody)) === header` in constant time.
 * Returns false on any missing input or length mismatch (length is not secret).
 */
function verifySignature(
  rawBody: string,
  signatureHeader: string | null,
  signingSecret: string,
): boolean {
  if (signatureHeader === null) return false;
  const expected = createHmac("sha256", signingSecret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHeader, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The auth gate: signature auth is OPT-IN per webhook. No signing secret →
 * unsigned posts pass (the unguessable token URL is the credential — what
 * third-party senders without custom HMAC support can work with). A secret →
 * the signature MUST verify in constant time.
 */
export function signatureCheckPasses(
  rawBody: string,
  signatureHeader: string | null,
  signingSecret: string | null,
): boolean {
  if (signingSecret === null || signingSecret === "") return true;
  return verifySignature(rawBody, signatureHeader, signingSecret);
}
