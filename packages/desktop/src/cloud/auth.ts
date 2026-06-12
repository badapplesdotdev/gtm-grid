/**
 * Cloud auth + workspace hooks.
 *
 * React hooks (`useMe`, `useActiveWorkspace`, `useAuthState`, `useAccountActions`)
 * the account-bar UI binds to. They read the tRPC `workspaces.me` /
 * `auth.enabledProviders` / `workspaces.listMembers` queries via react-query and
 * drive auth through the Better Auth client, and add an "active workspace"
 * selection persisted in `localStorage`.
 *
 * The auth paths are **email + password** and **OAuth** (GitHub + Google). The
 * web build uses the standard Better Auth same-window redirect; the PACKAGED
 * desktop app uses the native Tauri deep-link flow: `signInWithProvider` opens
 * the provider in the system browser and the session is completed from the
 * `gtmgrid://auth/callback` deep link (see ./useDeepLinkOAuth.ts). The runtime
 * branch is selected by `isTauri()` (see ./desktop-oauth.ts).
 *
 * The local-only app is untouched: every hook degrades to a signed-out / null
 * shape when no apps/web API is configured (`cloudEnabled` false), and nothing
 * here runs unless the user explicitly signs in.
 */

import { useQuery as useReactQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { Id } from "./ids";
import { apiClient, authClient, cloudEnabled, setStoredAuthToken } from "./client";
import { chooseOAuthFlow, isTauri } from "./desktop-oauth";
import { apiOAuthCallbackUrl, unwrapAuthResult } from "./api-auth";

// ─── Shared types (mirror the tRPC `workspaces.me` query result) ────────────

/** Seat usage for a workspace: members used vs. the plan limit (null = free). */
export interface SeatUsage {
  readonly used: number;
  readonly limit: number | null;
}

/** The workspace's current plan (C27): the paid plan id + human name. */
export interface WorkspacePlan {
  /** "team" | "business" | "unlimited", or null for the free tier. */
  readonly id: string | null;
  /** Human name: "Free" | "Team" | "Business" | "Unlimited". */
  readonly name: string;
  /** Epoch ms the trial ends, or null when not trialing. Drives the countdown. */
  readonly trialEndsAt: number | null;
}

/** A workspace the signed-in user belongs to, with their role + seat usage. */
export interface WorkspaceSummary {
  readonly _id: Id<"workspaces">;
  readonly name: string;
  readonly role: "owner" | "admin" | "member";
  readonly seatUsage: SeatUsage;
  /** The workspace's current plan (C27), for the plan badge + upgrade UI. */
  readonly plan: WorkspacePlan;
  /**
   * Cloud-actions usage (C26): metered cloud operations used vs. the plan limit
   * (`limit` null = unlimited/unknown). Mirrors the `me` query so the Plan &
   * billing view can show "actions used / limit".
   */
  readonly cloudActions: SeatUsage;
}

/** The authenticated user as returned by the `me` query. */
export interface MeUser {
  readonly _id: Id<"users">;
  readonly name: string | null;
  readonly email: string | null;
  readonly image: string | null;
}

/** The full `me` result: the user plus the workspaces they can access. */
export interface Me {
  readonly user: MeUser;
  readonly workspaces: readonly WorkspaceSummary[];
}

/** A single workspace member as returned by the `listMembers` query (T10). */
export interface WorkspaceMember {
  readonly _id: Id<"members">;
  readonly userId: string;
  readonly role: "owner" | "admin" | "member";
  readonly createdAt: number;
  readonly name: string | null;
  readonly email: string | null;
  readonly image: string | null;
}

/** The `listMembers` result: the roster + seat usage for the settings view. */
export interface WorkspaceMembers {
  readonly members: readonly WorkspaceMember[];
  readonly seatUsage: SeatUsage;
}

// ─── OAuth providers (C17, web redirect flow) ────────────────────────────────

/** The OAuth providers we support, matching the ids the apps/web auth registers. */
export type OAuthProvider = "github" | "google";

/**
 * Which OAuth providers are enabled on the deployment (mirrors the
 * `auth.enabledProviders` query). Booleans only — never any secret.
 */
export interface EnabledProviders {
  readonly github: boolean;
  readonly google: boolean;
  /** Whether email verification + password reset are active (Resend configured). */
  readonly emailAuth: boolean;
}

/** When the providers query is unavailable (loading / cloud off), nothing is enabled. */
const NO_PROVIDERS: EnabledProviders = {
  github: false,
  google: false,
  emailAuth: false,
};

/**
 * The list of enabled OAuth providers, in display order, derived from the
 * enabled-providers flags. Pure so the gating (which buttons render, and whether
 * the OAuth row shows at all) is unit-testable without React:
 *   - no flags / all false → `[]` (caller hides the OAuth row + divider)
 *   - only one enabled     → just that provider
 */
export function enabledProviderList(
  providers: EnabledProviders | undefined,
): readonly OAuthProvider[] {
  if (providers === undefined) return [];
  const list: OAuthProvider[] = [];
  if (providers.google) list.push("google");
  if (providers.github) list.push("github");
  return list;
}

// ─── React hooks ─────────────────────────────────────────────────────────────

/**
 * The reactive `me` query result: the user + their workspaces, or `null` when
 * signed out / cloud-disabled, or `undefined` while loading.
 */
export function useMe(): Me | null | undefined {
  // Read `workspaces.me` through the tRPC client via react-query. When the cloud
  // layer is off (`apiClient` null) the query is disabled, so a local-only build
  // issues zero cloud calls and the hook resolves to `null` (signed out).
  const { data, isPending } = useReactQuery({
    queryKey: ["workspaces", "me"],
    queryFn: () => apiClient!.workspaces.me.query(),
    enabled: apiClient !== null,
    // `me` carries the Autumn plan/seat state, which can change OUTSIDE the app
    // (a manual upgrade in Autumn, a teammate's change). Refetch when the user
    // returns to the window and keep it briefly stale, so the plan badge and
    // billing panel reflect external changes without an app restart. Overrides
    // the query-client default (`refetchOnWindowFocus: false`) for this one query.
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });
  if (apiClient === null) return null;
  return isPending ? undefined : (data as unknown as Me | null);
}

/**
 * The OAuth providers enabled on the deployment (C17), as a stable list in
 * display order. Reactively reads `auth.enabledProviders`; returns `[]` while
 * loading or when cloud is off, so the OAuth row is hidden until we know a
 * provider is actually configured. No secrets are ever read — booleans only.
 */
export function useEnabledProviders(): readonly OAuthProvider[] {
  const providers = useApiEnabledProviders();
  return useMemo(
    () => enabledProviderList(cloudEnabled ? providers : NO_PROVIDERS),
    [providers],
  );
}

/**
 * The enabled-providers read: the booleans-only flags from the tRPC
 * `auth.enabledProviders` query via react-query, or `undefined` while loading
 * (so the OAuth row stays hidden until we know a provider is configured). The
 * query is disabled when the cloud layer is off. Shared by
 * {@link useEnabledProviders} and {@link useEmailAuthEnabled}.
 */
function useApiEnabledProviders(): EnabledProviders | undefined {
  const { data } = useReactQuery({
    queryKey: ["auth", "enabledProviders"],
    queryFn: () => apiClient!.auth.enabledProviders.query(),
    enabled: apiClient !== null,
  });
  return data ?? undefined;
}

/**
 * Whether email-backed account flows (sign-up VERIFICATION + password RESET) are
 * active on the deployment (Resend configured). The UI shows the verification
 * code step + "Forgot password?" only when true — otherwise no email would ever
 * arrive. Defaults to false while loading / when cloud is off.
 */
export function useEmailAuthEnabled(): boolean {
  const providers = useApiEnabledProviders();
  return cloudEnabled ? (providers?.emailAuth ?? false) : false;
}

/**
 * The reactive `listMembers` query result for a workspace: the roster + seat
 * usage, or `undefined` while loading / when cloud is off / no workspace active.
 * Backs the workspace settings (members + seats) view (T10).
 */
export function useMembers(
  workspaceId: Id<"workspaces"> | null,
): WorkspaceMembers | undefined {
  const { data } = useReactQuery({
    queryKey: ["workspaces", "listMembers", workspaceId],
    queryFn: () =>
      apiClient!.workspaces.listMembers.query({
        workspaceId: workspaceId as string,
      }),
    // Disabled (so it issues no call) until the cloud layer is on AND a
    // workspace is selected.
    enabled: apiClient !== null && workspaceId !== null,
  });
  return (data as unknown as WorkspaceMembers | undefined) ?? undefined;
}

/**
 * Auth state: whether we are signed in and whether it is still loading. On the
 * NEW path this reflects the Better Auth session (`authClient.useSession`); on
 * When no cloud backend is configured at all (`authClient` null), a stable
 * signed-out/loaded state is returned without calling any hook.
 */
export function useAuthState(): { isAuthenticated: boolean; isLoading: boolean } {
  // Derive from the Better Auth session. `authClient` is non-null whenever the
  // cloud layer is on; `useSession` is reactive (re-renders on sign in/out and
  // OAuth completion). `authClient` is a module constant, so the hook order is
  // stable across renders.
  if (authClient !== null) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- module-constant branch.
    const session = authClient.useSession();
    return {
      isAuthenticated: session.data != null,
      isLoading: session.isPending,
    };
  }
  // No cloud layer configured → stable signed-out/loaded state, no hook called.
  return { isAuthenticated: false, isLoading: false };
}

