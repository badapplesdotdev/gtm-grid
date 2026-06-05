/**
 * Convex client + auth provider for the desktop app (T8).
 *
 * This is the single place that constructs the {@link ConvexReactClient} (from
 * `VITE_CONVEX_URL`) and wraps the app in {@link ConvexAuthProvider} so the rest
 * of the UI can call Convex queries/mutations and the Convex Auth hooks.
 *
 * IMPORTANT — additive, never breaks the local path:
 *   - When `VITE_CONVEX_URL` is absent (e.g. an OSS build with no cloud
 *     deployment configured) we render the children WITHOUT a Convex provider.
 *     The whole cloud layer then degrades to "signed out / local only": the
 *     `useMe()` hook returns `null`, the account bar shows "Sign in", and the
 *     local sidecar path is entirely unaffected. The local app stays 100%
 *     offline-capable with no Convex deployment at all.
 *   - When the URL is present we build the client once (module singleton) and
 *     mount the auth provider. Convex Auth persists its JWT in `localStorage`,
 *     so the session survives reloads automatically.
 */

import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";

/**
 * The configured Convex deployment URL, or `undefined` for a cloud-less build.
 * Read once from Vite's `import.meta.env`. Empty string is treated as unset.
 */
export const CONVEX_URL: string | undefined =
  (import.meta.env.VITE_CONVEX_URL as string | undefined) || undefined;

/** Whether a Convex deployment is configured (i.e. the cloud layer is usable). */
export const cloudEnabled = CONVEX_URL !== undefined;

/**
 * The shared Convex React client, or `null` when no deployment is configured.
 * A module-level singleton so every hook/component shares one client + one
 * websocket. `unsavedChangesWarning: false` because Tauri's webview has no
 * meaningful "before unload" UX.
 */
export const convexClient: ConvexReactClient | null = cloudEnabled
  ? new ConvexReactClient(CONVEX_URL as string, {
      unsavedChangesWarning: false,
    })
  : null;

/**
 * Wrap the app so cloud hooks work. A no-op pass-through when the cloud layer is
 * disabled, so the local-only app renders identically with zero Convex calls.
 */
export function CloudProvider({ children }: { children: ReactNode }) {
  if (convexClient === null) {
    return <>{children}</>;
  }
  return (
    <ConvexAuthProvider client={convexClient}>{children}</ConvexAuthProvider>
  );
}
