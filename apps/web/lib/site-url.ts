/**
 * Resolve the base URL of THIS apps/web deployment — used by code that calls
 * back into its own deployment's HTTP routes (the Inngest worker client and the
 * webhook receiver hitting `/api/worker/*`).
 *
 * Precedence:
 *   1. `SITE_URL` — explicit operator config, always wins when set.
 *   2. `https://${VERCEL_PROJECT_PRODUCTION_URL}` — the stable production
 *      domain Vercel injects into every deployment (host only, no protocol).
 *   3. `https://${VERCEL_URL}` — the per-deployment host (previews).
 *
 * The fallbacks mean a Vercel deployment works WITHOUT manually configuring
 * `SITE_URL` — previously a missing var made every webhook-record run fail
 * with "SITE_URL is not configured". Off Vercel with no `SITE_URL`, this still
 * fails closed.
 */
export function resolveSiteUrl(env: Record<string, string | undefined> = process.env): string {
  const pick = (v: string | undefined) => (v !== undefined && v !== "" ? v : undefined);
  const url =
    pick(env.SITE_URL) ??
    (pick(env.VERCEL_PROJECT_PRODUCTION_URL) !== undefined
      ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`
      : undefined) ??
    (pick(env.VERCEL_URL) !== undefined ? `https://${env.VERCEL_URL}` : undefined);
  if (url === undefined) {
    throw new Error("SITE_URL is not configured (and no VERCEL_URL fallback is available)");
  }
  return url.replace(/\/$/, "");
}