const ACTIVE_WS_KEY = "gtmgrid:activeWorkspace";

/**
 * Resolve which workspace is "active" given the user's workspaces and the id
 * stored in `localStorage`. Pure so it can be unit-tested without React:
 *   - no workspaces            → `null`
 *   - stored id still present  → that workspace
 *   - stored id stale / unset  → the first workspace (stable default)
 */
export function resolveActiveWorkspace(
  workspaces: readonly WorkspaceSummary[],
  storedId: string | null,
): WorkspaceSummary | null {
  if (workspaces.length === 0) return null;
  return workspaces.find((w) => w._id === storedId) ?? workspaces[0];
}

// ─── Active-workspace shared store (single source of truth) ────────────────────
//
// The selected workspace id is a SINGLE shared value, not per-hook state. Every
// consumer (App, the plan badge, the dropdown) subscribes to the same module
// store via `useSyncExternalStore`, so calling `setActiveWorkspaceId` anywhere
// re-renders all of them consistently. The store wraps `localStorage` for
// persistence and listens for cross-window `storage` events so a second app
// window stays in sync. None of this runs any Convex calls; it is pure client
// state, leaving the local-only path untouched.

/** Read the persisted active-workspace id, tolerating storage being unavailable. */
function readStoredWorkspaceId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_WS_KEY);
  } catch {
    return null;
  }
}

