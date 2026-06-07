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
import { appRouter } from "../../../../lib/trpc/root";

export const runtime = "nodejs";

function handler(req: Request): Promise<Response> {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createContext({ req }),
  });
}

export { handler as GET, handler as POST };
