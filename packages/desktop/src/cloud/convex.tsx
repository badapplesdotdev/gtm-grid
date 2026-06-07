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
import { ApiCloudProvider, cloudViaApi } from "./client";
import { isTauri } from "./desktop-oauth";
import { useDeepLinkOAuth } from "./useDeepLinkOAuth";

/**
 * The configured Convex deployment URL, or `undefined` for a cloud-less build.
 * Read once from Vite's `import.meta.env`. Empty string is treated as unset.
 */
export const CONVEX_URL: string | undefined =
  (import.meta.env.VITE_CONVEX_URL as string | undefined) || undefined;

/**
 * Whether the LEGACY Convex cloud layer is usable (a Convex deployment is
 * configured). Deliberately UNCHANGED by the strangler migration: the existing
 * Convex feature hooks (useCloudGrid.ts, auth.ts) gate on this, and this lane
 * does NOT rewire them — so they must stay no-ops whenever Convex is unset, even
 * when the NEW Postgres-tier path (`cloudViaApi`) is flipped on. The new path
 * has its own gate (`cloudViaApi`, ./client.tsx); the OSS/local invariant — no
 * provider, zero cloud calls when neither backend is set — is preserved by both
 * gates being false together.
 */
export const cloudEnabled = CONVEX_URL !== undefined;

/**
 * Base URL of the inbound-webhook receiver (apps/inngest, Wave 3). The webhook
 * setup form builds each table's endpoint as `${INNGEST_URL}/api/webhooks/:token`.
 * Read once from Vite's `import.meta.env`; empty string is treated as unset.
 * Falls back to a documentation placeholder host when no deployment is wired so
 * the form still renders a copyable, clearly-non-live URL in OSS builds.
 */
export const INNGEST_URL: string =
  (import.meta.env.VITE_INNGEST_URL as string | undefined) ||
  "https://hooks.gtmgrid.app";

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
 * Whether the auth provider should auto-read the OAuth `code` from
 * `window.location` (the WEB flow, #17). True on the web build; FALSE inside the
 * packaged Tauri app, where the `code` arrives via the deep-link callback and is
 * exchanged by {@link useDeepLinkOAuth} — letting the provider also read it would
 * double-handle the code. A plain function (not a closure over render state) so
 * Convex Auth can call it freely.
 */
function shouldHandleCode(): boolean {
  return !isTauri();
}

/**
 * Mounts the deep-link OAuth listener once inside the auth provider (so it can
 * use the Convex Auth hooks). Renders its children unchanged; the listener is a
 * no-op outside Tauri, so the web build is unaffected.
 */
function DeepLinkOAuthBridge({ children }: { children: ReactNode }) {
  useDeepLinkOAuth();
  return <>{children}</>;
}

/**
 * Wrap the app so cloud hooks work. The STRANGLER branch (TRI-3252):
 *
 *   - `VITE_API_URL` set  → mount the NEW Postgres-tier providers (tRPC +
 *     react-query + Better Auth) via {@link ApiCloudProvider}. The Convex
 *     client/provider are NOT constructed on this path.
 *   - else `VITE_CONVEX_URL` set → keep the legacy Convex path unchanged.
 *   - else (neither set) → a no-op pass-through, so the local-only app renders
 *     identically with zero cloud calls.
 *
 * Checking `cloudViaApi` FIRST means flipping the flag fully swaps the
 * foundation while leaving the entire Convex path intact behind it (W5 deletes
 * the Convex path; this lane only adds the flag).
 */
export function CloudProvider({ children }: { children: ReactNode }) {
  if (cloudViaApi) {
    return <ApiCloudProvider>{children}</ApiCloudProvider>;
  }
  if (convexClient === null) {
    return <>{children}</>;
  }
  return (
    <ConvexAuthProvider client={convexClient} shouldHandleCode={shouldHandleCode}>
      <DeepLinkOAuthBridge>{children}</DeepLinkOAuthBridge>
    </ConvexAuthProvider>
  );
}
