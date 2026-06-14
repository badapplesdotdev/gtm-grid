/**
 * Bridges cloud auth state into PostHog: identifies the signed-in user, attaches
 * the active workspace as a group (for account-level analytics), and resets on
 * sign-out. Renders nothing.
 *
 * Mounted from `main.tsx` (inside the react-query provider, OUTSIDE `client.tsx`)
 * so it can read the `useMe` / `useActiveWorkspace` hooks without creating an
 * import cycle with `client.tsx` (which `./auth` already depends on). All hooks
 * degrade to null/no-op when the cloud layer is off, so a local-only build is
 * untouched.
 */
import { useEffect, useRef } from "react";
import { identifyUser, identifyWorkspace, resetAnalytics } from "../analytics";
import { useActiveWorkspace, useMe } from "./auth";

export function PostHogIdentityBridge(): null {
  const me = useMe();
  const { activeWorkspace } = useActiveWorkspace(me);
  const prevUserId = useRef<string | null>(null);

  // Identify on sign-in; reset on sign-out (identity transitions only).
  const userId = me?.user._id ?? null;
  useEffect(() => {
    if (userId && userId !== prevUserId.current) {
      prevUserId.current = userId;
      identifyUser(userId, {
        email: me?.user.email ?? undefined,
        name: me?.user.name ?? undefined,
      });
    } else if (!userId && prevUserId.current) {
      prevUserId.current = null;
      resetAnalytics();
    }
  }, [userId, me]);

  // Keep the workspace group current (plan/name can change at runtime).
  const wsId = activeWorkspace?._id ?? null;
  const wsPlan = activeWorkspace?.plan.name;
  useEffect(() => {
    if (wsId) {
      identifyWorkspace(wsId, { name: activeWorkspace?.name, plan: wsPlan });
    }
  }, [wsId, wsPlan, activeWorkspace?.name]);

  return null;
}
