import { createHmac, timingSafeEqual } from "node:crypto";
import type { AnalyticsEventName } from "@gtmgrid/analytics";

/**
 * Verify an Autumn billing webhook signature (Svix / "Standard Webhooks" scheme —
 * the `whsec_…` signing secret + `webhook-id`/`-timestamp`/`-signature` headers).
 *
 * Autumn does NOT send a bearer token; it HMAC-signs each delivery. We recompute
 * `base64(HMAC-SHA256(key, "<id>.<timestamp>.<rawBody>"))` over the EXACT raw bytes
 * and constant-time compare against any `v1,<sig>` in the signature header, and we
 * reject deliveries outside a ±5-min window (replay protection).
 *
 * Fail-closed: an UNSET secret, missing headers, a bad timestamp, or no matching
 * signature all return false. Pure (now injectable) → unit-testable.
 */
export function verifyWebhookSignature(
  rawBody: string,
  headers: Headers,
  secret: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!secret) return false;
  const id = headers.get("webhook-id") ?? headers.get("svix-id");
  const timestamp = headers.get("webhook-timestamp") ?? headers.get("svix-timestamp");
  const sigHeader = headers.get("webhook-signature") ?? headers.get("svix-signature");
  if (!id || !timestamp || !sigHeader) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > 300) return false;

  // `whsec_<base64>`: the key is the base64-decoded remainder.
  const keyB64 = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const key = Buffer.from(keyB64, "base64");
  if (key.length === 0) return false;

  const expected = Buffer.from(
    createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64"),
  );

  // The header is a space-separated list of `v<n>,<sig>` tokens.
  for (const part of sigHeader.split(" ")) {
    const comma = part.indexOf(",");
    if (comma < 0) continue;
    if (part.slice(0, comma) !== "v1") continue;
    const sig = Buffer.from(part.slice(comma + 1));
    if (sig.length === expected.length && timingSafeEqual(sig, expected)) return true;
  }
  return false;
}

/**
 * Extract the Autumn customer id (== the gtm-grid workspace id) from a webhook
 * payload, tolerant of where Autumn nests it. Returns null when none is found.
 */
export function extractCustomerId(payload: unknown): string | null {
  const candidates = [
    (p: Record<string, unknown>) => p.customerId,
    (p: Record<string, unknown>) => p.customer_id,
    (p: Record<string, unknown>) => p.workspaceId,
    (p: Record<string, unknown>) => (p.data as Record<string, unknown> | undefined)?.customerId,
    (p: Record<string, unknown>) => (p.data as Record<string, unknown> | undefined)?.customer_id,
    (p: Record<string, unknown>) =>
      ((p.data as Record<string, unknown> | undefined)?.customer as Record<string, unknown> | undefined)?.id,
    (p: Record<string, unknown>) => (p.customer as Record<string, unknown> | undefined)?.id,
  ];
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  for (const get of candidates) {
    const v = get(p);
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * Which revenue event a reconciled plan implies: a resolved paid plan id means an
 * active/changed subscription; `null` (Free) means it was cancelled / lapsed —
 * the out-of-app revocation we want to surface in Revenue Analytics.
 */
export function revenueEventForPlan(planId: string | null): Extract<
  AnalyticsEventName,
  "subscription_changed" | "subscription_canceled"
> {
  return planId ? "subscription_changed" : "subscription_canceled";
}
