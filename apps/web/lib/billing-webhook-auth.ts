import { timingSafeEqual } from "node:crypto";
import type { AnalyticsEventName } from "@gtmgrid/analytics";

/**
 * Constant-time bearer check for the Autumn/Stripe billing webhook. The shared
 * `AUTUMN_WEBHOOK_SECRET` is the trust boundary (the webhook has no session), so
 * the upstream must present `Authorization: Bearer <AUTUMN_WEBHOOK_SECRET>`.
 *
 * Fail-closed: an UNSET secret rejects everything (a missing secret must never
 * accidentally accept unauthenticated callers). Pure + exported for unit testing.
 */
export function isAuthorizedBillingWebhook(req: Request): boolean {
  const secret = process.env.AUTUMN_WEBHOOK_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const provided = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(secret);
  // timingSafeEqual throws on length mismatch — compare lengths first (the length
  // itself isn't secret).
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
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
