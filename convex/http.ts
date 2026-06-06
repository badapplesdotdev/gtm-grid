/**
 * Convex HTTP router (T3 + webhooks worker boundary).
 *
 * `auth.addHttpRoutes(http)` registers the Convex Auth HTTP endpoints
 * (`/api/auth/*`) the client uses for sign-in / sign-out / OAuth callbacks.
 *
 * The `/webhook/*` routes are the SECRET-GATED boundary for the headless webhook
 * worker (apps/inngest). The worker is NOT a member and carries no Convex Auth
 * session, so these routes authenticate it with a shared bearer secret
 * (`WEBHOOK_WORKER_SECRET`) compared in CONSTANT TIME, then dispatch into the
 * `internal.webhooks.*` / `internal.credentials.*` worker functions via
 * `runQuery` / `runMutation` / `runAction`. The internal functions are NOT
 * publicly callable; this bearer is their ONLY ingress. A missing/incorrect
 * bearer returns 401 before any internal function runs.
 */

import { httpRouter } from "convex/server";
import { auth } from "./auth.js";
import { internal } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";

const http = httpRouter();

auth.addHttpRoutes(http);

/**
 * Constant-time string compare to avoid leaking the secret via response timing.
 * Returns false fast only on a length mismatch (length is not the secret); for
 * equal-length inputs every byte is compared regardless of where they diverge.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Validate the `Authorization: Bearer <secret>` header against
 * `WEBHOOK_WORKER_SECRET`. Returns true only when the env secret is configured
 * AND the bearer matches it in constant time. Fail-closed: an unset env secret
 * rejects everything (the worker boundary is never open by default).
 */
function isAuthorizedWorker(req: Request): boolean {
  const expected = process.env.WEBHOOK_WORKER_SECRET;
  if (expected === undefined || expected === "") return false;
  const header = req.headers.get("Authorization");
  if (header === null) return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const token = header.slice(prefix.length);
  return timingSafeEqual(token, expected);
}

const unauthorized = (): Response =>
  new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** Resolve a webhook token to its (enabled) webhook. */
http.route({
  path: "/webhook/resolveToken",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!isAuthorizedWorker(req)) return unauthorized();
    const { token } = await req.json();
    const result = await ctx.runQuery(internal.webhooks.resolveWebhookToken, {
      token,
    });
    return ok(result);
  }),
});

/** Insert one received record as a row + cells (metered once per record). */
http.route({
  path: "/webhook/insertRow",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!isAuthorizedWorker(req)) return unauthorized();
    const { webhookId, cells } = await req.json();
    const result = await ctx.runMutation(internal.webhooks.insertWebhookRow, {
      webhookId,
      cells,
    });
    return ok(result);
  }),
});

/**
 * Upsert one received record: match an existing row server-side on the upsert
 * key, then patch-or-insert its cells (metered once per record — never per
 * cell). Mirrors /webhook/insertRow's secret gate + dispatch.
 */
http.route({
  path: "/webhook/upsertRow",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!isAuthorizedWorker(req)) return unauthorized();
    const { webhookId, upsertKey, cells } = await req.json();
    const result = await ctx.runMutation(internal.webhooks.upsertWebhookRow, {
      webhookId,
      upsertKey,
      cells,
    });
    return ok(result);
  }),
});

/** Fetch a table's full grid (same shape as tables.getTable) for the worker. */
http.route({
  path: "/webhook/getTable",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!isAuthorizedWorker(req)) return unauthorized();
    const { tableId } = await req.json();
    const result = await ctx.runQuery(internal.webhooks.getTableForWorker, {
      tableId,
    });
    return ok(result);
  }),
});

/** Upsert a cell (COALESCE merge; meters only on terminal status). */
http.route({
  path: "/webhook/setCell",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!isAuthorizedWorker(req)) return unauthorized();
    const args = await req.json();
    const result = await ctx.runMutation(
      internal.webhooks.setCellFromWorker,
      args,
    );
    return ok(result);
  }),
});

/** Set a cell's status only (meters only on terminal status). */
http.route({
  path: "/webhook/setCellStatus",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!isAuthorizedWorker(req)) return unauthorized();
    const args = await req.json();
    const result = await ctx.runMutation(
      internal.webhooks.setCellStatusFromWorker,
      args,
    );
    return ok(result);
  }),
});

/** Decrypt a workspace-scope connector secret for the worker (Node action). */
http.route({
  path: "/webhook/getCredential",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!isAuthorizedWorker(req)) return unauthorized();
    const { workspaceId, extensionId } = await req.json();
    const result = await ctx.runAction(
      internal.credentials.getCredentialForWorker,
      { workspaceId, extensionId },
    );
    return ok(result);
  }),
});

export default http;
