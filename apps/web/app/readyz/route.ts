/**
 * Readiness probe — verifies the app can actually serve traffic by pinging the
 * database (the hard dependency every request needs). Returns 503 when the DB is
 * unreachable so a load balancer / uptime monitor can route around an instance
 * that's up but can't serve. Liveness (no deps) is the separate `/healthz` route.
 */
import { sqlClient } from "@gtmgrid/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    await sqlClient`select 1`;
    return Response.json({ ok: true, db: "up" });
  } catch (error) {
    return Response.json(
      { ok: false, db: "down", error: error instanceof Error ? error.message : String(error) },
      { status: 503 },
    );
  }
}
