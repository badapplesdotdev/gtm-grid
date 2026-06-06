/**
 * Maps raw auth errors (Convex Auth / network) to short, human messages.
 *
 * Convex surfaces server errors verbatim — e.g.
 *   "[CONVEX A(auth:signIn)] [Request ID: …] Server Error
 *    Uncaught Error: InvalidAccountId at retrieveAccount (../../node_modules/…)"
 * Rendering that `.message` directly leaks a stack trace and confuses users. We
 * match on the known error markers and return friendly copy; everything else
 * falls back to a generic line so a raw trace NEVER reaches the UI.
 */

export type AuthFlow = "signIn" | "signUp";

export function friendlyAuthError(err: unknown, flow: AuthFlow): string {
  const raw =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const m = raw.toLowerCase();

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
