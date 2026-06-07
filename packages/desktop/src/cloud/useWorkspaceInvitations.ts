/**
 * Reactive invitation reads + the revoke mutation, STRANGLER-branched on the
 * cloud path (TRI-3255). Two surfaces consume these:
 *   - WorkspaceSettings.tsx — the pending list for a workspace (copy link /
 *     revoke), via {@link usePendingInvitations} + {@link useRevokeInvitation}.
 *   - PendingInvites.tsx — the invites waiting for the signed-in user (accept
 *     banner), via {@link useMyPendingInvitations}.
 *
 * The NEW path reads the apps/web tRPC API (`invitations.list` / `myPending`)
 * through react-query and writes via the vanilla client, invalidating the cache
 * after a revoke; the LEGACY path keeps the reactive Convex queries/mutations.
 * Each hook normalizes the two backends' field naming (tRPC `id` vs Convex `_id`)
 * to ONE UI shape, so the components never branch on the cloud path themselves.
 * `cloudViaApi` is a module constant, so hook order is stable across renders.
 */

import { useQuery as useReactQuery, useQueryClient } from "@tanstack/react-query";
import { useAction, useMutation, useQuery } from "convex/react";
import { useCallback, useMemo } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { MemberRole } from "./invite";
import { apiClient, cloudViaApi } from "./client";
import { cloudEnabled } from "./convex";

