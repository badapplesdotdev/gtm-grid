import { serve } from "inngest/next";
import { inngest } from "../../../lib/inngest/client";
import { processWebhookRecord } from "../../../lib/inngest/functions/process-webhook-record";
import { processPushedRow } from "../../../lib/inngest/functions/process-pushed-row";
import {
  enrichSignalRow,
  pollTrigifySignals,
  processSignalBinding,
  warmUpSignalBinding,
} from "../../../lib/inngest/functions/poll-trigify-signals";
import {
  enrichCrmRow,
  pollCrmSync,
  processCrmBinding,
  warmUpCrmBinding,
} from "../../../lib/inngest/functions/poll-crm-sync";
import { sendTrialReminders } from "../../../lib/inngest/functions/send-trial-reminders";
import { sendWorkspaceWelcome } from "../../../lib/inngest/functions/send-workspace-welcome";
import {
  lifecycleCredentialMissing,
  lifecyclePaymentFailed,
  lifecycleSignalsLanded,
  lifecycleSubscriptionConfirmed,
  lifecycleTeammateJoined,
} from "../../../lib/inngest/functions/lifecycle-events";
import {
  lifecycleActivationStall,
  lifecycleDormant,
  lifecycleTrialWinback,
  lifecycleWeeklyDigest,
} from "../../../lib/inngest/functions/lifecycle-crons";

/**
 * The Inngest serve endpoint. Inngest invokes durable function steps by POSTing
 * here; it also introspects (PUT) and reports (GET) the registered functions.
 * Runs on the Node runtime because the enrichment function uses the engine
 * (which lazily touches Node-only / WASM modules).
 */
export const runtime = "nodejs";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    processWebhookRecord,
    // table.push autoRunTarget — the target's columns run over the pushed row.
    processPushedRow,
    sendTrialReminders,
    sendWorkspaceWelcome,
    pollTrigifySignals,
    processSignalBinding,
    warmUpSignalBinding,
    enrichSignalRow,
    // CRM→grid sync (TRI: crm-sync) — daily cron + manual + warm-up + enrichment.
    pollCrmSync,
    processCrmBinding,
    warmUpCrmBinding,
    enrichCrmRow,
    // Lifecycle emails (#10 #12 #13 #17 #19 #20) — event-driven sends.
    lifecycleTeammateJoined,
    lifecycleSubscriptionConfirmed,
    lifecyclePaymentFailed,
    lifecycleCredentialMissing,
    lifecycleSignalsLanded,
    // Lifecycle emails (#8 #9 #11 #14 #15 #16 #18) — scheduled scans.
    lifecycleActivationStall,
    lifecycleWeeklyDigest,
    lifecycleDormant,
    lifecycleTrialWinback,
  ],
});
