// Plain-TS retry + timeout wrapper for the connector/worker HTTP hot paths.
//
// The engine and sidecar run outside Effect's runtime in the request hot path,
// so this helper deliberately uses NO Effect: it is a small dependency-free
// exponential-backoff-with-jitter + AbortController-timeout wrapper around a
// single `fetch`. (TRI-3276.)
//
// Failure classification:
//   - 429 / 503 / any 5xx        → RETRYABLE (capped attempts, honour Retry-After)
//   - 402 (CloudActionsLimit)    → FATAL-STOP (quota exhausted; retrying is futile)
//   - any other non-2xx (4xx)    → FATAL (client error; retrying is futile)
//   - network/abort errors       → RETRYABLE (transient connectivity)
// The caller still inspects the returned Response and throws its own typed error
// for a non-2xx that survived the retry policy; this helper only decides whether
// to retry and when to give up.

/** Tunables for {@link fetchWithRetry}. All have safe defaults. */
export interface RetryOptions {
  /** Total attempts including the first (default 4). */
  readonly maxAttempts?: number;
  /** Base backoff in ms; doubles each attempt (default 250). */
  readonly baseDelayMs?: number;
  /** Cap on a single backoff delay in ms (default 10_000). */
  readonly maxDelayMs?: number;
  /** Per-attempt timeout in ms before the request is aborted (default 30_000). */
  readonly timeoutMs?: number;
  /** Cap on a server-supplied Retry-After delay in ms (default 30_000). */
  readonly maxRetryAfterMs?: number;
  /** Injected sleep (ms) — tests pass an instant fake. Default real setTimeout. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected jitter in [0,1) — tests pass a deterministic fake. Default Math.random. */
  readonly random?: () => number;
}

/**
 * Thrown when {@link fetchWithRetry} gives up because every attempt was aborted
 * by the per-attempt timeout. A dedicated typed error with a STABLE, value-free
 * message so error tracking classifies a transient worker timeout distinctly and
 * dedups it, instead of leaking the raw `DOMException: This operation was
 * aborted` (which reads like a mysterious internal crash). The original abort is
 * preserved on `cause`.
 */
export class HttpTimeoutError extends Error {
  override readonly name = "HttpTimeoutError";
  /** How many attempts were made before giving up. */
  readonly attempts: number;
  /** The per-attempt timeout (ms) that aborted each attempt. */
  readonly timeoutMs: number;

  constructor(
    attempts: number,
    timeoutMs: number,
    options?: { readonly cause?: unknown },
  ) {
    super(
      `worker request timed out after ${attempts} attempt(s) (per-attempt timeout ${timeoutMs}ms)`,
      options,
    );
    this.attempts = attempts;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Was this rejection an abort/timeout? Our per-attempt {@link AbortController}
 * fires `abort()` on timeout, which rejects the in-flight `fetch` with an
 * `AbortError` `DOMException` (message `"This operation was aborted"`). We match
 * on the error name (and the well-known message as a fallback) so both the
 * standard `AbortError`/`TimeoutError` and the raw message are caught.
 */
export function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === "AbortError" ||
    err.name === "TimeoutError" ||
    err.message === "This operation was aborted"
  );
}

/** Status codes that are safe to retry (transient upstream failures). */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503 || (status >= 500 && status <= 599);
}

/** 402 means the cloud-actions quota is exhausted — a fatal, non-retryable stop. */
export function isFatalStopStatus(status: number): boolean {
  return status === 402;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse a `Retry-After` header into milliseconds. Supports both the delay-seconds
 * form (`Retry-After: 5`) and the HTTP-date form (`Retry-After: <http-date>`).
 * Returns `undefined` when absent/unparseable so the caller falls back to its
 * computed backoff. Negative/over-cap values are clamped to `[0, maxRetryAfterMs]`.
 */
export function parseRetryAfter(
  header: string | null,
  now: number,
  maxRetryAfterMs: number,
): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed === "") return undefined;
  // delta-seconds form.
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return Math.min(Math.max(ms, 0), maxRetryAfterMs);
  }
  // HTTP-date form.
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  const ms = when - now;
  return Math.min(Math.max(ms, 0), maxRetryAfterMs);
}

/** Exponential backoff with full jitter for attempt `n` (0-based). */
function backoffMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const exp = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  // Full jitter: a random delay in [0, exp].
  return Math.floor(random() * exp);
}

/**
 * Fetch `url` with a per-attempt {@link AbortController} timeout and retry
 * transient failures (429/503/5xx and network errors) with exponential backoff
 * plus full jitter, honouring a `Retry-After` header when present. A 402 stops
 * immediately (quota), and other 4xx responses are returned as-is for the caller
 * to throw on — they are not retried. The final Response (success or otherwise)
 * is returned to the caller; the helper never throws for a non-2xx that exhausted
 * retries — it returns the last Response so the caller raises its own typed error.
 *
 * Network errors that exhaust retries are re-thrown (no Response to return);
 * abort/timeout errors that exhaust retries surface as a typed
 * {@link HttpTimeoutError} rather than the raw `DOMException`.
 */
export async function fetchWithRetry(
  url: string | URL,
  init: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 10_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? 30_000;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);

      if (res.ok) return res;
      // 402 and other 4xx are fatal — return immediately for the caller to throw.
      if (isFatalStopStatus(res.status) || !isRetryableStatus(res.status)) {
        return res;
      }
      // Retryable status. If this was the last attempt, hand the response back.
      if (attempt === maxAttempts - 1) return res;
      // Honour Retry-After when present, else exponential backoff with jitter.
      const retryAfter = parseRetryAfter(
        res.headers.get("retry-after"),
        Date.now(),
        maxRetryAfterMs,
      );
      const delay =
        retryAfter ?? backoffMs(attempt, baseDelayMs, maxDelayMs, random);
      await sleep(delay);
      continue;
    } catch (err) {
      clearTimeout(timer);
      // Network failure or abort (timeout). Retry until attempts are exhausted.
      lastError = err;
      if (attempt === maxAttempts - 1) break;
      await sleep(backoffMs(attempt, baseDelayMs, maxDelayMs, random));
      continue;
    }
  }

  // A timeout that exhausted retries surfaces as a clear, dedup-friendly typed
  // error instead of the opaque raw `DOMException: This operation was aborted`.
  if (isAbortError(lastError)) {
    throw new HttpTimeoutError(maxAttempts, timeoutMs, { cause: lastError });
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`fetch failed after ${maxAttempts} attempts: ${String(lastError)}`);
}
