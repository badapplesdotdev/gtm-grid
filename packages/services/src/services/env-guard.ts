/**
 * Production env-variable guard — fails closed on secrets that MUST be set for
 * billing, session security, and worker trust in production.
 *
 * Only evaluates when `NODE_ENV === "production"` OR `VERCEL_ENV === "production"`
 * (both are checked so it works in any Vercel or non-Vercel production runtime).
 * In dev / CI / preview it is a no-op.
 *
 * Usage (called once at server boot / worker init):
 * ```ts
 * import { validateProductionSecrets } from "@gtmgrid/services";
 *
 * const { ok, errors, warnings } = validateProductionSecrets();
 * if (!ok) { process.exit(1); }
 * for (const w of warnings) console.warn("[env-guard]", w);
 * ```
 */

export interface EnvGuardResult {
  readonly ok: boolean;
  readonly errors: string[];
  readonly warnings: string[];
}

/**
 * Check whether the current environment is production. Covers both Vercel's
 * `VERCEL_ENV` and the generic `NODE_ENV`.
 */
function isProduction(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV === "production"
  );
}

/**
 * Read a mandatory env var. Returns the value when set and non-empty; returns
 * `null` and pushes a descriptive error when missing or empty.
 */
function requireEnv(
  name: string,
  description: string,
  errors: string[],
): string | null {
  const value = process.env[name];
  if (value === undefined || value === "") {
    errors.push(
      `Missing required production env var: ${name} — ${description}. Set it before starting the server.`,
    );
    return null;
  }
  return value;
}

/**
 * Validate production-critical secrets. Call once at server/worker init.
 *
 * - **Hard errors** (fail closed): `AUTUMN_SECRET_KEY` (billing),
 *   `BETTER_AUTH_SECRET` (session encryption).
 * - **Warnings**: `WEBHOOK_WORKER_SECRET` (worker routes break),
 *   `AUTH_REQUIRE_EMAIL_VERIFICATION` (should be "true" in production).
 *
 * Returns `{ ok, errors, warnings }`. When `ok` is false the caller SHOULD
 * refuse to start (throw or `process.exit(1)`).
 */
export function validateProductionSecrets(): EnvGuardResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Skip validation outside production.
  if (!isProduction()) {
    return { ok: true, errors: [], warnings: [] };
  }

  // ── Hard requirements (fail closed) ──────────────────────────────────────

  requireEnv(
    "AUTUMN_SECRET_KEY",
    "required for Autumn billing (seats check/checkout, cloud-actions metering). Without it the cloud billing gate cannot function",
    errors,
  );

  requireEnv(
    "BETTER_AUTH_SECRET",
    "required for Better Auth session encryption. Without it sessions are not cryptographically secure",
    errors,
  );

  // ── Warnings (service degradation, but the app can still serve) ──────────

  const workerSecret = process.env.WEBHOOK_WORKER_SECRET;
  if (workerSecret === undefined || workerSecret === "") {
    warnings.push(
      "WEBHOOK_WORKER_SECRET is unset — the headless webhook worker routes " +
        "(/api/worker/*) will reject every request. The Inngest webhook processor " +
        "and the sidecar cloud-run path will be unavailable until it is configured.",
    );
  }

  const emailVerification = process.env.AUTH_REQUIRE_EMAIL_VERIFICATION;
  if (emailVerification === undefined || emailVerification === "") {
    warnings.push(
      "AUTH_REQUIRE_EMAIL_VERIFICATION is unset — users can sign in without " +
        "verifying their email address. In production this should be set to \"true\" " +
        "to require verified email before sign-in.",
    );
  } else if (emailVerification !== "true") {
    warnings.push(
      `AUTH_REQUIRE_EMAIL_VERIFICATION is "${emailVerification}" but should be ` +
        `"true" in production to require verified email before sign-in.`,
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

export default validateProductionSecrets;