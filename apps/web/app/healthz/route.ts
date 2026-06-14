/**
 * Liveness probe. Always 200 when the process is up — no dependencies checked.
 * Use this for uptime monitors / load-balancer liveness. Readiness (DB-depth) is
 * the separate `/readyz` route.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ ok: true });
}
