/**
 * Worker-secret helper — the constant-time `WEBHOOK_WORKER_SECRET` check the W2
 * worker boundary reuses.
 *
 * Ported verbatim from the Convex HTTP router (convex/http.ts:31,46): the
 * headless webhook worker is NOT a workspace member and carries no Better Auth
 * session, so the worker-only routes authenticate it with a shared bearer secret
 * compared in CONSTANT TIME to avoid leaking the secret through response timing.
 *
 * Fail-closed: an unset/empty env secret rejects everything, so the worker
 * boundary is never open by default.
 */

/**
 * Constant-time string compare. Returns false fast only on a length mismatch
 * (length is not the secret); for equal-length inputs every byte is compared
 * regardless of where they diverge, so timing does not reveal the prefix match.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/** The `Bearer ` prefix the worker sends on its `Authorization` header. */
const BEARER_PREFIX = "Bearer ";

/**
 * Validate an `Authorization: Bearer <secret>` header against
 * `WEBHOOK_WORKER_SECRET`. Returns true only when the env secret is configured
 * AND the bearer matches it in constant time. Fail-closed: an unset env secret
 * rejects everything (the worker boundary is never open by default).
 */
export function isAuthorizedWorker(req: Request): boolean {
  const expected = process.env.WEBHOOK_WORKER_SECRET;
  if (expected === undefined || expected === "") return false;
  const header = req.headers.get("Authorization");
  if (header === null) return false;
  if (!header.startsWith(BEARER_PREFIX)) return false;
  const token = header.slice(BEARER_PREFIX.length);
  return timingSafeEqual(token, expected);
}
