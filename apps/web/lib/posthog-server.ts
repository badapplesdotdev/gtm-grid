import { PostHog } from "posthog-node";

// Read once at module load. A missing token means analytics are OFF — every
// `getPostHogClient()` returns null and callers no-op via `?.`, so a request is
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

export async function shutdownPostHog(): Promise<void> {
  if (posthogClient) {
    await posthogClient.shutdown();
  }
}
