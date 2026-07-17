/**
 * Token → webhook config, via the secret-gated worker endpoint.
 *
 * Extracted verbatim from `app/api/webhooks/[token]/route.ts` so the Slack
 * Events receiver (`app/api/webhooks/slack/[token]/route.ts`) resolves tokens
 * through exactly the same path. Two receivers hand-rolling the same
 * worker-secret fetch is how they drift — one gets a fix and the other doesn't.
 *
 * Slack differs from the generic receiver ONLY in how a request authenticates
 * (its own `X-Slack-Signature` v0 HMAC, over a global signing secret, rather
 * than our per-webhook `X-GTMGrid-Signature`). Everything downstream — the
 * token, the mapping, the Inngest event — is shared.
 */

import { resolveSiteUrl } from "./site-url";
import type { MappingEntry } from "./webhook-mapping";

/** The resolved webhook config the worker route returns (or `null`). */
export interface ResolvedWebhook {
  readonly webhookId: string;
  readonly workspaceId: string;
  readonly tableId: string;
  readonly mapping: readonly MappingEntry[];
  readonly signingSecret: string | null;
  readonly autoRun: boolean;
  readonly mode: "create" | "upsert";
  readonly upsertKey: string | null;
}

/**
 * Resolve the base URL of the apps/web deployment serving the worker endpoints
 * — `SITE_URL` when configured, else the Vercel-injected deployment URL.
 */
export function workerBaseUrl(): string {
  return resolveSiteUrl();
}

/** Resolve the shared worker bearer secret, failing closed when unset. */
export function workerSecret(): string {
  const secret = process.env.WEBHOOK_WORKER_SECRET;
  if (secret === undefined || secret === "") {
    throw new Error("WEBHOOK_WORKER_SECRET is not configured");
  }
  return secret;
}

/**
 * Resolve a token to its webhook config (or `null`) via the secret-gated
 * endpoint. Unknown AND disabled tokens both resolve to `null`, so callers
 * cannot leak which by returning different errors.
 */
export async function resolveToken(token: string): Promise<ResolvedWebhook | null> {
  const res = await fetch(`${workerBaseUrl()}/api/worker/resolveToken`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${workerSecret()}`,
    },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    throw new Error(`resolveToken failed: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  if (text === "") return null;
  const parsed: unknown = JSON.parse(text);
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
  const res = await fetch(`${workerBaseUrl()}/api/worker/slackTeam`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${workerSecret()}`,
    },
    body: JSON.stringify({ workspaceId }),
  });
  if (!res.ok) {
    throw new Error(`slackTeam failed: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  if (text === "") return null;
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) return null;
  const teamId = Reflect.get(parsed, "teamId");
  return typeof teamId === "string" && teamId !== "" ? teamId : null;
}
