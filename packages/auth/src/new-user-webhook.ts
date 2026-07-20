/**
 * Outbound "new user" webhook for auth lifecycle events.
 *
 * Better Auth account creation happens entirely server-side, so external
 * consumers (CRM sync, onboarding automation) get no signal without a
 * server-side push. This POSTs the full new-user record as JSON to
 * `NEW_USER_WEBHOOK_URL` from the `user.create.after` database hook — which
 * fires exactly once per new account, for password AND OAuth signups alike.
 *
 * Unset `NEW_USER_WEBHOOK_URL` => webhook OFF and every call no-ops, so
 * OSS/local builds and tests run untouched. The request is time-boxed and the
 * whole call is guarded: a slow, down, or erroring webhook endpoint can never
 * break account creation.
 */

/** Hard cap on how long sign-up will wait for the webhook endpoint. */
const WEBHOOK_TIMEOUT_MS = 5_000;

/** The Better Auth user row fields we forward (packages/db users table). */
export interface NewUserWebhookUser {
  id: string;
  name?: string | null;
  email: string;
  emailVerified?: boolean;
  image?: string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

/** Normalize Date fields to ISO strings so the JSON payload is stable. */
function iso(value: Date | string | undefined): string | null {
  if (value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * POST the new user's details to the configured webhook. Awaited by the caller
 * (serverless can suspend before a background request lands) but never throws —
 * failures are logged and swallowed so signup always succeeds.
 */
export async function sendNewUserWebhook(
  user: NewUserWebhookUser,
): Promise<void> {
  const url = process.env.NEW_USER_WEBHOOK_URL;
  if (url === undefined || url === "") return;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "user.created",
        user: {
          id: user.id,
          name: user.name ?? null,
          email: user.email,
          emailVerified: user.emailVerified ?? false,
          image: user.image ?? null,
          createdAt: iso(user.createdAt),
          updatedAt: iso(user.updatedAt),
        },
      }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(
        `[auth] new-user webhook responded ${response.status} for user ${user.id}`,
      );
    }
  } catch (error) {
    // The webhook must never break signup — log and move on.
    console.error("[auth] new-user webhook failed:", error);
  }
}
