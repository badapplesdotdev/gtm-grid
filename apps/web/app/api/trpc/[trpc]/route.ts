/**
 * tRPC serverless route handler (fetch adapter).
 *
 * Runs on the NODE runtime because the request context opens the pooled Postgres
 * connection (`@gtmgrid/db/client`) and the Better Auth instance — both Node-only.
 * The pooled client is `prepare:false` Supavisor transaction mode, so it is safe
 * across the short-lived, possibly-different backend connections a serverless
 * function gets per invocation (pooler-safe).
 */

import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { createContext } from "../../../../lib/trpc/context";
import { captureServerException } from "../../../../lib/posthog-server";
import { appRouter } from "../../../../lib/trpc/root";

export const runtime = "nodejs";

function handler(req: Request): Promise<Response> {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createContext({ req }),
    // Server-side error tracking → PostHog. Only report genuine defects
    // (INTERNAL_SERVER_ERROR); expected client failures (UNAUTHORIZED, NOT_FOUND,
    // FORBIDDEN, BAD_REQUEST, …) are normal control flow, not incidents.
    onError({ error, path, type, ctx }) {
      if (error.code !== "INTERNAL_SERVER_ERROR") return;
      captureServerException(error.cause ?? error, {
        distinctId: ctx?.userId ?? undefined,
        properties: { source: "trpc", trpc_path: path, trpc_type: type, code: error.code },
      });
    },
  });
}

export { handler as GET, handler as POST };
