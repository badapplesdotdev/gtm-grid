// Classifies a failed cell run so the engine can tell a USER-ACTIONABLE failure
// (an expired login, no credits, a connector that is not configured) apart from a
// genuine product DEFECT. User-actionable failures still land on the cell as an
// error the user can read and fix, but they are NOT forwarded to error tracking —
// otherwise "log back in" and "top up credits" crowd out the real bugs the team
// relies on the exception feed to surface.

/** The four buckets a failed cell run falls into. `auth`, `credit` and `config`
 *  are user-actionable; only `defect` is a genuine bug worth an exception. */
export type CellErrorKind = "auth" | "credit" | "config" | "defect";

export interface ClassifiedCellError {
  readonly kind: CellErrorKind;
  /** True for auth/credit/config — the user resolves these, so they stay off error tracking. */
  readonly userActionable: boolean;
  /** The message to store on the failing cell (an auth kind carries a re-authenticate hint). */
  readonly message: string;
}

/**
 * The HTTP status a connector error carries: a numeric `status`/`statusCode`
 * field (the vendor AI SDKs set this) or an `HTTP <code>` fragment in the message
 * (the declarative HTTP and manifest connectors throw this shape). Null when the
 * error is not HTTP-shaped (a sandbox error, a thrown string, a network failure).
 */
function statusOf(error: unknown, message: string): number | null {
  if (error && typeof error === "object") {
    const e = error as { status?: unknown; statusCode?: unknown };
    const s = typeof e.status === "number" ? e.status : e.statusCode;
    if (typeof s === "number" && Number.isFinite(s)) return s;
  }
  const m = /\bHTTP (\d{3})\b/.exec(message);
  return m ? Number(m[1]) : null;
}

// Message shapes the connectors already produce for each user-actionable class,
// matched when no numeric status pins the class down (e.g. the coding-agent
// fallback re-throws the raw CLI text, which carries no HTTP status object).
const AUTH_RE =
  /re-?authenticate|reconnect|(access )?token .*(expired|revoked)|unauthori[sz]ed|invalid or expired|expired or was revoked|not authenticated/i;
const CREDIT_RE =
  /insufficient credit|not enough credit|out of credit|payment required|quota (has been )?exceeded|over your quota/i;
const CONFIG_RE =
  /no ai provider connected|not configured|not connected|connect (a|an|your) /i;

/**
 * Classify a failed cell run. The class drives whether the engine forwards the
 * error to error tracking (only `defect` is forwarded) and, for `auth`, ensures
 * the cell message tells the user to re-authenticate.
 *
 * HTTP status wins when present: 401/403 → auth, 402 → credit, any other client
 * error (4xx) except a transient timeout/rate-limit (408/429) → config. Otherwise
 * the message shape decides, and everything unmatched stays a `defect` so a real
 * bug is never silenced.
 */
export function classifyCellError(error: unknown): ClassifiedCellError {
  const base = error instanceof Error ? error.message : String(error);
  const status = statusOf(error, base);

  let kind: CellErrorKind = "defect";
  if (status === 401 || status === 403 || AUTH_RE.test(base)) {
    kind = "auth";
  } else if (status === 402 || CREDIT_RE.test(base)) {
    kind = "credit";
  } else if (
    (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) ||
    CONFIG_RE.test(base)
  ) {
    kind = "config";
  }

  // A status-classified auth error (e.g. "Foo verify HTTP 401: Unauthorized") may
  // carry no remedy — add one so every auth cell tells the user what to do.
  const message =
    kind === "auth" && !/re-?authenticate|reconnect/i.test(base)
      ? `${base} — re-authenticate to continue.`
      : base;

  return { kind, userActionable: kind !== "defect", message };
}
