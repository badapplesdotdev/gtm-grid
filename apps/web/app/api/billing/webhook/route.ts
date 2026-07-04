/**
 * Billing webhook — event-driven entitlement reconciliation.
 *
 * Autumn signs each delivery (Svix / "Standard Webhooks": a `whsec_…` secret in
 * `AUTUMN_WEBHOOK_SECRET` + `webhook-id/-timestamp/-signature` headers), so we
 * verify the HMAC over the EXACT raw body before acting. The Autumn customer id IS
 * the gtm-grid workspace id.
 *
 * On any subscription event (subscribe to `billing.updated`) we re-reconcile the
 * workspace's cached plan against the LIVE Autumn subscription via
 * `BillingService.syncPlanFromWebhook` (no member identity — the signature gates
 * it). A cancellation / payment lapse OUTSIDE the app therefore revokes cloud
 * access immediately (no active paid sub → currentPlanId = null →
 * EntitlementService locks the cloud tier), instead of only when the desktop app
 * next re-syncs on open. The resolved plan is emitted as a `subscription_*` event
 * for Revenue Analytics. Always 200s a verified-but-unmappable delivery so Autumn
 * doesn't retry forever on an unknown customer.
 */

import { BillingService } from "@gtmgrid/services";
import { Effect, Exit } from "effect";
import { exitToResponse, workerRuntime } from "../../worker/_lib";
import {
  extractCustomerId,
  lifecycleBillingEmissions,
  revenueEventForPlan,
  verifyWebhookSignature,
} from "../../../../lib/billing-webhook-auth";
import { captureServer } from "../../../../lib/posthog-server";
import { inngest } from "../../../../lib/inngest/client";

export const runtime = "nodejs";

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export async function POST(req: Request): Promise<Response> {
  // Read the RAW body once — the signature is computed over the exact bytes.
  const rawBody = await req.text();
  if (!verifyWebhookSignature(rawBody, req.headers, process.env.AUTUMN_WEBHOOK_SECRET)) {
    return json({ error: "Invalid signature" }, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const workspaceId = extractCustomerId(payload);
  // Verified but no resolvable customer → ack (200) so Autumn stops retrying.
  if (workspaceId === null) return json({ ignored: "no customer id" }, 200);

  const runtime = await workerRuntime();
  const exit = await runtime.runPromiseExit(
    Effect.gen(function* () {
      const svc = yield* BillingService;
      return yield* svc.syncPlanFromWebhook(workspaceId);
    }),
  );

  if (Exit.isSuccess(exit)) {
    const plan = exit.value;
    captureServer(revenueEventForPlan(plan.id), {
      distinctId: workspaceId,
      properties: { workspace_id: workspaceId, plan_id: plan.id ?? "" },
      groups: { workspace: workspaceId },
    });

    // Lifecycle-email triggers (both best-effort): a FIRST paid subscription
    // (receipt #20) and/or a payment failure/past-due (dunning #17). The
    // reconcile above stays authoritative for entitlements; these only drive
    // mail. Decided by a pure helper so the emission rules are unit-pinned.
    for (const emission of lifecycleBillingEmissions(plan, payload)) {
      captureServer(
        emission.event === "billing/subscription.started"
          ? "subscription_started"
          : "subscription_payment_failed",
        {
          distinctId: workspaceId,
          properties: { workspace_id: workspaceId, plan_id: emission.planId ?? "" },
          groups: { workspace: workspaceId },
        },
      );
      await inngest
        .send({
          name: emission.event,
          data: { workspaceId, planId: emission.planId },
        })
        .catch(() => undefined);
    }
    return json({ synced: true, plan }, 200);
  }
  // Typed service failures (workspace/Autumn) → mapped status; defects → 500.
  return exitToResponse(exit);
}
