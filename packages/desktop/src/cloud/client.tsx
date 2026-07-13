/**
 * The Postgres-tier cloud client foundation for the desktop app.
 *
 * This is the SINGLE cloud foundation: the tRPC + Better Auth path is the only
 * path (the legacy Convex client was removed in the W5 cutover). It constructs,
 * in one place:
 *
 *   1. a typed tRPC client (`httpBatchLink` → the apps/web API at
 *      `VITE_API_URL`) over the `AppRouter` exported by apps/web — imported
 *      TYPE-ONLY so the desktop bundle never pulls the server in;
 *   2. a `@tanstack/react-query` `QueryClient` + provider;
 *   3. a Better Auth client (`createAuthClient`) with email+password sign
 *      in/up/out, OAuth (incl. the `gtmgrid://` desktop deep link), and the
 *      email-OTP verify + password-reset flows, persisting its own session.
 *
 * The desktop app is cloud-only: `VITE_API_URL` is REQUIRED and the cloud layer
 * is always on. `cloudEnabled` / `cloudViaApi` are kept as constant-`true` named
 * exports so the (many) historical call sites still compile.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";
import { useEffect, useRef, type ReactNode } from "react";
// TYPE-ONLY import of the server router contract over a relative path; importing
// the type erases at build time so no server code is bundled into the desktop app.
import type { AppRouter } from "../../../../apps/web/lib/trpc/root";
import { useApiDeepLinkOAuth } from "./useDeepLinkOAuth";

/**
 * The apps/web API base URL (Next.js host that serves both tRPC at `/api/trpc`
 * and Better Auth at `/api/auth`). Read once from Vite's `import.meta.env`; an
 * empty string is treated as unset. REQUIRED — the desktop app is cloud-only, so
 * a missing value is a fatal misconfiguration (see the throw below).
 */
export const API_URL: string | undefined =
  (import.meta.env.VITE_API_URL as string | undefined) || undefined;

// Fatal misconfiguration guard for a real run (dev or packaged prod): the build
// also fails fast on a missing value (vite.config.ts). Skipped under Vitest,
// where the module is imported with no Vite env and the network is mocked.
if (!API_URL && import.meta.env.MODE !== "test") {
  throw new Error("VITE_API_URL is required — the desktop app is cloud-only.");
}

/**
 * Whether the tRPC + Better Auth cloud layer is enabled. Always `true` now that
 * the desktop is cloud-only. Kept as a named export (a literal `true`) so the
 * many historical call sites that gate on it still compile.
 */
export const cloudViaApi = true;

/**
 * Alias of {@link cloudViaApi}; kept as a distinct constant-`true` export so the
 * call sites that read "is the cloud configured?" continue to compile.
 */
export const cloudEnabled = true;

/**
 * Base URL of the inbound-webhook receiver. The webhook setup form builds each
 * table's endpoint as `${INNGEST_URL}/api/webhooks/:token`. Read once from
 * Vite's `import.meta.env`; empty string is treated as unset. Falls back to a
 * documentation placeholder host when no deployment is wired so the form still
 * renders a copyable, clearly-non-live URL in OSS builds.
 */
export const INNGEST_URL: string =
  (import.meta.env.VITE_INNGEST_URL as string | undefined) ||
  "https://hooks.gtmgrid.app";

/** The tRPC HTTP endpoint on the apps/web host (`<API_URL>/api/trpc`). */
export function trpcUrl(apiUrl: string): string {
  // Tolerate a trailing slash on the configured base so both
  // "http://host" and "http://host/" produce a single-slash endpoint.
  return `${apiUrl.replace(/\/+$/, "")}/api/trpc`;
}

/** The Better Auth base URL on the apps/web host (`<API_URL>/api/auth`). */
export function authUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, "")}/api/auth`;
}

/**
 * The Better Auth client type produced by {@link createAuthClient} with the
 * email-OTP plugin. Exported so the (later) feature hooks and tests can type a
 * client reference without re-deriving the inference.
 */
export type CloudAuthClient = ReturnType<
  typeof createAuthClient<{ plugins: [ReturnType<typeof emailOTPClient>] }>
>;

/**
 * Bearer-token session store. The desktop runs in a custom-scheme webview
 * (`tauri://localhost`) whose cross-site cookies to the apps/web host are blocked
 * (WKWebview ITP), so we DON'T rely on the session cookie. Instead the Better
 * Auth `bearer` plugin returns a `set-auth-token` header on sign-in; we persist
 * it in localStorage and replay it as `Authorization: Bearer <token>` on every
 * auth + tRPC + sidecar call. Survives reloads like the old Convex JWT did.
 */
const AUTH_TOKEN_KEY = "gtmgrid:authToken";

export function getStoredAuthToken(): string | null {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredAuthToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(AUTH_TOKEN_KEY, token);
    else localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch {
    /* private mode / no storage — bearer just won't persist */
  }
}

