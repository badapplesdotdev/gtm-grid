/**
 * Registers the deep-link OAuth callback listener ONCE for the packaged desktop
 * app. Mounted once from `CloudProvider` (client.tsx) so it lives for the app's
 * whole lifetime. Outside the desktop app (the web build) it does nothing, so the
 * standard web OAuth + email/password flows are completely unaffected.
 *
 * Unlike a code-exchange flow there is NO `code` to exchange: Better Auth
 * completes the OAuth handshake server-side and sets the session cookie BEFORE
 * redirecting to `gtmgrid://auth/callback`. So when our callback deep link
 * arrives we simply re-read the Better Auth session (`getSession`), which
 * refreshes the client's `useSession` subscribers to the now-authenticated
 * state. Unrelated deep links are ignored via the pure {@link isApiOAuthCallback}
 * guard.
 *
 * The Electron main forwards EVERY `gtmgrid://` deep link on the `oauth-callback`
 * IPC channel — covering warm delivery (open-url / second-instance argv) AND cold
 * start (the main queues pre-window links and replays them on ready-to-show). So
 * the renderer only needs the single {@link electron} subscription.
 */

import { useEffect } from "react";
import { electron } from "../electron";
import { authClient } from "./client";
import { isApiOAuthCallback } from "./api-auth";
import { inviteTokenFromDeepLink, setPendingInviteToken } from "./pendingInvite";

export function useApiDeepLinkOAuth(): void {
  useEffect(() => {
    const api = electron();
    if (!api) return;
    // `authClient` is non-null whenever this hook is mounted (CloudProvider only
    // renders under `cloudEnabled`), but guard for safety in tests/SSR.
    const client = authClient;
    if (client === null) return;

    // Route a deep link: our OAuth callback re-reads the session; an invite link
    // (`gtmgrid://invite/<token>`) is captured as the pending invite so the app
    // forces sign-in/sign-up and auto-accepts it. Unrelated links are ignored.
    const onUrl = (url: string): void => {
      if (isApiOAuthCallback(url)) {
        void client.getSession();
        return;
      }
      const inviteToken = inviteTokenFromDeepLink(url);
      if (inviteToken !== null) setPendingInviteToken(inviteToken);
    };

    return api.onOauthCallback(onUrl);
  }, []);
}