/**
 * The active-workspace id store: a tiny observable over `localStorage`. Exposed
 * for direct (React-free) unit testing of the subscribe/snapshot/set contract.
 */
export const activeWorkspaceStore = (() => {
  const listeners = new Set<() => void>();
  // In-memory mirror of the persisted id so `getSnapshot` is stable (returns the
  // same reference until an actual change), which `useSyncExternalStore` requires.
  let current: string | null = readStoredWorkspaceId();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const handleStorage = (event: StorageEvent) => {
    // A change in another window: re-sync from storage and notify subscribers.
    if (event.key !== null && event.key !== ACTIVE_WS_KEY) return;
    const next = readStoredWorkspaceId();
    if (next === current) return;
    current = next;
    emit();
  };

  return {
    subscribe(listener: () => void): () => void {
      if (listeners.size === 0 && typeof window !== "undefined") {
        window.addEventListener("storage", handleStorage);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && typeof window !== "undefined") {
          window.removeEventListener("storage", handleStorage);
        }
      };
    },
    getSnapshot(): string | null {
      return current;
    },
    set(id: string): void {
      if (id === current) return;
      current = id;
      try {
        localStorage.setItem(ACTIVE_WS_KEY, id);
      } catch {
        /* ignore storage failures (private mode, etc.) */
      }
      emit();
    },
  };
})();