/**
 * Build the Better Auth client against the given API base. Uses Bearer-token
 * sessions (see {@link getStoredAuthToken}): captures `set-auth-token` from each
 * response and sends the stored token on subsequent requests. `credentials:
 * "include"` is kept as a same-origin/web fallback. Pure + unit-testable.
 */
export function makeAuthClient(apiUrl: string): CloudAuthClient {
  return createAuthClient({
    baseURL: authUrl(apiUrl),
    fetchOptions: {
      credentials: "include",
      auth: { type: "Bearer", token: () => getStoredAuthToken() ?? "" },
      onSuccess(ctx) {
        const token = ctx.response.headers.get("set-auth-token");
        if (token) setStoredAuthToken(token);
      },
    },
    plugins: [emailOTPClient()],
  });
}

/**
 * Build the typed tRPC client against the given API base. Sends the stored Bearer
 * token (so each procedure authenticates without a cross-site cookie). Typed by
 * the apps/web `AppRouter` for end-to-end safety. Pure so it is unit-testable.
 */
export function makeTrpcClient(apiUrl: string) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: trpcUrl(apiUrl),
        headers() {
          const token = getStoredAuthToken();
          return token ? { Authorization: `Bearer ${token}` } : {};
        },
        fetch(input, init) {
          return fetch(input, { ...init, credentials: "include" });
        },
      }),
    ],
  });
}

/**
 * The shared Better Auth client. A module-level singleton so every
 * hook/component shares one session + one cookie jar. Always constructed now
 * that the desktop is cloud-only.
 */
export const authClient: CloudAuthClient = makeAuthClient(API_URL as string);

/**
 * The shared tRPC client. A module-level singleton mirroring {@link authClient}.
 */
export const apiClient: ReturnType<typeof makeTrpcClient> = makeTrpcClient(
  API_URL as string,
);

/**
 * Reconcile a workspace's cached plan with its live Autumn subscription, then
 * refetch `me` so the plan badge / billing panel reflect the result. Best-effort:
 * the desktop calls this on load, on window focus, and when billing opens so a
 * plan changed in Autumn (manual upgrade OR completed checkout) shows up without
 * a restart. Swallows errors (Autumn down / not a member) — the cached plan just
 * stays as-is. A no-op when the cloud layer is off.
 */
export async function syncWorkspacePlan(workspaceId: string): Promise<void> {
  try {
    await apiClient.billing.syncPlan.mutate({ workspaceId });
    await queryClient.invalidateQueries({ queryKey: ["workspaces", "me"] });
  } catch {
    /* best-effort refresh — leave the cached plan untouched on failure */
  }
}

/**
 * Build the react-query `QueryClient`. Defaults mirror a desktop app: refetch on
 * window focus so cloud changes made elsewhere (a teammate creating a table,
 * adding an integration key, etc.) show up when you return to the app — gated by
 * a 30s `staleTime` so the Tauri webview's noisy focus events don't thrash the
 * network (a query refetches on focus only once it's stale). A factory (not a
 * module singleton) so each provider mount — and each test — gets an isolated
 * cache.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: true,
        staleTime: 30_000,
      },
    },
  });
}

/**
 * The shared react-query client for the running app. A module singleton so the
 * provider and any imperative `apiClient` callers share one cache. Always
 * constructed (cheap, no network) but only mounted when {@link cloudViaApi}.
 */
export const queryClient: QueryClient = makeQueryClient();

/**
 * Mounts the desktop deep-link OAuth listener once (so it lives for the app's
 * whole lifetime). A no-op outside Tauri, so the web build is unaffected.
 */
function ApiDeepLinkOAuthBridge({ children }: { children: ReactNode }) {
  useApiDeepLinkOAuth();
  return <>{children}</>;
}

/**
 * Invalidate the react-query cache whenever the Better Auth session IDENTITY
 * changes (sign-in, sign-up, OAuth completion, sign-out). The `me` query — which
 * carries the user, workspaces AND the Autumn plan — is cached as `null` while
 * signed out and react-query has no idea a bearer token just appeared, so without
 * this the app stays "signed out" after an in-app sign-up and the plan badge goes
 * stale. Driven off the reactive `useSession` so it covers every auth path in one
 * place. Mounted only when the cloud layer is on (so `authClient` is non-null).
 */
function AuthQuerySync(): null {
  const session = authClient.useSession();
  const userId = session.data?.user?.id ?? null;
  const prev = useRef<string | null>(null);
  useEffect(() => {
    if (prev.current !== userId) {
      prev.current = userId;
      void queryClient.invalidateQueries();
    }
  }, [userId]);
  return null;
}

/**
 * Wrap the app in the cloud providers (react-query). The tRPC + Better Auth
 * clients are module singletons consumed directly by hooks, so the only React
 * provider needed is react-query's.
 *
 * The cloud layer is always on (the desktop is cloud-only), so the auth-query
 * sync and the deep-link OAuth bridge always mount alongside the react-query
 * provider.
 */
export function CloudProvider({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthQuerySync />
      <ApiDeepLinkOAuthBridge>{children}</ApiDeepLinkOAuthBridge>
    </QueryClientProvider>
  );
}
