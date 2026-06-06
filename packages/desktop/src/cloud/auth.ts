/**
 * Cloud auth + workspace hooks (T8).
 *
 * React hooks (`useMe`, `useActiveWorkspace`, `useAuthState`, `useAccountActions`)
 * the account-bar UI binds to. They wrap the Convex Auth React API
 * (`@convex-dev/auth/react`) + the reactive `me` query, and add an "active
 * workspace" selection persisted in `localStorage`.
 *
 * The auth paths are **email + password** (Convex Auth's Password provider) and
 * **OAuth web redirect** (GitHub + Google, configured in `convex/auth.ts`). The
 * OAuth path uses the STANDARD Convex Auth browser redirect: `signIn(provider)`
 * redirects to the provider, back to the Convex callback, then back to the app.
 * Which providers are enabled is exposed by the `auth.enabledProviders` query
 * (booleans only) so the UI shows a button per enabled provider and hides the
 * whole OAuth row when none are enabled.
 *
 * The PACKAGED desktop app additionally supports the native Tauri deep-link
 * OAuth flow (C29): `signInWithProvider` opens the provider in the system
 * browser and the session is completed from the `gtmgrid://auth/callback` deep
 * link. The runtime branch is selected by `isTauri()` (see ./desktop-oauth.ts).
 *
 * The local-only app is untouched: every hook degrades to a signed-out / null
 * shape when no Convex deployment is configured, and nothing here runs unless
 * the user explicitly signs in.
 */

import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { cloudEnabled } from "./convex";
import { chooseOAuthFlow, isTauri, startDesktopOAuth } from "./desktop-oauth";

// ─── Shared types (mirror the `me` query in convex/workspaces.ts) ───────────

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
}

/** The `listMembers` result: the roster + seat usage for the settings view. */
export interface WorkspaceMembers {
  readonly members: readonly WorkspaceMember[];
  readonly seatUsage: SeatUsage;
}

// ─── OAuth providers (C17, web redirect flow) ────────────────────────────────

/** The OAuth providers we support, matching the ids registered in convex/auth.ts. */
export type OAuthProvider = "github" | "google";

/**
 * Which OAuth providers are enabled on the deployment (mirrors the
 * `auth.enabledProviders` query). Booleans only — never any secret.
 */
export interface EnabledProviders {
  readonly github: boolean;
  readonly google: boolean;
}

/** When the providers query is unavailable (loading / cloud off), nothing is enabled. */
const NO_PROVIDERS: EnabledProviders = { github: false, google: false };

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
  // `skip` the query entirely when the cloud layer is off, so a local-only
  // build issues zero Convex calls.
  return useQuery(api.workspaces.me, cloudEnabled ? {} : "skip") as
    | Me
    | null
    | undefined;
}

/**
 * The OAuth providers enabled on the deployment (C17), as a stable list in
 * display order. Reactively reads `auth.enabledProviders`; returns `[]` while
 * loading or when cloud is off, so the OAuth row is hidden until we know a
 * provider is actually configured. No secrets are ever read — booleans only.
 */
export function useEnabledProviders(): readonly OAuthProvider[] {
  const providers = useQuery(
    api.auth.enabledProviders,
    cloudEnabled ? {} : "skip",
  ) as EnabledProviders | undefined;
  return useMemo(
    () => enabledProviderList(cloudEnabled ? providers : NO_PROVIDERS),
    [providers],
  );
}

/**
 * The reactive `listMembers` query result for a workspace: the roster + seat
 * usage, or `undefined` while loading / when cloud is off / no workspace active.
 * Backs the workspace settings (members + seats) view (T10).
 */
export function useMembers(
  workspaceId: Id<"workspaces"> | null,
): WorkspaceMembers | undefined {
  return useQuery(
    api.workspaces.listMembers,
    cloudEnabled && workspaceId !== null ? { workspaceId } : "skip",
  ) as WorkspaceMembers | undefined;
}

/** Convex auth state: whether we are signed in and whether it is still loading. */
export function useAuthState(): { isAuthenticated: boolean; isLoading: boolean } {
  // `useConvexAuth` requires the provider; when cloud is disabled there is no
  // provider, so report a stable signed-out/loaded state without calling it.
  if (!cloudEnabled) {
    return { isAuthenticated: false, isLoading: false };
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks -- `cloudEnabled` is a
  // module constant, so this branch is stable across renders.
  return useConvexAuth();
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

/**
 * Account actions for the UI: sign in (email + password OR OAuth provider), sign
 * out, and create a workspace. Wraps the Convex Auth actions + the
 * `createWorkspace` mutation. All no-ops when cloud is off.
 */
export function useAccountActions() {
  const { signIn, signOut } = useAuthActions();

  /** Direct email + password sign-in (the active provider on the dev backend). */
  const signInWithPassword = useCallback(
    async (
      email: string,
      password: string,
      flow: "signIn" | "signUp",
    ): Promise<void> => {
      await signIn("password", { email, password, flow });
    },
    [signIn],
  );

  /**
   * OAuth sign-in, branching on the runtime (C29):
   *
   *   - WEB build → the STANDARD Convex Auth web redirect (C17): `signIn(provider)`
   *     navigates the browser to the provider, back to the Convex callback
   *     (`<SITE>/api/auth/callback/<provider>`), then back to the app at
   *     `SITE_URL`. The provider's `shouldHandleCode` auto-reads the returned
   *     `code` from the URL.
   *
   *   - PACKAGED TAURI app → the native deep-link flow: ask Convex Auth for the
   *     provider redirect URL (`redirectTo: gtmgrid://auth/callback`), open it in
   *     the SYSTEM browser, and let {@link useDeepLinkOAuth} complete the session
   *     when the `gtmgrid://auth/callback?code=…` deep link returns.
   *
   * The single {@link isTauri} helper selects the branch, so the web flow is
   * unchanged. The opener plugin is imported lazily (Tauri-only) so the web
   * bundle never loads it.
   */
  const signInWithProvider = useCallback(
    async (provider: OAuthProvider): Promise<void> => {
      if (chooseOAuthFlow(isTauri()) === "web") {
        await signIn(provider);
        return;
      }
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await startDesktopOAuth(provider, signIn, openUrl);
    },
    [signIn],
  );

  return { signInWithPassword, signInWithProvider, signOut };
}
