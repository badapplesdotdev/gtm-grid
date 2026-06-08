/**
 * Invitation reads + the revoke/accept mutations over the apps/web tRPC API. Two
 * surfaces consume these:
 *   - WorkspaceSettings.tsx — the pending list for a workspace (copy link /
 *     revoke), via {@link usePendingInvitations} + {@link useRevokeInvitation}.
 *   - PendingInvites.tsx — the invites waiting for the signed-in user (accept
 *     banner), via {@link useMyPendingInvitations}.
 *
 * Reads go through react-query (`invitations.list` / `myPending`); writes go
 * through the tRPC client and invalidate the relevant cache so the surfaces
 * refresh. Issues zero cloud calls when the cloud layer is off, so the
 * local-first app is unaffected.
 */

import { useQuery as useReactQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { Id } from "./ids";
import type { MemberRole } from "./invite";
import { apiClient } from "./client";

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

/** The result of accepting an invitation (the tRPC `invitations.accept`). */
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
 * The pending-invitation list for a workspace (copy link / revoke). `undefined`
 * while loading / when cloud is off / no workspace is active.
 */
export function usePendingInvitations(
  workspaceId: Id<"workspaces"> | null,
): readonly PendingInvitationRow[] | undefined {
  const q = useReactQuery({
    queryKey: pendingKey(workspaceId ?? ""),
    enabled: apiClient !== null && workspaceId !== null,
    queryFn: () =>
      apiClient!.invitations.list.query({
        workspaceId: workspaceId as string,
      }),
  });
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

/**
 * Revoke a pending invitation by id. Calls the tRPC `invitations.revoke` mutation
 * and invalidates the workspace's pending list so it refetches. The `workspaceId`
 * scopes the cache invalidation.
 */
export function useRevokeInvitation(
  workspaceId: Id<"workspaces"> | null,
): (invitationId: string) => Promise<void> {
  const qc = useQueryClient();
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

/**
 * The invitations waiting for the SIGNED-IN user (the accept banner). `undefined`
 * while loading; `[]` when there is nothing to accept. Issues zero cloud calls
 * when cloud is off (the local-first app is unaffected).
 */
export function useMyPendingInvitations():
  | readonly MyPendingInvitationRow[]
  | undefined {
  const q = useReactQuery({
    queryKey: myPendingKey,
    enabled: apiClient !== null,
    queryFn: () => apiClient!.invitations.myPending.query(),
  });
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

/**
 * Accept a pending invitation by token, returning the typed result the banner
 * branches on (`accepted` / `wrong_account` / `invalid` / `seat_limit`). Calls
 * the tRPC `invitations.accept` mutation and invalidates the caller's
 * waiting-invites cache on a successful accept (so the banner clears).
 */
export function useAcceptInvitation(): (
  token: string,
) => Promise<AcceptInviteResult> {
  const qc = useQueryClient();
  return useCallback(
    async (token: string) => {
      const res = (await apiClient!.invitations.accept.mutate({
        token,
      })) as AcceptInviteResult;
      if (res.status === "accepted") {
        // Clear the waiting-invites banner AND refetch `me` so the just-joined
        // workspace appears immediately (the badge, switcher, and the new-signup
        // auto-enrol path all read `me.workspaces`).
        await qc.invalidateQueries({ queryKey: myPendingKey });
        await qc.invalidateQueries({ queryKey: ["workspaces", "me"] });
      }
      return res;
    },
    [qc],
  );
}
