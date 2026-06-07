/**
 * Webhook token + signing-secret minting (the Effect-tier port of
 * convex/webhooks.ts:102/116).
 *
 * The Convex source minted both via `globalThis.crypto.getRandomValues` in the
 * V8 mutation runtime. The Next.js server tier has the SAME Web Crypto
 * (`globalThis.crypto`) available, so the minting rule is unchanged: 32 bytes ->
 * 256 bits of entropy, base64url-encoded (no padding). Kept as a small pure
 * helper so `WebhookService.createWebhook` / `rotateSecret` mint without touching
 * Drizzle, and so the encoding is unit-tested in one place.
 */

/** base64url-encode bytes (no padding), matching the Convex token encoding. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Mint a high-entropy URL-safe token (the public URL segment). 32 random bytes
 * -> 256 bits, base64url. Uses Web Crypto `getRandomValues`, available in the
 * Next.js Node runtime.
 */
export function mintToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/**
 * Mint an HMAC signing secret prefixed `whsec_` (Stripe-style), so the UI reads
 * it as a webhook secret. Same 256-bit entropy + base64url body as the token.
 */
export function mintSigningSecret(): string {
  return `whsec_${mintToken()}`;
}
