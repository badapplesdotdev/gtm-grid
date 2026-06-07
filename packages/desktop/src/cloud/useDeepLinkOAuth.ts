/**
 * Registers the deep-link OAuth callback listener ONCE for the packaged desktop
 * app (C29). Mounted from {@link CloudProvider} so it lives for the app's whole
 * lifetime. Outside Tauri (the web build) it does nothing, so the existing web
 * OAuth (#17) and email/password flows are completely unaffected.
 *
 * It listens on BOTH channels described by the Tauri deep-link docs, deduped via
 * the shared {@link handleDeepLinkCallback} (which is a no-op when no flow is in
 * flight or the URL carries no code):
 *   - the Rust-emitted "oauth-callback" Tauri event (covers single-instance
 *     forwarding + cold start), and
 *   - `@tauri-apps/plugin-deep-link`'s `onOpenUrl` (the JS-native channel).
 *
 * The Tauri plugin modules are imported lazily (only when `isTauri()`), so the
 * web bundle never pulls them in and they never run in a non-Tauri test/SSR
 * context.
 */

import { useAuthActions } from "@convex-dev/auth/react";
import { useEffect } from "react";
import { authClient } from "./client";
import {
  OAUTH_CALLBACK_EVENT,
  handleDeepLinkCallback,
  isTauri,
  type SignIn,
} from "./desktop-oauth";
import { isApiOAuthCallback } from "./api-auth";

export function useDeepLinkOAuth(): void {
  const { signIn } = useAuthActions();

  useEffect(() => {
    if (!isTauri()) return;

    // `signIn` from Convex Auth matches our structural {@link SignIn} type; we
    // keep a typed reference so the lazy handlers below don't re-resolve it.
    const run: SignIn = signIn;
    let disposed = false;
    const cleanups: Array<() => void> = [];

    void (async () => {
      // Tauri event channel: Rust emits the incoming URL string as the payload.
      const { listen } = await import("@tauri-apps/api/event");
      const unlistenEvent = await listen<string>(OAUTH_CALLBACK_EVENT, (e) => {
        void handleDeepLinkCallback(e.payload, run);
      });
      if (disposed) unlistenEvent();
      else cleanups.push(unlistenEvent);

      // JS deep-link channel: the plugin's onOpenUrl fires with the URL list.
      const deepLink = await import("@tauri-apps/plugin-deep-link");
      const unlistenDeepLink = await deepLink.onOpenUrl((urls) => {
        for (const url of urls) void handleDeepLinkCallback(url, run);
      });
      if (disposed) unlistenDeepLink();
      else cleanups.push(unlistenDeepLink);
    })();

    return () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
    };
  }, [signIn]);
}

/**
 * The NEW-path deep-link OAuth listener (TRI-3252): the Better Auth counterpart
 * to {@link useDeepLinkOAuth}. Mounted once from `ApiCloudProvider` (client.tsx)
 * so it lives for the app's whole lifetime. Outside Tauri (the web build) it
 * does nothing.
 *
 * Unlike the Convex flow there is NO `code` to exchange: Better Auth completes
 * the OAuth handshake server-side and sets the session cookie BEFORE redirecting
 * to `gtmgrid://auth/callback`. So when our callback deep link arrives we simply
 * re-read the Better Auth session (`getSession`), which refreshes the client's
 * `useSession` subscribers to the now-authenticated state. Unrelated deep links
 * are ignored via the pure {@link isApiOAuthCallback} guard.
 *
 * The Tauri plugin modules are imported lazily (only when `isTauri()`), so the
 * web bundle never pulls them in.
 */
export function useApiDeepLinkOAuth(): void {
  useEffect(() => {
    if (!isTauri()) return;
    // `authClient` is non-null whenever this hook is mounted (ApiCloudProvider
    // only renders under `cloudViaApi`), but guard for safety in tests/SSR.
    const client = authClient;
    if (client === null) return;

    let disposed = false;
    const cleanups: Array<() => void> = [];

    // On our OAuth callback, re-read the session so `useSession` subscribers
    // observe the now-authenticated state. A no-op for unrelated deep links.
    const onCallback = (url: string): void => {
      if (!isApiOAuthCallback(url)) return;
      void client.getSession();
    };

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const unlistenEvent = await listen<string>(OAUTH_CALLBACK_EVENT, (e) => {
        onCallback(e.payload);
      });
      if (disposed) unlistenEvent();
      else cleanups.push(unlistenEvent);

      const deepLink = await import("@tauri-apps/plugin-deep-link");
      const unlistenDeepLink = await deepLink.onOpenUrl((urls) => {
        for (const url of urls) onCallback(url);
      });
      if (disposed) unlistenDeepLink();
      else cleanups.push(unlistenDeepLink);
    })();

    return () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
    };
  }, []);
}
