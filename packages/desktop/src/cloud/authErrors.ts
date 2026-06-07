/**
 * Maps raw auth errors (Convex Auth / Better Auth + tRPC / network) to short,
 * human messages.
 *
 * Convex surfaces server errors verbatim — e.g.
 *   "[CONVEX A(auth:signIn)] [Request ID: …] Server Error
 *    Uncaught Error: InvalidAccountId at retrieveAccount (../../node_modules/…)"
 * Rendering that `.message` directly leaks a stack trace and confuses users. We
 * match on the known error markers and return friendly copy; everything else
 * falls back to a generic line so a raw trace NEVER reaches the UI.
 *
 * The NEW Postgres-tier path (TRI-3253) surfaces errors differently:
 *   - Better Auth resolves `{ error: { message, code } }` (re-raised as an
 *     `Error` carrying that message/code, e.g. "INVALID_EMAIL_OR_PASSWORD",
 *     "USER_ALREADY_EXISTS", "INVALID_OTP");
 *   - tRPC throws a `TRPCClientError` whose `.message` is the procedure message
 *     and whose `.data.code` is the HTTP-ish code ("UNAUTHORIZED", "FORBIDDEN").
 * Both are read here (message text + any `data.code`) so the same friendly copy
 * resolves regardless of which backend produced the error.
 */

export type AuthFlow = "signIn" | "signUp";

/** Pull a tRPC error code (`error.data.code`) when present, lower-cased. */
function trpcErrorCode(err: unknown): string {
  if (err !== null && typeof err === "object" && "data" in err) {
    const data = (err as { data?: unknown }).data;
    if (data !== null && typeof data === "object" && "code" in data) {
      const code = (data as { code?: unknown }).code;
      if (typeof code === "string") return code.toLowerCase();
    }
  }
  return "";
}

export function friendlyAuthError(err: unknown, flow: AuthFlow): string {
  const raw =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  // Fold the tRPC error code (when present) into the matched text so the markers
  // below catch both message-based (Convex/Better Auth) and code-based (tRPC)
  // failures with one set of rules.
  const m = `${raw} ${trpcErrorCode(err)}`.toLowerCase();

  // Better Auth markers (NEW path): map its error codes/messages to the same
  // friendly copy as the Convex equivalents below.
  if (
    m.includes("invalid_email_or_password") ||
    m.includes("invalid email or password")
  ) {
    return "That email and password don't match. Double-check and try again.";
  }
  if (
    m.includes("user_already_exists") ||
    m.includes("user already exists") ||
    m.includes("email_already") // e.g. EMAIL_ALREADY_IN_USE / EMAIL_ALREADY_EXISTS
  ) {
    return "An account with that email already exists — try signing in instead.";
  }
  if (
    m.includes("invalid_otp") ||
    m.includes("invalid otp") ||
    m.includes("otp_expired") ||
    m.includes("expired_otp") ||
    m.includes("invalid code") ||
    m.includes("code expired")
  ) {
    return "That code is invalid or has expired. Request a new one and try again.";
  }
  if (
    m.includes("email_not_verified") ||
    m.includes("email not verified") ||
    m.includes("verify your email")
  ) {
    return "Please verify your email — enter the code we sent to finish signing in.";
  }

  // Convex Auth Password provider markers
  if (m.includes("invalidaccountid")) {
    return flow === "signIn"
      ? "We couldn't find an account with that email. Create one to get started."
      : "An account with that email already exists — try signing in instead.";
  }
  if (m.includes("invalidsecret") || m.includes("incorrect password")) {
    return "That email and password don't match. Double-check and try again.";
  }
  if (m.includes("already exists") || m.includes("account exists")) {
    return "An account with that email already exists — try signing in instead.";
  }
  if (
    m.includes("password") &&
    (m.includes("at least") ||
      m.includes("too short") ||
      m.includes("weak") ||
      m.includes("8 characters"))
  ) {
    return "Please choose a stronger password (at least 8 characters).";
  }
  if (m.includes("invalid email") || m.includes("not a valid email")) {
    return "Please enter a valid email address.";
  }
  if (m.includes("too many") || m.includes("rate limit")) {
    return "Too many attempts. Please wait a moment and try again.";
  }
  if (
    m.includes("failed to fetch") ||
    m.includes("networkerror") ||
    m.includes("network error") ||
    m.includes("offline") ||
    m.includes("err_connection")
  ) {
    return "Couldn't reach the server. Check your connection and try again.";
  }
  // Server misconfiguration (e.g. missing JWT_PRIVATE_KEY) — don't expose internals.
  if (
    m.includes("missing environment variable") ||
    m.includes("jwt_private_key") ||
    m.includes("jwks")
  ) {
    return "Sign-in isn't fully set up on this server yet. Please contact your admin.";
  }

  // Fallback — never leak the raw trace.
  return flow === "signIn"
    ? "Couldn't sign you in. Please try again."
    : "Couldn't create your account. Please try again.";
}
