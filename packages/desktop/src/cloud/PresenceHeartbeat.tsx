/**
 * Reports "the user is actively in the app" to the cloud so
 * `users.last_active_at` stays current — the presence signal the lifecycle
 * email system reads ("app currently open" suppresses run-finished/new-signals
 * emails; >7 days idle marks a user dormant). Renders nothing.
 *
 * Cadence: one ping on sign-in/focus, then every 4 minutes while the window
 * stays focused (comfortably inside the server's ~5-minute presence window
 * without chatty traffic). Strictly fire-and-forget — a failed ping is
 * swallowed; presence must never surface an error or retry-storm the API.
 *
 * Mounted from `main.tsx` next to {@link PostHogIdentityBridge}, and for the
 * same reason: it needs `useMe` without importing `client.tsx`.
 */
import { useEffect } from "react";
import { apiClient } from "./client";
import { useMe } from "./auth";

const HEARTBEAT_MS = 4 * 60_000;

function ping(): void {
  void apiClient.presence.heartbeat.mutate().catch(() => {
    // Best-effort by design.
  });
}

export function PresenceHeartbeat(): null {
  const me = useMe();
  const signedIn = Boolean(me?.user._id);

  useEffect(() => {
    if (!signedIn) return;
    ping();
    const onFocus = () => ping();
    window.addEventListener("focus", onFocus);
    const interval = window.setInterval(() => {
      if (document.hasFocus()) ping();
    }, HEARTBEAT_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(interval);
    };
  }, [signedIn]);

  return null;
}
