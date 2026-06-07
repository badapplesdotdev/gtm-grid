/**
 * The NEW Postgres-tier cloud client foundation for the desktop app (TRI-3252).
 *
 * This module is the strangler-fig REPLACEMENT for `convex.tsx`'s
 * `ConvexReactClient` + `ConvexAuthProvider`. It constructs, in one place:
 *
 *   1. a typed tRPC client (`httpBatchLink` → the apps/web API at
 *      `VITE_API_URL`) over the `AppRouter` exported by apps/web — imported
 *      TYPE-ONLY so the desktop bundle never pulls the server in;
 *   2. a `@tanstack/react-query` `QueryClient` + provider;
 *   3. a Better Auth client (`createAuthClient`) with email+password sign
 *      in/up/out, OAuth (incl. the `gtmgrid://` desktop deep link), and the
 *      email-OTP verify + password-reset flows, persisting its own session.
 *
 * STRANGLER FLAG — this foundation is mounted ONLY when `VITE_API_URL` is set
 * (`cloudViaApi`). When it is unset, `CloudProvider` (convex.tsx) keeps the
 * existing Convex path. Either way, when NO cloud backend is configured at all
 * (`cloudEnabled` false), no provider mounts and the local-only app issues zero
 * cloud calls. This lane builds the foundation + flag ONLY — it does not rewire
 * the feature hooks (later W4 lanes do that).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";
import type { ReactNode } from "react";
// TYPE-ONLY import of the server router contract. The relative path matches the
// established pattern desktop uses for `convex/_generated/api`; importing the
// type erases at build time so no server code is bundled.
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
 * Whether the NEW tRPC + Better Auth path is enabled. True iff `VITE_API_URL`
 * is configured. When false the app falls back to the legacy Convex provider
 * (or, if Convex is also unconfigured, to the local-only no-provider path).
 */
export const cloudViaApi = API_URL !== undefined;

/**
 * Which cloud foundation a build should mount, given which backends are
 * configured. Pure so the strangler PRECEDENCE is unit-testable without the
 * module-level env:
 *   - `apiUrl` set            → `"api"`  (NEW tRPC + Better Auth path; wins)
 *   - else `convexUrl` set    → `"convex"` (legacy path, kept working)
 *   - else                    → `"local"` (no provider; zero cloud calls)
 * The new path takes precedence so flipping the flag fully swaps the foundation.
 */
export function selectCloudPath(
  apiUrl: string | undefined,
  convexUrl: string | undefined,
): "api" | "convex" | "local" {
  if (apiUrl !== undefined && apiUrl !== "") return "api";
  if (convexUrl !== undefined && convexUrl !== "") return "convex";
  return "local";
}

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
 * Build the Better Auth client against the given API base. Cookies/session are
 * persisted by Better Auth itself (it replaces the Convex Auth localStorage JWT
 * at convex.tsx:16). `fetchOptions.credentials: "include"` so the session
 * cookie rides cross-origin from the Tauri webview to the apps/web host. Pure +
 * deterministic so it is unit-testable without a live server.
 */
export function makeAuthClient(apiUrl: string): CloudAuthClient {
  return createAuthClient({
    baseURL: authUrl(apiUrl),
    fetchOptions: { credentials: "include" },
    plugins: [emailOTPClient()],
  });
}

/**
 * Build the typed tRPC client against the given API base. `httpBatchLink`
 * batches concurrent calls into one request and sends credentials so the Better
 * Auth session cookie authenticates each call. Typed by the apps/web
 * `AppRouter` so every procedure is end-to-end type-safe. Pure so client
 * construction is unit-testable offline.
 */
export function makeTrpcClient(apiUrl: string) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: trpcUrl(apiUrl),
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
 * Wrap the app in the NEW cloud providers (react-query). The tRPC + Better Auth
 * clients are module singletons consumed directly by hooks, so the only React
 * provider needed is react-query's. A no-op pass-through when the new path is
 * disabled, so the legacy/local app renders identically with zero new-path
 * calls.
 */
export function ApiCloudProvider({ children }: { children: ReactNode }) {
  if (!cloudViaApi) {
    return <>{children}</>;
  }
  return (
    <QueryClientProvider client={queryClient}>
      <ApiDeepLinkOAuthBridge>{children}</ApiDeepLinkOAuthBridge>
    </QueryClientProvider>
  );
}
