import type { AnalyticsEventName, AnalyticsEventProps } from "@gtmgrid/analytics";
import { PostHog } from "posthog-node";

// Read once at module load. A missing token means analytics are OFF — every
// `getPostHogClient()` returns null and the helpers below no-op, so a request is
// never crashed by absent telemetry config (the previous `!` assertion threw).
const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;

let posthogClient: PostHog | null = null;

export function getPostHogClient(): PostHog | null {
  if (!token) return null;
  if (!posthogClient) {
    posthogClient = new PostHog(token, {
      host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
      // Serverless/short-lived: flush each event immediately so nothing is lost
      // when the function suspends.
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return posthogClient;
}

/**
 * Typed server-side event capture against the shared {@link AnalyticsEventName}
 * catalog — a wrong event name or payload is a compile error. No-ops when PostHog
 * is unconfigured. Pass `groups: { workspace: id }` for workspace (account)
 * analytics.
 */
export function captureServer<E extends AnalyticsEventName>(
  event: E,
  opts: {
    distinctId: string;
    properties?: AnalyticsEventProps<E>;
    groups?: Record<string, string>;
  },
): void {
  getPostHogClient()?.capture({
    distinctId: opts.distinctId,
    event,
    properties: opts.properties,
    groups: opts.groups,
  });
}

/**
 * Server-side exception capture feeding PostHog Error Tracking. No-ops when
 * unconfigured. Normalizes non-Error throwables so stack traces and grouping work.
 */
export function captureServerException(
  error: unknown,
  opts?: { distinctId?: string; properties?: Record<string, unknown> },
): void {
  const client = getPostHogClient();
  if (!client) return;
  const err =
    error instanceof Error
      ? error
      : new Error(typeof error === "string" ? error : JSON.stringify(error));
  client.captureException(err, opts?.distinctId, opts?.properties);
}

export async function shutdownPostHog(): Promise<void> {
  if (posthogClient) {
    await posthogClient.shutdown();
  }
}
