/**
 * tRPC request context — the Effect-DI seam for the API.
 *
 * For each request we resolve two things and hand them to the procedures:
 *
 *   1. `userId` — the authenticated caller, resolved from the Better Auth
 *      session (`@gtmgrid/auth` `getSessionUserId`) using the request headers.
 *      `null` when signed out. `protectedProcedure` narrows it to a string.
 *   2. `runtime` — an Effect `ManagedRuntime` built from a services `Layer`.
 *      Procedures run Effect programs against it via `runEffect`. In production
 *      the Layer is `appLayer({ db, userId })` (Drizzle-backed, pooler-safe); in
 *      tests it is `TestLayer(fixtures)`, so the SAME procedures run with no live
 *      database.
 *
 * The live `db` handle is the shared pooled client from `@gtmgrid/db/client`,
 * imported LAZILY so merely importing this module never opens a connection.
 */

import { getSessionUserId } from "@gtmgrid/auth";
import { getAuth } from "@gtmgrid/auth";
import { type AppServices, appLayer } from "@gtmgrid/services";
import { Layer, ManagedRuntime } from "effect";
import { captureServerException } from "../posthog-server";

/** The services available to every procedure for this request. */
export type ServicesRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>;

/** The resolved per-request context every procedure receives. */
export interface TrpcContext {
  /** Authenticated user id, or `null` when signed out. */
  readonly userId: string | null;
  /** Effect runtime carrying the services Layer (Live or Test). */
  readonly runtime: ServicesRuntime;
}

/**
 * Build the LIVE request context: resolve the Better Auth session from the
 * request headers, lazily resolve the pooled db handle, and construct a runtime
 * from `appLayer`. Used by the fetch route handler.
 */
export async function createContext(opts: {
  readonly req: Request;
}): Promise<TrpcContext> {
  const auth = await getAuth();
  const userId = await getSessionUserId(auth, opts.req.headers);
  const { db } = await import("@gtmgrid/db/client");
  // Wire the host exception sink so services-internal swallowed failures (e.g. a
  // best-effort invite email) still reach PostHog Error Tracking.
  const runtime = ManagedRuntime.make(
    appLayer({
      db,
      userId,
      reportError: (error, context) =>
        captureServerException(error, { distinctId: userId ?? undefined, properties: context }),
    }),
  );
  return { userId, runtime };
}

/**
 * Build a TEST context from a pre-composed services `Layer` (typically
 * `TestLayer(fixtures)`) and a caller id. No live DB is touched — this is how
 * `createCaller` exercises procedures offline.
 */
export function createTestContext(params: {
  readonly layer: Layer.Layer<AppServices, never, never>;
  readonly userId?: string | null;
}): TrpcContext {
  return {
    userId: params.userId ?? null,
    runtime: ManagedRuntime.make(params.layer),
  };
}
