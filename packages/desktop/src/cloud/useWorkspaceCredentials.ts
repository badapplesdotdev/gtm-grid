/**
 * React glue for the shared (workspace-scoped) credential panels (T11).
 *
 * Binds the {@link CredentialService} Effect orchestration (./credentials.ts) to
 * the tRPC API: the `credentials.list` query (for the connected indicator) and
 * the `credentials.save` mutation (the encrypted-save port). Returns a
 * {@link WorkspaceCredSource} the panels narrow per connector, or `undefined`
 * when no workspace is active (signed out / local-only) — so a local user's
 * panels render exactly as before with no cloud calls.
 *
 * The component (Panels.tsx) stays plain React; the typed-error guards live in
 * the Effect service (unit-tested with a fake saver Layer). This hook only
 * composes the Live Layer, mirroring the invite wiring in WorkspaceSettings.tsx.
 */

import { useQuery as useReactQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Id } from "./ids";
import type { WorkspaceCredSource } from "../Panels";
import type { CloudSession } from "./cloud-run";
import { runSaveCredential, useCredentialLayer } from "./credentials";
import { useMe } from "./auth";
import { apiClient, cloudEnabled } from "./client";
import { api } from "../api";

/** A credential metadata row from `listCredentials` (never includes plaintext). */
interface CredentialMeta {
  readonly extensionId: string;
  readonly scope: "workspace" | "personal";
}

/**
 * Build the {@link WorkspaceCredSource} for the active workspace, or `undefined`
 * when there is no active workspace / cloud is disabled. Shared keys are saved at
 * the `workspace` scope via the tRPC encrypted mutation; the connected set is
 * derived from the listing (workspace-scoped rows only).
 */
export function useWorkspaceCredentials(
  workspaceId: Id<"workspaces"> | null,
  isAuthenticated: boolean,
  session: CloudSession | null,
): WorkspaceCredSource | undefined {
  const active = cloudEnabled && workspaceId !== null && isAuthenticated;

  // Metadata listing (no plaintext, no ciphertext) via tRPC `credentials.list`.
  // Issues zero calls until a workspace is active.
  const credentials = useCredentialMeta(active ? workspaceId : null);

  // The Live save Layer (tRPC `credentials.save`). The session/empty-key guards
  // live in the Effect orchestration.
  const layer = useCredentialLayer();
  const queryClient = useQueryClient();

  // A usable cloud session (apps/web URL + bearer) is required for the sidecar to
  // forward the local key to the cloud; gate `copyLocalKey` on it.
  const hasSession = session !== null && session.token.trim() !== "";

  // Deleting a SHARED key is owner/admin only (it stops every other member's
  // columns and cannot be undone without the secret). Read the caller's role in
  // this workspace from `me` so the panel offers the button only to someone the
  // server will accept.
  const me = useMe();
  const canRemove =
    active &&
    (() => {
      const role = me?.workspaces.find((w) => w._id === workspaceId)?.role;
      return role === "owner" || role === "admin";
    })();

  return useMemo<WorkspaceCredSource | undefined>(() => {
    if (!active || workspaceId === null) return undefined;
    const connectedExtensionIds = new Set(
      (credentials ?? [])
        .filter((c) => c.scope === "workspace")
        .map((c) => c.extensionId),
    );
    return {
      connectedExtensionIds,
      save: async (extensionId, name, apiKey) => {
        await runSaveCredential(
          isAuthenticated,
          {
            workspaceId,
            extensionId,
            scope: "workspace",
            name,
            secrets: { apiKey },
          },
          layer,
        );
        // Refresh the connected listing so the panel flips to "connected"
        // immediately — without this the indicator stayed stale until restart.
        await queryClient.invalidateQueries({
          queryKey: ["credentials", "list", workspaceId],
        });
      },
      // Delete the shared key outright. Offered ONLY to an owner/admin — the
      // role `credentials.remove` requires — so the panel never renders a button
      // that would come back 403. The server gates it either way; this only
      // keeps the affordance honest.
      remove: canRemove
        ? async (extensionId) => {
            // No `!` here: `apiClient` is a non-nullable module singleton
            // (client.tsx:172). The `apiClient !== null` guards elsewhere in this
            // file are vestigial from when it could be absent.
            await apiClient.credentials.remove.mutate({
              workspaceId,
              extensionId,
              scope: "workspace",
            });
            await queryClient.invalidateQueries({
              queryKey: ["credentials", "list", workspaceId],
            });
          }
        : undefined,
      copyLocalKey:
        hasSession && session !== null
          ? async (extensionId, name) => {
              await api.copyLocalKeyToCloud({
                credId: extensionId,
                extensionId,
                name,
                apiUrl: session.apiUrl,
                token: session.token,
                workspaceId,
              });
              await queryClient.invalidateQueries({
                queryKey: ["credentials", "list", workspaceId],
              });
            }
          : undefined,
    };
  }, [
    active,
    workspaceId,
    credentials,
    isAuthenticated,
    layer,
    hasSession,
    session,
    queryClient,
    canRemove,
  ]);
}

/**
 * The credential-metadata listing for a workspace (which connectors are
 * connected — never plaintext/ciphertext) via the tRPC `credentials.list` query.
 * `undefined` while loading; issues zero calls when `workspaceId` is `null` (cloud
 * off / signed out / no workspace).
 */
function useCredentialMeta(
  workspaceId: Id<"workspaces"> | null,
): readonly CredentialMeta[] | undefined {
  const q = useReactQuery({
    queryKey: ["credentials", "list", workspaceId],
    enabled: apiClient !== null && workspaceId !== null,
    queryFn: () =>
      apiClient!.credentials.list.query({
        workspaceId: workspaceId as string,
      }),
  });
  return q.data as readonly CredentialMeta[] | undefined;
}