/**
 * The active workspace selection, backed by a single shared store so all
 * consumers observe the same value and re-render together when it changes.
 * Persisted in `localStorage` and validated against the workspaces the user can
 * actually access (so a stale id from a removed workspace falls back to the
 * first available one).
 *
 * Default selection: when signed in with no current (or stale) selection, this
 * persists the first workspace's id so a freshly signed-in client — or a second
 * window — shows that workspace immediately instead of "Local workspace".
 */
export function useActiveWorkspace(me: Me | null | undefined): {
  activeWorkspace: WorkspaceSummary | null;
  setActiveWorkspaceId: (id: Id<"workspaces">) => void;
} {
  const storedId = useSyncExternalStore(
    activeWorkspaceStore.subscribe,
    activeWorkspaceStore.getSnapshot,
    activeWorkspaceStore.getSnapshot,
  );

  const setActiveWorkspaceId = useCallback((id: Id<"workspaces">) => {
    activeWorkspaceStore.set(id);
  }, []);

  const activeWorkspace = useMemo<WorkspaceSummary | null>(
    () => resolveActiveWorkspace(me?.workspaces ?? [], storedId),
    [me, storedId],
  );

  // Persist the resolved default so the selection is shared and durable: once a
  // workspace is resolved that differs from what is stored (no/stale selection),
  // write it back. This makes a freshly signed-in client — or a second window —
  // land on a real workspace rather than falling back to "Local workspace" until
  // the user picks one manually. Done in an effect (not during render) so the
  // store notification happens after commit, never mid-render.
  const resolvedId = activeWorkspace?._id ?? null;
  useEffect(() => {
    if (resolvedId !== null && resolvedId !== storedId) {
      activeWorkspaceStore.set(resolvedId);
    }
  }, [resolvedId, storedId]);

  return { activeWorkspace, setActiveWorkspaceId };
}

/** The account-actions surface the UI binds to, identical across both paths. */
export interface AccountActions {
  /**
   * Email + password sign-in / sign-up. Returns `{ signingIn }`: `false` when a
   * sign-up needs email verification before the session starts (call
   * {@link AccountActions.verifyEmailCode}), `true` once the session is active.
   */
  readonly signInWithPassword: (
    email: string,
    password: string,
    flow: "signIn" | "signUp",
  ) => Promise<{ signingIn: boolean }>;
  /** OAuth sign-in (web redirect or desktop deep link), per the runtime. */
  readonly signInWithProvider: (provider: OAuthProvider) => Promise<void>;
  /** Complete sign-up by verifying the emailed OTP; on success the session starts. */
  readonly verifyEmailCode: (email: string, code: string) => Promise<void>;
  /** Begin a password reset: email a one-time code to `email`. */
  readonly requestPasswordReset: (email: string) => Promise<void>;
  /** Finish a password reset: verify the code and set `newPassword`. */
  readonly resetPasswordWithCode: (
    email: string,
    code: string,
    newPassword: string,
  ) => Promise<void>;
  /** Sign out of the current session. */
  readonly signOut: () => Promise<unknown>;
}

/**
 * Account actions for the UI: sign in (email + password OR OAuth provider), sign
 * out, OTP verification, and password reset. Driven by the Better Auth client:
 *   - sign-in / sign-up → `authClient.signIn.email` / `signUp.email`. When the
 *     deployment requires email verification, a sign-up returns no session and
 *     Better Auth sends the OTP, so we report `signingIn: false` to drive the
 *     verification step; a successful session reports `signingIn: true`.
 *   - verify / reset → the email-OTP plugin endpoints (`emailOtp.verifyEmail`,
 *     `forgetPassword.emailOtp`, `emailOtp.resetPassword`).
 *   - OAuth → `signIn.social`: a same-window redirect on the web build, or
 *     (packaged Tauri) the provider URL opened in the system browser, completed
 *     by the deep-link listener (useApiDeepLinkOAuth) re-reading the session.
 *
 * Better Auth RESOLVES `{ error }` instead of throwing, so every call is run
 * through {@link unwrapAuthResult}, which re-raises a real `Error` — preserving
 * the UI's `try/catch` + {@link friendlyAuthError} contract. `authClient` is
 * non-null whenever the cloud layer is on; the account bar only renders the
 * sign-in UI when it is.
 */
