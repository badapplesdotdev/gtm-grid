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
 * The cloud layer is mounted ONLY when `VITE_API_URL` is set (`cloudEnabled` /
 * `cloudViaApi`). When it is unset (an OSS / local-only build), no provider
 * mounts and the local sidecar app issues zero cloud calls — the local SQLite
 * engine path is entirely unaffected.
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
 * empty string is treated as unset. Presence of this var is the strangler FLAG
 * that selects the new Postgres-tier path over the legacy Convex path.
 */
export const API_URL: string | undefined =
  (import.meta.env.VITE_API_URL as string | undefined) || undefined;

/**
 * Whether the tRPC + Better Auth cloud layer is enabled. True iff `VITE_API_URL`
 * is configured. When false the app runs local-only (no provider, zero cloud
 * calls). `cloudEnabled` is the alias the feature hooks/components gate on; both
 * names mean the same thing now that the new path is the only path.
 */
export const cloudViaApi = API_URL !== undefined;

/**
 * Whether the cloud layer is usable (an apps/web API is configured). Identical
 * to {@link cloudViaApi}; kept as a distinct export so the many call sites that
 * gate cloud reads/writes on "is the cloud configured?" read naturally. The
 * OSS/local invariant — no provider, zero cloud calls when unset — holds because
 * both gates are the same single flag.
 */
export const cloudEnabled = cloudViaApi;

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
 * The shared Better Auth client, or `null` when the new path is disabled. A
 * module-level singleton so every hook/component shares one session + one
 * cookie jar. `null` on the legacy/local path so nothing here ever runs.
 */
export const authClient: CloudAuthClient | null = cloudViaApi
  ? makeAuthClient(API_URL as string)
  : null;

/**
 * The shared tRPC client, or `null` when the new path is disabled. A
 * module-level singleton mirroring {@link authClient}.
 */
export const apiClient: ReturnType<typeof makeTrpcClient> | null = cloudViaApi
  ? makeTrpcClient(API_URL as string)
  : null;

/**
 * Reconcile a workspace's cached plan with its live Autumn subscription, then
 * refetch `me` so the plan badge / billing panel reflect the result. Best-effort:
 * the desktop calls this on load, on window focus, and when billing opens so a
 * plan changed in Autumn (manual upgrade OR completed checkout) shows up without
 * a restart. Swallows errors (Autumn down / not a member) — the cached plan just
 * stays as-is. A no-op when the cloud layer is off.
 */
export async function syncWorkspacePlan(workspaceId: string): Promise<void> {
  if (apiClient === null) return;
  try {
    await apiClient.billing.syncPlan.mutate({ workspaceId });
    await queryClient.invalidateQueries({ queryKey: ["workspaces", "me"] });
  } catch {
    /* best-effort refresh — leave the cached plan untouched on failure */
  }
}

/**
 * Build the react-query `QueryClient`. Defaults mirror a desktop app: no
 * window-focus refetch (the Tauri webview's focus events are noisy) and a short
 * stale time so cloud reads stay fresh without thrashing. A factory (not a
 * module singleton) so each provider mount — and each test — gets an isolated
 * cache.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
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
  const session = authClient!.useSession();
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
 * The `QueryClientProvider` is mounted UNCONDITIONALLY — even local-only (no
 * `VITE_API_URL`) builds. `App` always calls react-query hooks (`useMe`, etc.);
 * those queries are disabled when cloud is off, but `useQuery` still calls
 * `useQueryClient()`, which throws "No QueryClient set" if no provider is mounted
 * — crashing the whole app to a blank screen for every OSS user with no env vars.
 * The client is constructed lazily and issues zero network calls, so this is free
 * in local mode. Only the cloud-specific deep-link OAuth bridge stays gated.
 */
export function CloudProvider({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      {cloudEnabled ? (
        <>
          <AuthQuerySync />
          <ApiDeepLinkOAuthBridge>{children}</ApiDeepLinkOAuthBridge>
        </>
      ) : (
        children
      )}
    </QueryClientProvider>
  );
}
