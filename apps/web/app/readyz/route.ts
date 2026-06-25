/**
 * Readiness probe — verifies the app can actually serve traffic by pinging the
 * database (the hard dependency every request needs). Returns 503 when the DB is
 * unreachable so a load balancer / uptime monitor can route around an instance
 * that's up but can't serve. Liveness (no deps) is the separate `/healthz` route.
 *
 * The DB client is imported DYNAMICALLY inside the handler, not at module top
 * level: `@gtmgrid/db/client` throws at load when `DATABASE_URL` is unset, which
 * would crash `next build` (page-data collection evaluates the module) in any
 * environment without the var (e.g. Preview). Deferring the import keeps the build
 * green and turns a missing DB into a clean 503 at request time.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const { sqlClient } = await import("@gtmgrid/db/client");
    await sqlClient`select 1`;
    return Response.json({ ok: true, db: "up" });
  } catch (error) {
    return Response.json(
      { ok: false, db: "down" },
      { status: 503 },
    );
  }
}
