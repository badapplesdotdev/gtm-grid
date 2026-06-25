/**
 * In-memory fixed-window rate limiter.
 *
 * WARNING: This is a per-warm-instance SOFT limit in serverless environments
 * (Vercel). It blunts bursts from a single instance but does NOT provide
 * cross-instance guarantees. For strict distributed rate limiting in
 * production, swap for @upstash/ratelimit (Redis) or similar. The function
 * signatures are designed to be a drop-in replacement.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

// Bound memory: prune expired buckets once the map gets large.
function pruneIfNeeded(now: number): void {
  if (buckets.size < 10_000) return;
  for (const [key, b] of buckets) {
    if (now >= b.resetAt) buckets.delete(key);
  }
}

export interface RateLimitResult {
  readonly ok: boolean;
  /** Seconds until the window resets (for the `Retry-After` header). */
  readonly retryAfter: number;
}

/** Allow up to `limit` hits per `windowMs` for `key`. */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    pruneIfNeeded(now);
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  if (bucket.count >= limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  bucket.count += 1;
  return { ok: true, retryAfter: 0 };
}

/** Best-effort client IP from the standard proxy headers (Vercel sets these). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