/** A pending invitation row for a workspace (the settings list). */
export interface PendingInvitationRow {
  readonly id: string;
  readonly email: string;
  readonly role: MemberRole;
  readonly token: string;
  readonly acceptUrl: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/**
 * The result of accepting an invitation, shared across both backends (the tRPC
 * `invitations.accept` and the Convex `acceptInvitation` action return this).
 */
export type AcceptInviteResult =
  | { readonly status: "accepted"; readonly workspaceId: string }
  | { readonly status: "wrong_account"; readonly invitedEmail: string }
  | { readonly status: "invalid" }
  | { readonly status: "seat_limit"; readonly checkoutUrl: string };

/** An invitation waiting for the signed-in user (the accept banner). */
export interface MyPendingInvitationRow {
  readonly id: string;
  readonly token: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly role: MemberRole;
  readonly invitedByName: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** react-query cache key for the pending list of a given workspace. */
function pendingKey(workspaceId: string): readonly unknown[] {
  return ["invitations", "list", workspaceId];
}

/** react-query cache key for the signed-in user's waiting invites. */
const myPendingKey: readonly unknown[] = ["invitations", "myPending"];

/**
 * The reactive pending-invitation list for a workspace (copy link / revoke).
 * `undefined` while loading / when cloud is off / no workspace is active.
 */
export function usePendingInvitations(
  workspaceId: Id<"workspaces"> | null,
): readonly PendingInvitationRow[] | undefined {
  if (cloudViaApi) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- module-constant branch.
    const q = useReactQuery({
      queryKey: pendingKey(workspaceId ?? ""),
      enabled: apiClient !== null && workspaceId !== null,
      queryFn: () =>
        apiClient!.invitations.list.query({
          workspaceId: workspaceId as string,
        }),
    });
    // eslint-disable-next-line react-hooks/rules-of-hooks -- module-constant branch.
    return useMemo<readonly PendingInvitationRow[] | undefined>(
      () =>
        q.data?.map((r) => ({
          id: r.id,
          email: r.email,
          role: r.role,
          token: r.token,
          acceptUrl: r.acceptUrl,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
        })),
      [q.data],
    );
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks -- module-constant branch.
  const rows = useQuery(
    api.invitations.listInvitations,
    cloudEnabled && workspaceId !== null ? { workspaceId } : "skip",
  ) as
    | readonly {
        _id: Id<"invitations">;
        email: string;
        role: MemberRole;
        token: string;
        acceptUrl: string;
        createdAt: number;
        expiresAt: number;
      }[]
    | undefined;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- module-constant branch.
  return useMemo<readonly PendingInvitationRow[] | undefined>(
    () =>
      rows?.map((r) => ({
        id: r._id,
        email: r.email,
        role: r.role,
        token: r.token,
        acceptUrl: r.acceptUrl,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
      })),
    [rows],
  );
}

/**
 * Revoke a pending invitation by id. On the NEW path this calls the tRPC
 * `invitations.revoke` mutation and invalidates the workspace's pending list (so
 * it refetches like the Convex reactive query did); on the legacy path it is the
 * Convex `revokeInvitation` mutation. The `workspaceId` scopes the cache
 * invalidation on the NEW path; it is ignored on the legacy path.
 */
export function useRevokeInvitation(
  workspaceId: Id<"workspaces"> | null,
): (invitationId: string) => Promise<void> {
  if (cloudViaApi) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- module-constant branch.
    const qc = useQueryClient();
    // eslint-disable-next-line react-hooks/rules-of-hooks -- module-constant branch.
    return useCallback(
      async (invitationId: string) => {
        await apiClient!.invitations.revoke.mutate({ invitationId });
        await qc.invalidateQueries({
          queryKey: pendingKey(workspaceId ?? ""),
        });
      },
      [qc, workspaceId],
    );
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks -- module-constant branch.
  const revoke = useMutation(api.invitations.revokeInvitation);
  // eslint-disable-next-line react-hooks/rules-of-hooks -- module-constant branch.
  return useCallback(
    (invitationId: string) =>
      revoke({ invitationId: invitationId as Id<"invitations"> }).then(
        () => undefined,
      ),
    [revoke],
  );
}

/**
 * The invitations waiting for the SIGNED-IN user (the accept banner). `undefined`
 * while loading; `[]` when there is nothing to accept. Issues zero cloud calls
 * when cloud is off (the local-first app is unaffected).
 */
export function useMyPendingInvitations():
  | readonly MyPendingInvitationRow[]
  | undefined {
  if (cloudViaApi) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- module-constant branch.
    const q = useReactQuery({
      queryKey: myPendingKey,
      enabled: apiClient !== null,
      queryFn: () => apiClient!.invitations.myPending.query(),
    });
    // eslint-disable-next-line react-hooks/rules-of-hooks -- module-constant branch.
    return useMemo<readonly MyPendingInvitationRow[] | undefined>(
      () =>
        q.data?.map((r) => ({
          id: r.id,
          token: r.token,
          workspaceId: r.workspaceId,
          workspaceName: r.workspaceName,
          role: r.role,
          invitedByName: r.invitedByName,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
        })),
      [q.data],
    );
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks -- module-constant branch.
  const rows = useQuery(
    api.invitations.myPendingInvitations,
    cloudEnabled ? {} : "skip",
  ) as
    | readonly {
        _id: Id<"invitations">;
        token: string;
        workspaceId: Id<"workspaces">;
        workspaceName: string;
        role: MemberRole;
        invitedByName: string | null;
        createdAt: number;
        expiresAt: number;
      }[]
    | undefined;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- module-constant branch.
  return useMemo<readonly MyPendingInvitationRow[] | undefined>(
    () =>
      rows?.map((r) => ({
        id: r._id,
        token: r.token,
        workspaceId: r.workspaceId,
        workspaceName: r.workspaceName,
        role: r.role,
        invitedByName: r.invitedByName,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
      })),
    [rows],
  );
}

/**
 * Accept a pending invitation by token, returning the typed result the banner
 * branches on (`accepted` / `wrong_account` / `invalid` / `seat_limit`). On the
 * NEW path this calls the tRPC `invitations.accept` mutation and invalidates the
 * caller's waiting-invites cache on a successful accept (so the banner clears like
 * the Convex reactive query did); on the legacy path it is the Convex
 * `acceptInvitation` action.
 */
export function useAcceptInvitation(): (
  token: string,
) => Promise<AcceptInviteResult> {
  if (cloudViaApi) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- module-constant branch.
    const qc = useQueryClient();
    // eslint-disable-next-line react-hooks/rules-of-hooks -- module-constant branch.
    return useCallback(
      async (token: string) => {
        const res = (await apiClient!.invitations.accept.mutate({
          token,
        })) as AcceptInviteResult;
        if (res.status === "accepted") {
          await qc.invalidateQueries({ queryKey: myPendingKey });
        }
        return res;
      },
      [qc],
    );
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks -- module-constant branch.
  const acceptAction = useAction(api.invitations.acceptInvitation);
  // eslint-disable-next-line react-hooks/rules-of-hooks -- module-constant branch.
  return useCallback(
    (token: string) =>
      acceptAction({ token }) as Promise<AcceptInviteResult>,
    [acceptAction],
  );
}