export function useAccountActions(): AccountActions {
  const client = authClient!;

  const signInWithPassword = useCallback(
    async (
      email: string,
      password: string,
      flow: "signIn" | "signUp",
    ): Promise<{ signingIn: boolean }> => {
      if (flow === "signUp") {
        // Better Auth requires a `name`; the account bar collects only email +
        // password, so default it to the email (the onboarding flow can update
        // the profile later). When verification is required, `data.token` is
        // absent (no session) and the OTP was emailed → signingIn:false.
        const result = unwrapAuthResult(
          await client.signUp.email({ email, password, name: email }),
        );
        const token = (result as { token?: string | null } | null)?.token;
        return { signingIn: token != null };
      }
      unwrapAuthResult(await client.signIn.email({ email, password }));
      return { signingIn: true };
    },
    [client],
  );

  const verifyEmailCode = useCallback(
    async (email: string, code: string): Promise<void> => {
      unwrapAuthResult(await client.emailOtp.verifyEmail({ email, otp: code }));
    },
    [client],
  );

  const requestPasswordReset = useCallback(
    async (email: string): Promise<void> => {
      unwrapAuthResult(await client.forgetPassword.emailOtp({ email }));
    },
    [client],
  );

  const resetPasswordWithCode = useCallback(
    async (email: string, code: string, newPassword: string): Promise<void> => {
      unwrapAuthResult(
        await client.emailOtp.resetPassword({
          email,
          otp: code,
          password: newPassword,
        }),
      );
    },
    [client],
  );

  const signInWithProvider = useCallback(
    async (provider: OAuthProvider): Promise<void> => {
      if (chooseOAuthFlow(isTauri()) === "web") {
        // Web: same-window redirect to the provider, completed by Better Auth's
        // callback which sets the session cookie and returns to the app.
        unwrapAuthResult(await client.signIn.social({ provider }));
        return;
      }
      // Packaged Tauri: ask Better Auth for the provider URL WITHOUT navigating
      // (`disableRedirect`), open it in the system browser, and let the deep-link
      // listener re-read the session when `gtmgrid://auth/callback` returns.
      const result = unwrapAuthResult(
        await client.signIn.social({
          provider,
          callbackURL: apiOAuthCallbackUrl(),
          disableRedirect: true,
        }),
      ) as { url?: string | null } | null;
      const url = result?.url;
      if (url == null || url.length === 0) {
        throw new Error("OAuth provider did not return a redirect URL.");
      }
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    },
    [client],
  );

  const signOut = useCallback(async (): Promise<unknown> => {
    const r = await client.signOut();
    setStoredAuthToken(null); // drop the persisted Bearer token on sign-out
    return r;
  }, [client]);

  return {
    signInWithPassword,
    signInWithProvider,
    verifyEmailCode,
    requestPasswordReset,
    resetPasswordWithCode,
    signOut,
  };
}

/**
 * Create a workspace, returning its id. Calls the tRPC
 * `workspaces.createWorkspace` mutation via the apps/web client. Returned as a
 * single callable the account bar + onboarding flow share.
 *
 * The id is returned as the `Id<"workspaces">` (a plain string) the UI threads
 * through to the active-workspace store.
 */
export function useCreateWorkspace(): (
  name: string,
) => Promise<Id<"workspaces">> {
  return useCallback(
    async (name: string) =>
      (await apiClient!.workspaces.createWorkspace.mutate({
        name,
      })) as Id<"workspaces">,
    [],
  );
}
