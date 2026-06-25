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

import { getAuth, getSessionUserId } from "@gtmgrid/auth";
import { type AppServices, appLayer, isAuthorizedWorker, validateProductionSecrets } from "@gtmgrid/services";
import { Cause, type Effect, Exit, ManagedRuntime } from "effect";
import { z } from "zod";
import { captureServerException } from "../../../lib/posthog-server";

/** The member-attribution header the spawned MCP forwards (the agent's bearer). */
const MEMBER_HEADER = "X-Gtmgrid-Member";

/** The `Bearer ` prefix used when re-presenting the member token to Better Auth. */
const BEARER_PREFIX = "Bearer ";

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

/** Build (once) and reuse the worker's shared {@link ManagedRuntime}. Exported so
 *  the billing webhook route can run a secret-trusted Effect on the same pool. */
export function workerRuntime(): Promise<
  ManagedRuntime.ManagedRuntime<AppServices, never>
> {
  if (sharedRuntimePromise === undefined) {
    // Fail-closed on missing production secrets — called once at first request.
    const guard = validateProductionSecrets();
    if (!guard.ok) {
      const msg = `[env-guard] refusing to start: ${guard.errors.join("; ")}`;
      console.error(msg);
      throw new Error(msg);
    }
    for (const w of guard.warnings) console.warn("[env-guard]", w);

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

/**
 * Read + VALIDATE a worker request body against a zod schema. Returns the typed,
 * parsed data, or a 400 Response (malformed JSON OR schema mismatch). This is the
 * worker boundary's input-validation gate — it replaced an unchecked `as T` cast,
 * so a wrong-shaped body is now rejected with a precise message before any service
 * runs, instead of failing deep in the domain (or silently coercing).
 */
async function parseBody<T>(
  req: Request,
  schema: z.ZodType<T>,
): Promise<{ readonly ok: true; readonly data: T } | { readonly ok: false; readonly response: Response }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, response: badRequest("Invalid JSON body") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, response: badRequest(`Invalid request body: ${detail}`) };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Guard + run a worker handler: reject unauthorized callers with 401, VALIDATE the
 * JSON body against `schema` (400 on malformed/invalid), build a runtime (no member
 * identity) and run the supplied Effect, returning its result as 200 JSON. A typed
 * service failure becomes a 4xx/500 with the message; a defect is a 500.
 */
export async function runWorker<T, A, E>(
  req: Request,
  schema: z.ZodType<T>,
  build: (body: T) => Effect.Effect<A, E, AppServices>,
): Promise<Response> {
  if (!isAuthorizedWorker(req)) return unauthorized();
  const parsed = await parseBody(req, schema);
  if (!parsed.ok) return parsed.response;

  // Reuse the module-scoped runtime (built once) instead of constructing +
  // disposing a fresh one per POST (M5). The pool it wraps is already shared, so
  // this removes the per-request runtime build/dispose overhead.
  const runtime = await workerRuntime();
  const exit = await runtime.runPromiseExit(build(parsed.data));
  return exitToResponse(exit);
}

/** Read a typed service failure's `_tag` + `message` without an unsafe cast. */
function readTaggedError(value: unknown): {
  readonly tag: string | undefined;
  readonly message: string | undefined;
} {
  const tag =
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    typeof value._tag === "string"
      ? value._tag
      : undefined;
  const message =
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
      ? value.message
      : undefined;
  return { tag, message };
}

/** Render an Effect {@link Exit} as the worker boundary's JSON response. Exported
 *  so the billing webhook route can share the same typed-error → HTTP mapping. */
export function exitToResponse<A, E>(exit: Exit.Exit<A, E>): Response {
  if (Exit.isSuccess(exit)) return ok(exit.value);

  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "Some") {
    const { tag, message } = readTaggedError(failure.value);
    return new Response(
      JSON.stringify({ error: message ?? "Worker request failed." }),
      {
        status: workerErrorStatus(tag),
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  // A defect (non-typed crash) is a genuine 500 — report it to PostHog Error
  // Tracking before returning (typed failures above are expected control flow).
  const detail = Cause.pretty(exit.cause);
  captureServerException(new Error(detail), { properties: { source: "worker" } });
  return new Response(
    JSON.stringify({ error: detail }),
    { status: 500, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Resolve the `X-Gtmgrid-Member` attribution token to an authenticated user id
 * via Better Auth (the token is the member's session bearer the spawned MCP
 * forwards), or `null` when absent/invalid. Fail-closed: an unresolved token
 * yields `null`, and the member-authz Effect then rejects with
 * `UnauthenticatedError` (→ 401) before any workspace data is touched.
 */
async function resolveMemberUserId(req: Request): Promise<string | null> {
  const token = req.headers.get(MEMBER_HEADER);
  if (token === null || token === "") return null;
  const auth = await getAuth();
  const headers = new Headers({ Authorization: `${BEARER_PREFIX}${token}` });
  return getSessionUserId(auth, headers);
}

/**
 * Guard + run a MEMBER-ATTRIBUTED worker handler — the agent's cloud WRITE/LIST
 * tools (createTable / createColumn / addRows / listTables). It resolves the
 * forwarded `X-Gtmgrid-Member` session token to a user id and runs the Effect
 * against a PER-REQUEST runtime carrying that member's identity. The member-authz
 * + cloud-actions metering live inside the domain service (`GridService` reuses
 * `MembershipService.requireMember` + `MeterService`), so a non-member is
 * rejected (403) and the quota is enforced (402) server-side — exactly as the
 * authenticated tRPC grid path, with no parallel logic at the route.
 *
 * MEMBER-AUTH ONLY (no worker secret): these tools are driven by the signed-in
 * desktop user / spawned MCP, never the headless inngest worker, and the prod
 * desktop ships no worker secret. Authorization is therefore the member session
 * token alone — the shared secret is NOT accepted here. Fail-closed: a
 * missing/invalid member token resolves to `null` and the service rejects with
 * `UnauthenticatedError` (→ 401) before touching workspace data.
 */
export async function runWorkerAsMember<T, A, E>(
  req: Request,
  schema: z.ZodType<T>,
  build: (body: T) => Effect.Effect<A, E, AppServices>,
): Promise<Response> {
  const parsed = await parseBody(req, schema);
  if (!parsed.ok) return parsed.response;

  const userId = await resolveMemberUserId(req);
  const { db } = await import("@gtmgrid/db/client");
  const runtime = ManagedRuntime.make(appLayer({ db, userId }));
  try {
    const exit = await runtime.runPromiseExit(build(parsed.data));
    return exitToResponse(exit);
  } finally {
    await runtime.dispose();
  }
}

/**
 * Guard + run a worker handler that accepts EITHER trust path (prod desktop
 * cloud auth). Used by the routes the desktop sidecar + spawned MCP call directly
 * (getTable / getTableMeta / setCell / setCellStatus / setCells / getCredential /
 * assertColumnRunQuota):
 *
 *   1. HEADLESS (worker secret): a valid `WEBHOOK_WORKER_SECRET` bearer is full
 *      trust — the inngest webhook worker (server-to-server, no member identity).
 *      Runs on the shared `userId: null` runtime, exactly as {@link runWorker}.
 *   2. MEMBER (session token): no/invalid secret → resolve the forwarded
 *      `X-Gtmgrid-Member` session token to a user id and run on a PER-REQUEST
 *      runtime carrying that identity. The service method then enforces workspace
 *      membership via `assertMemberIfIdentified` (→ 403 for a non-member). A
 *      missing/invalid member token resolves to `null` → 401 here, BEFORE any
 *      handler runs.
 *
 * INVARIANT this wrapper guarantees (and `assertMemberIfIdentified` relies on):
 * the handler only ever sees `userId: null` when the WORKER SECRET authorized the
 * call. A member-path request with no resolvable identity is rejected 401 here,
 * so it never reaches the service. This is why the service can treat "no current
 * user" as the trusted headless path and skip the membership check.
 *
 * The prod desktop ships NO worker secret (it is a server-only secret), so it
 * always takes path 2 — which is the whole point: cloud reads/runs authenticate
 * as the signed-in member, not a shared client secret.
 */
export async function runWorkerSecretOrMember<T, A, E>(
  req: Request,
  schema: z.ZodType<T>,
  build: (body: T) => Effect.Effect<A, E, AppServices>,
): Promise<Response> {
  const parsed = await parseBody(req, schema);
  if (!parsed.ok) return parsed.response;

  // Path 1 — headless worker secret: full trust, shared runtime (userId: null).
  if (isAuthorizedWorker(req)) {
    const runtime = await workerRuntime();
    const exit = await runtime.runPromiseExit(build(parsed.data));
    return exitToResponse(exit);
  }

  // Path 2 — member session token. Fail-closed: an unresolved token is 401 here,
  // so the service never runs with a null identity on the member path.
  const userId = await resolveMemberUserId(req);
  if (userId === null) return unauthorized();
  const { db } = await import("@gtmgrid/db/client");
  const runtime = ManagedRuntime.make(appLayer({ db, userId }));
  try {
    const exit = await runtime.runPromiseExit(build(parsed.data));
    return exitToResponse(exit);
  } finally {
    await runtime.dispose();
  }
}

/** Map a typed service-error tag to an HTTP status for the worker boundary. */
function workerErrorStatus(tag: string | undefined): number {
  switch (tag) {
    case "WebhookNotFoundError":
    // GridService's not-found (project/table/column/row missing). The agent's
    // member-authz tools resolve the owning workspace from the parent doc, so a
    // missing parent surfaces here as a 404, never a leak.
    case "GridNotFoundError":
      return 404;
    case "InvalidMappingError":
    case "InvalidConfigError":
    case "InvalidCellError":
    // A column edit that would create a circular {{column}} reference.
    case "ColumnCycleError":
      return 400;
    // No/invalid member bearer (fail-closed): the X-Gtmgrid-Member token did not
    // resolve to an authenticated user, so the member-authz routes reject 401.
    case "UnauthenticatedError":
      return 401;
    // An authenticated member who does not belong to the target workspace.
    case "NotAMemberError":
    case "InsufficientRoleError":
      return 403;
    case "CloudActionsLimitError":
    // The workspace's cloud plan lapsed / is Free — cloud access is required.
    case "PlanRequiredError":
      return 402;
    default:
      return 500;
  }
}
