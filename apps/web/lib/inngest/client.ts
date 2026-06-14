import { Inngest } from "inngest";

/**
 * The single Inngest client for the GTM Grid worker app. The receiver route
 * (`app/api/webhooks/[token]/route.ts`) calls `inngest.send(...)` to enqueue a
 * `webhook/record.received` event, and the serve route
 * (`app/api/inngest/route.ts`) registers the durable functions that consume it.
 *
 * In production Inngest reads `INNGEST_EVENT_KEY` (to send) and
 * `INNGEST_SIGNING_KEY` (to verify the serve endpoint) from the environment; in
 * local dev the Inngest dev server supplies them, so no keys are needed here.
 *
 * Durable-function error tracking is wired per-function via the shared
 * `onFailure` handler in `./on-failure.ts` (fires once after retries are
 * exhausted) → PostHog Error Tracking.
 */
export const inngest = new Inngest({ id: "gtmgrid" });
