/**
 * Better Auth React hooks the desktop UI binds to for the cloud path.
 *
 *   - {@link useApiAuthToken} — the auth-token hook for cloud-column runs:
 *     cloud runs send this bearer token to the apps/web API so the sidecar acts
 *     as the signed-in user. It reads the Better Auth session reactively and
 *     derives the token via the pure {@link sidecarTokenFromSession}, returning
 *     `null` while loading / signed out / when the cloud layer is disabled.
 *
 * Token derivation is kept in the pure ./api-auth helper so it is unit-testable
 * without React or a live session; this file is only the thin React binding.
 */

import { authClient } from "./client";
import { type ApiSessionLike, sidecarTokenFromSession } from "./api-auth";

/**
 * The sidecar token for cloud-column runs, from the Better Auth session, or
 * `null` when loading / signed out / on the legacy/local path. Reactive: it
 * re-renders when the session changes (sign in/out, OAuth completion). The
 * `useSession` call is intentionally NOT branched at runtime — `authClient` is
 * a module constant, so the hook count is stable across renders.
 */
export function useApiAuthToken(): string | null {
  if (authClient === null) {
    return null;
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks -- `authClient` is a
  // module constant, so this branch never changes the hook order across renders.
  const session = authClient.useSession();
  return sidecarTokenFromSession(session.data as ApiSessionLike | null);
}
