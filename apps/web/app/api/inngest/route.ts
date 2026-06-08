import { serve } from "inngest/next";
import { inngest } from "../../../lib/inngest/client";
import { processWebhookRecord } from "../../../lib/inngest/functions/process-webhook-record";
import { sendTrialReminders } from "../../../lib/inngest/functions/send-trial-reminders";

/**
 * The Inngest serve endpoint. Inngest invokes durable function steps by POSTing
 * here; it also introspects (PUT) and reports (GET) the registered functions.
 * Runs on the Node runtime because the enrichment function uses the engine
 * (which lazily touches Node-only / WASM modules).
 */
export const runtime = "nodejs";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [processWebhookRecord, sendTrialReminders],
});
