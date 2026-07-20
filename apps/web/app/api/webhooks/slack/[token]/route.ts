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
import { resolveToken, slackTeamsForWorkspace } from "../../../../../lib/webhook-resolve";

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
 * `webhook.signingSecret` IS DELIBERATELY NOT CONSULTED HERE — the one thing
 * about this route most likely to read as an oversight, so, explicitly:
 *
 *   - It is UNSATISFIABLE, not merely unchecked. That secret gates
 *     `hex(HMAC-SHA256(<per-webhook secret>, body))` on `X-GTMGrid-Signature`.
 *     Slack has never heard of that secret and signs with its own scheme, so no
 *     genuine Slack event can ever carry it. Enforcing it here would not harden
 *     the route; it would make "Require signed requests" mean "silently disable
 *     Slack" — a footgun in a toggle whose copy says nothing about Slack.
 *   - It gates the ANONYMOUS ingress, and this ingress is not anonymous. On
 *     `[token]/route.ts` with no secret set, the token IS the whole credential:
 *     anyone who learns the URL can post. The secret is what upgrades that to
 *     "prove you hold the secret too". Requests HERE have already proven they
 *     came from Slack (v0 HMAC, replay-windowed) on behalf of a team the
 *     workspace is connected to (the tenant gate below). Different authority,
 *     not weaker — there is no unsigned path to close.
 *   - No privilege boundary is crossed. Slack takes ONE Request URL per app,
 *     set by the app's owner, so the only party who can aim Slack at a token is
 *     the party that owns the app and the webhook.
 *
 * Cross-cutting policy that SHOULD bind both ingresses belongs upstream in
 * `WebhookService.resolveToken`, where `source === "push"` and the cloud-access
 * gate already live — not re-derived per route. Pinned by
 * "a webhook WITH a per-webhook signing secret still accepts Slack events".
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

  // Anything we don't map (reactions, bot echoes, joins) is ACKed, not errored —
  // Slack would retry a non-2xx and eventually disable the endpoint. Checked
  // BEFORE the token resolve: these are the high-volume traffic on a busy
  // workspace and none of them need a webhook, so they must not each cost a
  // round trip to the worker endpoint.
  if (request.kind === "ignored") {
    return json({ ok: true, ignored: request.reason }, 200);
  }

  const webhook = await resolveToken(token);
  if (webhook === null) {
    return json({ error: "Not found" }, 404);
  }

  // Answer the handshake only for a token that actually resolves.
  //
  // This is the ONE moment the operator gets synchronous feedback: Slack refuses
  // to save a Request URL whose challenge is not echoed, and shows the error
  // right there in the app config. Echoing for ANY token meant a typo'd, revoked,
  // disabled or push-source token saved cleanly and then 404'd every real event —
  // a silent failure surfacing days later as "Slack just doesn't work", with
  // Slack eventually disabling the endpoint on its own.
  //
  // The signature checked above proves the request came from Slack for this APP.
  // It says NOTHING about whether this token names a real webhook — those are
  // different claims, and answering the challenge on the strength of the first
  // one asserts the second. `resolveToken` collapses unknown / disabled / push /
  // lapsed-workspace to one `null`, so this 404 leaks no more than the generic
  // receiver's does. Rejecting here is also correct for the last three: a Slack
  // URL pointed at a disabled or push-fed connection should fail at configure
  // time, not deliver into a table that will never accept it.
  if (request.kind === "url_verification") {
    return json({ challenge: request.challenge }, 200);
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
  // Fails CLOSED: no connection, no stored team, or an unreadable one all
  // yield an EMPTY list, and `[].includes(...)` is false — so the drop is the
  // default, not a case someone has to remember to write.
  const connectedTeams = await slackTeamsForWorkspace(webhook.workspaceId);
  if (!connectedTeams.includes(request.record.team)) {
    // ACK 200, not 4xx: Slack retries a non-2xx and eventually disables the
    // endpoint, and a foreign team's events are not this endpoint's business to
    // complain about. The response says nothing about which case it was.
    return json({ ok: true, ignored: "team-mismatch" }, 200);
  }

  const payload = slackRecordPayload(request.record);
  const mappedCells = applyMapping(payload, webhook.mapping, Date.now());

  // Keyed on Slack's event_id, NOT a body hash: Slack's retries reuse the
  // event_id but carry a fresh timestamp and signature, so hashing the body
  // would mint a new id per retry and double-insert the row. `eventId` is
  // non-optional precisely because an envelope without one cannot be de-duped —
  // `classifySlackBody` rejects those rather than let them through unkeyed.
  const recordId = slackRecordId(token, request.record.eventId);

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
