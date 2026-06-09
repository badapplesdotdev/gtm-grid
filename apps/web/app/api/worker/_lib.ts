/**
 * Shared helpers for the headless webhook WORKER endpoints
 * (`apps/web/app/api/worker/**`) — the Next.js route handlers that REPLACE the
 * Convex `convex/http.ts` `/webhook/*` boundary.
 *
 * Every worker route:
 *   1. Authenticates with the SAME `WEBHOOK_WORKER_SECRET` constant-time bearer
 *      as the Convex source (`isAuthorizedWorker`, ported from http.ts:31,46) —
 *      the worker is NOT a member and carries no session, so the shared secret is
 *      the trust boundary. A missing/incorrect bearer returns 401 BEFORE any
 *      service runs. Fail-closed: an unset env secret rejects everything.
 *   2. Runs a `WebhookService` Effect against a runtime built from `appLayer`
 *      with `userId: null` (the worker has no member identity; the secret, not
 *      membership, gates these routes), then returns the result as JSON.
 *
 * `runtime = "nodejs"` (declared per route) because the credential decrypt path
 * uses `node:crypto`.
 */

import { type AppServices, appLayer, isAuthorizedWorker } from "@gtmgrid/services";
import { Cause, type Effect, Exit, ManagedRuntime } from "effect";

/**
 * The worker's shared {@link ManagedRuntime}, built lazily ONCE on the first
 * request and reused across every subsequent POST (M5). The underlying
 * connection pool is already module-shared, so constructing + disposing a fresh
 * runtime per request was pure overhead (runtime build + dispose) and GC churn
 * — a 10k-row run drove ~20k POSTs, each paying that cost. We therefore cache
 * the runtime (and the dynamically-imported db client it wraps) at module scope
 * and NEVER dispose it per request: the Node serverless instance owns it for its
 * whole lifetime, exactly as the pool is owned.
 *
 * Kept as a module-scoped promise so concurrent first requests share one build
 * (the import + `ManagedRuntime.make` happen once) rather than racing to make
 * several runtimes. `appLayer` is invoked with `userId: null` because the worker
 * carries no member identity — the shared secret, not membership, gates it.
 */
let sharedRuntimePromise:
  | Promise<ManagedRuntime.ManagedRuntime<AppServices, never>>
  | undefined;

/** Build (once) and reuse the worker's shared {@link ManagedRuntime}. */
function workerRuntime(): Promise<
  ManagedRuntime.ManagedRuntime<AppServices, never>
> {
  if (sharedRuntimePromise === undefined) {
    sharedRuntimePromise = import("@gtmgrid/db/client").then(({ db }) =>
      ManagedRuntime.make(appLayer({ db, userId: null })),
    );
  }
  return sharedRuntimePromise;
}

/** 401 for an unauthorized worker (missing/incorrect bearer). */
export const unauthorized = (): Response =>
  new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });

/** 200 JSON body. */
export const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body ?? null), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** 400 for an unreadable request body. */
const badRequest = (message: string): Response =>
  new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });

/** Parse a worker request's JSON body, or `null` when unreadable. */
export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Guard + run a worker handler: reject unauthorized callers with 401, parse the
 * JSON body (400 on failure), build a `WebhookService` runtime (no member
 * identity) and run the supplied Effect, returning its result as 200 JSON. A
 * typed service failure becomes a 4xx/500 with the message; a defect is a 500.
 */
export async function runWorker<T, A, E>(
  req: Request,
  build: (body: T) => Effect.Effect<A, E, AppServices>,
): Promise<Response> {
  if (!isAuthorizedWorker(req)) return unauthorized();
  const body = await readJson<T>(req);
  if (body === null) return badRequest("Invalid JSON body");

  // Reuse the module-scoped runtime (built once) instead of constructing +
  // disposing a fresh one per POST (M5). The pool it wraps is already shared, so
  // this removes the per-request runtime build/dispose overhead.
  const runtime = await workerRuntime();
  const exit = await runtime.runPromiseExit(build(body));
  if (Exit.isSuccess(exit)) return ok(exit.value);

  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "Some") {
    const err = failure.value as { _tag?: string; message?: string };
    return new Response(
      JSON.stringify({ error: err.message ?? "Worker request failed." }),
      {
        status: workerErrorStatus(err._tag),
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  return new Response(
    JSON.stringify({ error: Cause.pretty(exit.cause) }),
    { status: 500, headers: { "Content-Type": "application/json" } },
  );
}

/** Map a typed service-error tag to an HTTP status for the worker boundary. */
function workerErrorStatus(tag: string | undefined): number {
  switch (tag) {
    case "WebhookNotFoundError":
      return 404;
    case "InvalidMappingError":
    case "InvalidConfigError":
    case "InvalidCellError":
      return 400;
    case "CloudActionsLimitError":
      return 402;
    default:
      return 500;
  }
}
