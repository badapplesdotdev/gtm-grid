/**
 * The ONE way to call a secret-gated `/api/worker/*` endpoint.
 *
 * The `/api/worker/*` routes are the headless boundary: they have no member
 * session, so they authenticate the caller with a shared
 * `Bearer WEBHOOK_WORKER_SECRET` (verified server-side by `isAuthorizedWorker` in
 * `@gtmgrid/services`). This module owns the CLIENT half of that contract —
 * where the base URL comes from, how the secret is read, how it is attached, and
 * what a non-2xx or an empty body mean.
 *
 * It exists because that contract had been written out twice, byte for byte:
 * once in `lib/inngest/worker-client.ts` (the engine's `CloudClientLike`) and
 * once in `lib/webhook-resolve.ts` (the webhook receivers' `resolveToken`). Two
 * copies of an AUTH contract is the kind of duplication that rots quietly — the
 * day one grows a retry, a timeout, a header, or a redaction rule, the other
 * silently doesn't, and the failure surfaces as "the Slack webhook is flaky" a
 * long way from the edit.
 *
 * Neither caller imports the other: the receiver has no business importing the
 * engine's store client, and the store client has no business importing webhook
 * plumbing. They share this instead.
 */

import { resolveSiteUrl } from "./site-url";

/**
 * Resolve the shared worker bearer secret, failing closed when unset.
 *
 * Throwing (rather than sending an empty bearer) is deliberate: an unset secret
 * is an operator misconfiguration, and a request that silently omits its
 * credential would come back as a confusing 401 from our own worker route.
 */
function workerSecret(): string {
  const secret = process.env.WEBHOOK_WORKER_SECRET;
  if (secret === undefined || secret === "") {
    throw new Error("WEBHOOK_WORKER_SECRET is not configured");
  }
  return secret;
}

/**
 * POST `args` to an `/api/worker/*` route and return the parsed JSON body.
 *
 * The base URL is `resolveSiteUrl()` — the worker routes live in the SAME
 * Next.js deployment as every caller, so there is no separate host to configure.
 * (Both copies of this used to wrap that call in a one-line `workerBaseUrl()`
 * that added nothing.)
 *
 * A non-2xx THROWS: every caller treats a worker fault as exceptional, and none
 * can act on a partial result. An EMPTY body returns `null` rather than throwing
 * on `JSON.parse("")` — the routes use an empty response to mean "no such thing"
 * (e.g. an unknown webhook token), which is a normal answer, not a fault.
 */
export async function callWorker(
  route: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${resolveSiteUrl()}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${workerSecret()}`,
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Worker route ${route} failed: ${res.status} ${res.statusText} ${text}`.trim(),
    );
  }
  const text = await res.text();
  return text === "" ? null : JSON.parse(text);
}
