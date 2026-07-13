import { captureServerException } from "../posthog-server";

/**
 * Shared Inngest `onFailure` handler — fires once after a durable function's
 * retries are exhausted, forwarding the final error to PostHog Error Tracking.
 * Spread into a `createFunction` config: `{ id, retries, onFailure }`.
 */
export async function onFailure(args: {
  error: unknown;
  event?: { name?: string };
}): Promise<void> {
  captureServerException(args.error, {
    properties: { source: "inngest", trigger: args.event?.name },
  });
}
