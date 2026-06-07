/**
 * Session resolution for the tRPC context (TRI-3244) — the replacement for
 * Convex Auth's `getAuthUserId` (convex/model/auth.ts:31).
 *
 * The tRPC context builder calls {@link resolveSession} with the incoming
 * request headers; Better Auth reads its session cookie/token from those headers
 * and returns the live session + user, or `null` when signed out. The thin
 * {@link getSessionUserId} wrapper returns just the user id — the exact drop-in
 * for `getAuthUserId` that the authz bridge needs.
 *
 * Both take the Better Auth instance as the first argument so callers can pass
 * the test instance ({@link createAuth}) or the live one ({@link getAuth}); no
 * live DB is touched at import.
 */

import type { GtmGridAuth } from "./server.js";

/** A Better Auth instance (the value returned by `createAuth` / `getAuth`). */
type Auth = GtmGridAuth;

/** The resolved session payload (Better Auth's `getSession` return type). */
export type ResolvedSession = Awaited<
  ReturnType<Auth["api"]["getSession"]>
>;

/**
 * Resolve the current session from the request headers, or `null` when there is
 * no valid session. This is the session-validation helper exported for the tRPC
 * context.
 */
export async function resolveSession(
  auth: Auth,
  headers: Headers,
): Promise<ResolvedSession> {
  return await auth.api.getSession({ headers });
}

/**
 * The authenticated user's id for this request, or `null` if signed out. Drop-in
 * replacement for `getAuthUserId` (convex/model/auth.ts:31).
 */
export async function getSessionUserId(
  auth: Auth,
  headers: Headers,
): Promise<string | null> {
  const session = await resolveSession(auth, headers);
  return session?.user.id ?? null;
}
