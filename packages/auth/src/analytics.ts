/**
 * Server-side PostHog capture for auth lifecycle events (TRI: signup tracking).
 *
 * Better Auth account creation happens entirely server-side and emits no client
 * event, so without this the only person identification is the desktop client's
 * `posthog.identify` — meaning a signup goes uncaptured whenever that never runs
 * (older build, analytics disabled, the user only ever hit the web/invite flow).
 *
 * This captures `user_signed_up` keyed on the Better Auth `user.id`, which is the
 * EXACT string the desktop later passes to `posthog.identify(me.user._id, …)`
 * (verified: `me.user._id` IS the Better Auth session user id, no transform). So
 * the server event and every later client event resolve to ONE identified person.
 * The `$set` payload writes the person's email/name immediately.
 *
 * Self-contained `posthog-node` client (not apps/web's `posthog-server.ts`, which
 * would be an upward dependency): a missing token => analytics OFF and every call
 * no-ops, so OSS/local builds and tests run untouched.
 */
import type { AnalyticsEventName } from "@gtmgrid/analytics";
import { PostHog } from "posthog-node";

const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;

let client: PostHog | null = null;

function getClient(): PostHog | null {
  if (!token) return null;
  if (!client) {
    client = new PostHog(token, {
      host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
      // Serverless/short-lived: flush each event immediately so nothing is lost
      // when the function suspends (we also `await flush()` per capture below).
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return client;
}

/** Discriminate the signup channel from the Better Auth account row. */
function signupMethod(account?: { providerId?: string | null }): "password" | "oauth" | "unknown" {
  if (!account?.providerId) return "unknown";
  return account.providerId === "credential" ? "password" : "oauth";
}

/**
 * Record a brand-new account as an identified PostHog person. Fire-and-forget but
 * awaited-to-flush (serverless can suspend before a background flush lands), and
 * guarded so a telemetry failure can never break account creation.
 */
export async function captureUserSignedUp(user: {
  id: string;
  email?: string | null;
  name?: string | null;
  account?: { providerId?: string | null };
}): Promise<void> {
  const ph = getClient();
  if (!ph) return;
  const event: AnalyticsEventName = "user_signed_up";
  try {
    ph.capture({
      distinctId: user.id,
      event,
      properties: {
        method: signupMethod(user.account),
        // `$set` writes person properties, so the person shows email/name in
        // PostHog the moment they sign up (no wait for the client identify).
        $set: {
          email: user.email ?? undefined,
          name: user.name ?? undefined,
        },
      },
    });
    await ph.flush();
  } catch {
    // Telemetry must never break signup — swallow and move on.
  }
}
