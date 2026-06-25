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
 *
 * Security: IP-based rate limiting is applied to sensitive auth operations
 * (sign-in, OTP verify, password reset) before they reach Better Auth, using
 * the fixed-window in-memory rate limiter. This is a per-instance soft limit.
 */

import { getAuth } from "@gtmgrid/auth";
import { clientIp, rateLimit } from "../../../lib/rate-limit";

export const runtime = "nodejs";

const json = (
  body: unknown,
  status: number,
  extraHeaders?: Record<string, string>,
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });

async function handler(req: Request): Promise<Response> {
  // Rate-limit sensitive auth operations by IP + path
  if (req.method === "POST") {
    const url = new URL(req.url);
    const path = url.pathname;
    const ip = clientIp(req);

    if (path.includes("/sign-in")) {
      const limit = rateLimit(`auth:signin:${ip}`, 5, 60_000);
      if (!limit.ok)
        return json(
          { error: "Too many sign-in attempts. Try again shortly." },
          429,
          { "Retry-After": String(limit.retryAfter) },
        );
    } else if (path.includes("/verify") || path.includes("/email-otp")) {
      const limit = rateLimit(`auth:verify:${ip}`, 3, 60_000);
      if (!limit.ok)
        return json({ error: "Too many verification attempts." }, 429, {
          "Retry-After": String(limit.retryAfter),
        });
    } else if (
      path.includes("/forget-password") ||
      path.includes("/reset-password")
    ) {
      const limit = rateLimit(`auth:reset:${ip}`, 3, 60_000);
      if (!limit.ok)
        return json(
          { error: "Too many password reset attempts." },
          429,
          { "Retry-After": String(limit.retryAfter) },
        );
    }
  }

  const auth = await getAuth();
  return auth.handler(req);
}

export { handler as GET, handler as POST };
