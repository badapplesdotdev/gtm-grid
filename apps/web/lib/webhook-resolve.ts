/**
 * Token → webhook config, and the Slack tenant lookup, over the secret-gated
 * worker endpoints.
 *
 * Extracted from `app/api/webhooks/[token]/route.ts` so the Slack Events
 * receiver (`app/api/webhooks/slack/[token]/route.ts`) resolves tokens through
 * exactly the same path. Two receivers hand-rolling the same worker-secret fetch
 * is how they drift — one gets a fix and the other doesn't.
 *
 * That argument did not go far enough on the first pass. This module was
 * extracted VERBATIM, which duplicated `workerBaseUrl`/`workerSecret`/the
 * bearer-POST that `lib/inngest/worker-client.ts` already had — so it fixed the
 * drift between the two RECEIVERS while creating the same drift, of the same
 * auth contract, between the receivers and the engine's store client. The HTTP
 * half now lives once in `lib/worker-call.ts`; what remains here is the part
 * that is genuinely webhook-specific: the response SHAPE.
 *
 * Slack differs from the generic receiver ONLY in how a request authenticates
 * (its own `X-Slack-Signature` v0 HMAC, over a global signing secret, rather
 * than our per-webhook `X-GTMGrid-Signature`). Everything downstream — the
 * token, the mapping, the Inngest event — is shared.
 */

import { callWorker } from "./worker-call";
import type { MappingEntry } from "./webhook-mapping";

/** The resolved webhook config the worker route returns (or `null`). */
export interface ResolvedWebhook {
  readonly webhookId: string;
  readonly workspaceId: string;
  readonly tableId: string;
  readonly mapping: readonly MappingEntry[];
  /**
   * The PER-WEBHOOK `X-GTMGrid-Signature` secret. Opt-in, and consulted ONLY by
   * the generic receiver — the Slack ingress cannot honour it (Slack signs with
   * its own scheme and has never seen this secret) and does not need to (it
   * authenticates via Slack's v0 HMAC + the tenant gate). See the Slack route's
   * header for why that is deliberate rather than an oversight.
   */
  readonly signingSecret: string | null;
  readonly autoRun: boolean;
  readonly mode: "create" | "upsert";
  readonly upsertKey: string | null;
}

/**
 * Resolve a token to its webhook config (or `null`) via the secret-gated
 * endpoint. Unknown AND disabled tokens both resolve to `null`, so callers
 * cannot leak which by returning different errors.
 */
export async function resolveToken(token: string): Promise<ResolvedWebhook | null> {
  const parsed = await callWorker("/api/worker/resolveToken", { token });
  return parsed === null ? null : (parsed as ResolvedWebhook);
}


/**
 * The Slack team a workspace is connected to, or `null`.
 *
 * The Events receiver's TENANT GATE. Slack delivers every installation of an app
 * to ONE app-global Request URL, signed with ONE app-global signing secret, so a
 * valid v0 signature proves only that Slack sent the request on behalf of this
 * APP — never that it came from the workspace whose webhook the URL names.
 * Anyone who installs the app into their own Slack workspace would otherwise
 * have their messages inserted as rows into that tenant's table (and, with
 * auto-run, spend that tenant's cloud actions enriching attacker-controlled
 * input).
 */
export async function slackTeamForWorkspace(workspaceId: string): Promise<string | null> {
  const parsed = await callWorker("/api/worker/slackTeam", { workspaceId });
  if (typeof parsed !== "object" || parsed === null) return null;
  const teamId = Reflect.get(parsed, "teamId");
  return typeof teamId === "string" && teamId !== "" ? teamId : null;
}
