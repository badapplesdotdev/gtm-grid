/**
 * Signed unsubscribe tokens for lifecycle emails.
 *
 * The footer "Unsubscribe" link must work WITHOUT a session (email clients open
 * a cold browser), so the link carries a compact HMAC-signed token binding
 * (userId, category). No expiry on purpose — an unsubscribe link in a year-old
 * email should still work (CAN-SPAM expects a working opt-out).
 *
 * Format: base64url(`${userId}\n${category}`) + "." + base64url(hmacSha256(payload)).
 * Secret: `EMAIL_UNSUBSCRIBE_SECRET`, falling back to `BETTER_AUTH_SECRET` so no
 * new secret is required to ship. Missing both → token helpers return null and
 * the send-guard omits the unsubscribe affordance (and refuses non-transactional
 * sends, see send-guard.ts).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { LifecycleCategory } from "@gtmgrid/services";

function secret(): string | null {
  return (
    process.env.EMAIL_UNSUBSCRIBE_SECRET ?? process.env.BETTER_AUTH_SECRET ?? null
  );
}

function sign(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function mintUnsubscribeToken(
  userId: string,
  category: LifecycleCategory,
): string | null {
  const key = secret();
  if (!key) return null;
  const payload = `${userId}\n${category}`;
  const body = Buffer.from(payload, "utf8").toString("base64url");
  return `${body}.${sign(payload, key)}`;
}

export interface UnsubscribeClaims {
  readonly userId: string;
  readonly category: LifecycleCategory;
}

const CATEGORIES: readonly LifecycleCategory[] = ["activation", "status", "digest"];

export function verifyUnsubscribeToken(token: string): UnsubscribeClaims | null {
  const key = secret();
  if (!key) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const payload = Buffer.from(body, "base64url").toString("utf8");
  const expected = sign(payload, key);
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(expected);
  if (macBuf.length !== expBuf.length || !timingSafeEqual(macBuf, expBuf)) {
    return null;
  }
  const [userId, category] = payload.split("\n");
  if (!userId || !CATEGORIES.includes(category as LifecycleCategory)) return null;
  return { userId, category: category as LifecycleCategory };
}

/** Absolute unsubscribe URL for a user+category, or null when unsigned. */
export function unsubscribeUrl(
  userId: string,
  category: LifecycleCategory,
): string | null {
  const token = mintUnsubscribeToken(userId, category);
  if (!token) return null;
  const origin = process.env.SITE_URL ?? "https://www.gtmgrid.dev";
  return `${origin}/email/unsubscribe?token=${encodeURIComponent(token)}`;
}
