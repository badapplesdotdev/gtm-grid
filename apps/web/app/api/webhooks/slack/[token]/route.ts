import {
  readSlackRequest,
  resolveSlackSigningSecret,
  slackRecordId,
  slackRecordPayload,
} from "@gtmgrid/services";
import { Effect, Exit } from "effect";
import { inngest } from "../../../../../lib/inngest/client";
import { captureServer } from "../../../../../lib/posthog-server";
import { clientIp, rateLimit } from "../../../../../lib/rate-limit";
import { applyMapping } from "../../../../../lib/webhook-mapping";
import { resolveToken, slackTeamForWorkspace } from "../../../../../lib/webhook-resolve";

/**
 * The Slack Events API receiver. Slack POSTs an event envelope to
 * `/api/webhooks/slack/<token>`; this route:
 *
 *  1. Rate limits per token+IP before any work.
 *  2. Reads the RAW body and verifies Slack's `X-Slack-Signature` — a v0 HMAC
 *     over `v0:{timestamp}:{raw body}` — plus a 5-minute replay window.
 *  3. Answers the `url_verification` challenge, without which the endpoint can
 *     never be saved in the Slack app config.
 *  4. Resolves the token, maps the flattened message onto the webhook's stored
 *     field mapping, and enqueues the SAME `webhook/record.received` event the
 *     generic receiver uses — so `processWebhookRecord` is reused untouched.
 *
 * WHY A SIBLING ROUTE, not a branch inside `[token]/route.ts`: only step 2
 * differs, but it differs completely. Slack signs with its OWN scheme over a
 * GLOBAL signing secret (`SLACK_SIGNING_SECRET`), whereas the generic receiver
 * uses our `X-GTMGrid-Signature` over a PER-WEBHOOK secret that is opt-in. A
 * flag threaded through one handler would put two authentication schemes behind
 * one `if`, in the exact code path where a mistake means accepting forged
 * events. Everything downstream is shared via `lib/webhook-resolve` +
 * `applyMapping`.
 *
 * ACK FAST: Slack retries any non-2xx (up to 3 times) and disables endpoints
 * that keep failing, so the durable work happens in Inngest and this returns
 * immediately.
 *
 * Node runtime: uses `node:crypto` for HMAC verification.
 */
export const runtime = "nodejs";

const json = (body: unknown, status: number, extraHeaders?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });

export async function POST(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;

  const limit = rateLimit(`slack-webhook:${token}:${clientIp(req)}`, 120, 60_000);
  if (!limit.ok) {
    return json({ error: "Too many requests" }, 429, { "Retry-After": String(limit.retryAfter) });
  }

  // The RAW bytes, read once. Slack's signature covers exactly what was sent —
  // parsing and re-stringifying would change the bytes and fail every request.
  const rawBody = await req.text();

  const secretExit = await Effect.runPromiseExit(resolveSlackSigningSecret());
  if (Exit.isFailure(secretExit)) {
    // Misconfiguration on OUR side, not a bad request: 500, and never 200,
    // because a 200 would tell Slack the event was handled and drop it.
    return json({ error: "Slack signing secret is not configured" }, 500);
  }

  // Verify BEFORE trusting a single byte of the body — including for the
  // url_verification handshake, which Slack also signs.
  const parsed = await Effect.runPromiseExit(
    readSlackRequest({
      rawBody,
      headers: {
        signature: req.headers.get("X-Slack-Signature"),
        timestamp: req.headers.get("X-Slack-Request-Timestamp"),
      },
      signingSecret: secretExit.value,
      nowMs: Date.now(),
    }),
  );
  if (Exit.isFailure(parsed)) {
    // One opaque response for a bad signature, a stale timestamp, and a
    // malformed body alike: distinguishing them tells a prober which of the
    // three they got wrong.
    return json({ error: "Unauthorized" }, 401);
  }

  const request = parsed.value;

  // Answer the handshake before resolving the token: it proves URL ownership at
  // configure time and carries no event to route.
  if (request.kind === "url_verification") {
    return json({ challenge: request.challenge }, 200);
  }

  // Anything we don't map (reactions, bot echoes, joins) is ACKed, not errored —
  // Slack would retry a non-2xx and eventually disable the endpoint.
  if (request.kind === "ignored") {
    return json({ ok: true, ignored: request.reason }, 200);
  }

  const webhook = await resolveToken(token);
  if (webhook === null) {
    return json({ error: "Not found" }, 404);
  }

  // ── TENANT GATE ───────────────────────────────────────────────────────────
  // The v0 signature above proves the request came from Slack on behalf of this
  // APP — it does NOT prove which Slack workspace it came from. The signing
  // secret and the Events Request URL are app-global, not per-installation, so
  // events from EVERY workspace that installed the app arrive here, all validly
  // signed. Without this check, anyone who installs the app into their own Slack
  // workspace gets their messages inserted as rows into whichever tenant's
  // webhook the URL names — and with auto-run, enriched at that tenant's expense
  // on attacker-controlled input.
  //
  // Fails CLOSED: no connection, no stored team, or an unreadable one all drop.
  const expectedTeam = await slackTeamForWorkspace(webhook.workspaceId);
  if (expectedTeam === null || request.record.team !== expectedTeam) {
    // ACK 200, not 4xx: Slack retries a non-2xx and eventually disables the
    // endpoint, and a foreign team's events are not this endpoint's business to
    // complain about. The response says nothing about which case it was.
    return json({ ok: true, ignored: "team-mismatch" }, 200);
  }

  const payload = slackRecordPayload(request.record);
  const mappedCells = applyMapping(payload, webhook.mapping, Date.now());

  // Keyed on Slack's event_id, NOT a body hash: Slack's retries reuse the
  // event_id but carry a fresh timestamp and signature, so hashing the body
  // would mint a new id per retry and double-insert the row.
  const recordId = slackRecordId(token, request.record.eventId ?? rawBody);

  await inngest.send({
    id: recordId,
    name: "webhook/record.received",
    data: {
      webhookId: webhook.webhookId,
      tableId: webhook.tableId,
      workspaceId: webhook.workspaceId,
      mappedCells,
      autoRun: webhook.autoRun,
      mode: webhook.mode,
      upsertKey: webhook.upsertKey,
      recordId,
    },
  });

  captureServer("webhook_received", {
    distinctId: webhook.workspaceId,
    properties: {
      webhook_id: webhook.webhookId,
      workspace_id: webhook.workspaceId,
      table_id: webhook.tableId,
      auto_run: webhook.autoRun,
      mode: webhook.mode,
      source: "slack",
    },
    groups: { workspace: webhook.workspaceId },
  });

  return json({ ok: true, recordId }, 200);
}
