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
import {
  OAUTH_CALLBACK_EVENT,
  handleDeepLinkCallback,
  isTauri,
  type SignIn,
} from "./desktop-oauth";

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
