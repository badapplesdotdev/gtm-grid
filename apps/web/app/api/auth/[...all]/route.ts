/**
 * Better Auth handler mount — the Postgres-tier replacement for the Convex Auth
 * HTTP routes (`auth.addHttpRoutes(http)`, convex/http.ts:24).
 *
 * Better Auth serves its entire surface (sign-in / sign-up / sign-out / OAuth
 * callbacks / email-OTP verify + reset) from ONE catch-all route. We resolve the
 * process-wide instance via `getAuth()` and delegate to its framework-agnostic
 * `handler`, which takes a `Request` and returns a `Response`.
 *
 * Node runtime: `getAuth()` lazily opens the pooled Postgres connection (Drizzle
 * adapter), which is Node-only.
 */

import { getAuth } from "@gtmgrid/auth";

export const runtime = "nodejs";

async function handler(req: Request): Promise<Response> {
  const auth = await getAuth();
  return auth.handler(req);
}

export { handler as GET, handler as POST };
