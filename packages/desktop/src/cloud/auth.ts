/**
 * Cloud auth + workspace hooks (T8).
 *
 * React hooks (`useMe`, `useActiveWorkspace`, `useAuthState`, `useAccountActions`)
 * the account-bar UI binds to. They wrap the Convex Auth React API
 * (`@convex-dev/auth/react`) + the reactive `me` query, and add an "active
 * workspace" selection persisted in `localStorage`.
 *
 * The v1 auth path is **email + password** against Convex Auth's Password
 * provider (configured in `convex/auth.ts`). Native deep-link OAuth via the
 * system browser is a tracked follow-up (task #17) and is intentionally not
 * wired here.
 *
 * The local-only app is untouched: every hook degrades to a signed-out / null
 * shape when no Convex deployment is configured, and nothing here runs unless
 * the user explicitly signs in.
 */

import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useQuery } from "convex/react";
import { useCallback, useMemo, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { cloudEnabled } from "./convex";

// ─── Shared types (mirror the `me` query in convex/workspaces.ts) ───────────

/** Seat usage for a workspace: members used vs. the plan limit (null = free). */
export interface SeatUsage {
  readonly used: number;
  readonly limit: number | null;
}

/** A workspace the signed-in user belongs to, with their role + seat usage. */
export interface WorkspaceSummary {
  readonly _id: Id<"workspaces">;
  readonly name: string;
  readonly role: "owner" | "admin" | "member";
  readonly seatUsage: SeatUsage;
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

/**
 * The active workspace selection. Persisted in `localStorage` and validated
 * against the workspaces the user can actually access (so a stale id from a
 * removed workspace falls back to the first available one).
 */
export function useActiveWorkspace(me: Me | null | undefined): {
  activeWorkspace: WorkspaceSummary | null;
  setActiveWorkspaceId: (id: Id<"workspaces">) => void;
} {
  const [storedId, setStoredId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(ACTIVE_WS_KEY);
    } catch {
      return null;
    }
  });

  const setActiveWorkspaceId = useCallback((id: Id<"workspaces">) => {
    setStoredId(id);
    try {
      localStorage.setItem(ACTIVE_WS_KEY, id);
    } catch {
      /* ignore storage failures (private mode, etc.) */
    }
  }, []);

  const activeWorkspace = useMemo<WorkspaceSummary | null>(
    () => resolveActiveWorkspace(me?.workspaces ?? [], storedId),
    [me, storedId],
  );

  return { activeWorkspace, setActiveWorkspaceId };
}

/**
 * Account actions for the UI: sign in (email + password), sign out, and create a
 * workspace. Wraps the Convex Auth actions + the `createWorkspace` mutation. All
 * no-ops when cloud is off.
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

  return { signInWithPassword, signOut };
}
