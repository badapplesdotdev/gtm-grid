/**
 * Registers the deep-link OAuth callback listener ONCE for the packaged desktop
 * app. Mounted once from `CloudProvider` (client.tsx) so it lives for the app's
 * whole lifetime. Outside Tauri (the web build) it does nothing, so the standard
 * web OAuth + email/password flows are completely unaffected.
 *
 * Unlike a code-exchange flow there is NO `code` to exchange: Better Auth
 * completes the OAuth handshake server-side and sets the session cookie BEFORE
 * redirecting to `gtmgrid://auth/callback`. So when our callback deep link
 * arrives we simply re-read the Better Auth session (`getSession`), which
 * refreshes the client's `useSession` subscribers to the now-authenticated
 * state. Unrelated deep links are ignored via the pure {@link isApiOAuthCallback}
 * guard.
 *
 * It listens on BOTH channels described by the Tauri deep-link docs:
 *   - the Rust-emitted "oauth-callback" Tauri event (covers single-instance
 *     forwarding + cold start), and
 *   - `@tauri-apps/plugin-deep-link`'s `onOpenUrl` (the JS-native channel).
 *
 * The Tauri plugin modules are imported lazily (only when `isTauri()`), so the
 * web bundle never pulls them in and they never run in a non-Tauri test/SSR
 * context.
 */

import { useEffect } from "react";
import { authClient } from "./client";
import { OAUTH_CALLBACK_EVENT, isTauri } from "./desktop-oauth";
import { isApiOAuthCallback } from "./api-auth";
import { inviteTokenFromDeepLink, setPendingInviteToken } from "./pendingInvite";

export function useApiDeepLinkOAuth(): void {
  useEffect(() => {
    if (!isTauri()) return;
    // `authClient` is non-null whenever this hook is mounted (CloudProvider only
    // renders under `cloudEnabled`), but guard for safety in tests/SSR.
    const client = authClient;
    if (client === null) return;

    let disposed = false;
    const cleanups: Array<() => void> = [];

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

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const unlistenEvent = await listen<string>(OAUTH_CALLBACK_EVENT, (e) => {
        onUrl(e.payload);
      });
      if (disposed) unlistenEvent();
      else cleanups.push(unlistenEvent);

      const deepLink = await import("@tauri-apps/plugin-deep-link");
      const unlistenDeepLink = await deepLink.onOpenUrl((urls) => {
        for (const url of urls) onUrl(url);
      });
      if (disposed) unlistenDeepLink();
      else cleanups.push(unlistenDeepLink);

      // Cold start: the app may have been launched BY the invite/oauth deep link,
      // which arrives before the listener is attached — replay the launch URLs.
      try {
        const current = await deepLink.getCurrent();
        if (!disposed && current) for (const url of current) onUrl(url);
      } catch {
        /* getCurrent unsupported on this platform — onOpenUrl still covers it */
      }
    })();

    return () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
    };
  }, []);
}
