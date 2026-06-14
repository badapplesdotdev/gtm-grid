/**
 * Billing webhook — event-driven entitlement reconciliation.
 *
 * Autumn owns the Stripe connection and ships no webhook-emission/verification
 * SDK, so this is a SECRET-GATED callback (shared `AUTUMN_WEBHOOK_SECRET` bearer,
 * the trust boundary — same model as the `/api/worker/*` routes): configure Autumn
 * (or a Stripe→relay) to POST a subscription event here. The Autumn customer id IS
 * the gtm-grid workspace id, so the body carries `{ customerId | workspaceId }`.
 *
 * On any event we re-reconcile the workspace's cached plan against the LIVE Autumn
 * subscription via `BillingService.syncPlanFromWebhook` (no member identity — the
 * secret gates it). A cancellation / payment lapse OUTSIDE the app therefore
 * revokes cloud access immediately (no active paid sub → currentPlanId = null →
 * EntitlementService locks the cloud tier), instead of only when the desktop app
 * next re-syncs on open. The resolved plan is emitted as a `subscription_*` event
 * for Revenue Analytics.
 */

import { BillingService } from "@gtmgrid/services";
import { Effect, Exit } from "effect";
import { z } from "zod";
import { exitToResponse, workerRuntime } from "../../worker/_lib";
import { isAuthorizedBillingWebhook, revenueEventForPlan } from "../../../../lib/billing-webhook-auth";
import { captureServer } from "../../../../lib/posthog-server";

export const runtime = "nodejs";

const BodySchema = z
  .object({
    // Autumn customer id == workspace id; accept either key.
    customerId: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    type: z.string().optional(),
  })
  .refine((b) => Boolean(b.customerId ?? b.workspaceId), {
    message: "customerId (or workspaceId) is required",
  });

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export async function POST(req: Request): Promise<Response> {
  if (!isAuthorizedBillingWebhook(req)) return json({ error: "Unauthorized" }, 401);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return json({ error: `Invalid request body: ${parsed.error.issues.map((i) => i.message).join("; ")}` }, 400);
  }
  const workspaceId = (parsed.data.workspaceId ?? parsed.data.customerId) as string;

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
    return json({ synced: true, plan }, 200);
  }
  // Typed service failures (workspace/Autumn) → mapped status; defects → 500.
  return exitToResponse(exit);
}
