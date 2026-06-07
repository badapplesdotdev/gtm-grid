/**
 * React glue for the shared (workspace-scoped) credential panels (T11).
 *
 * Binds the {@link CredentialService} Effect orchestration (./credentials.ts) to
 * Convex: the reactive `listCredentials` query (for the connected indicator) and
 * the `saveCredential` action (the encrypted-save port). Returns a
 * {@link WorkspaceCredSource} the panels narrow per connector, or `undefined`
 * when no workspace is active (signed out / local-only) — so a local user's
 * panels render exactly as before with no Convex calls.
 *
 * The component (Panels.tsx) stays plain React; the typed-error guards live in
 * the Effect service (unit-tested with a fake saver Layer). This hook only
 * composes the Live Layer from the React-bound action, mirroring the invite
 * wiring in WorkspaceSettings.tsx.
 */

import { useQuery as useReactQuery } from "@tanstack/react-query";
import { useQuery } from "convex/react";
import { useMemo } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { WorkspaceCredSource } from "../Panels";
import { runSaveCredential, useCredentialLayer } from "./credentials";
import { apiClient, cloudViaApi } from "./client";
import { cloudEnabled } from "./convex";

/** A credential metadata row from `listCredentials` (never includes plaintext). */
interface CredentialMeta {
  readonly extensionId: string;
  readonly scope: "workspace" | "personal";
}

/**
 * Build the {@link WorkspaceCredSource} for the active workspace, or `undefined`
 * when there is no active workspace / cloud is disabled. Shared keys are saved at
 * the `workspace` scope via the Convex encrypted action; the connected set is
 * derived from the reactive listing (workspace-scoped rows only).
 */
export function useWorkspaceCredentials(
  workspaceId: Id<"workspaces"> | null,
  isAuthenticated: boolean,
): WorkspaceCredSource | undefined {
  const active = cloudEnabled && workspaceId !== null && isAuthenticated;

  // Reactive metadata listing (no plaintext, no ciphertext), STRANGLER-branched
  // (tRPC `credentials.list` on the NEW path, the Convex query on the legacy
  // path). Issues zero calls until a workspace is active.
  const credentials = useCredentialMeta(active ? workspaceId : null);

  // The Live save Layer, STRANGLER-branched (tRPC `credentials.save` on the NEW
  // path, the Convex action on the legacy path). The session/empty-key guards in
  // the Effect orchestration are unchanged across transports.
  const layer = useCredentialLayer();

  return useMemo<WorkspaceCredSource | undefined>(() => {
    if (!active || workspaceId === null) return undefined;
    const connectedExtensionIds = new Set(
      (credentials ?? [])
        .filter((c) => c.scope === "workspace")
        .map((c) => c.extensionId),
    );
    return {
      connectedExtensionIds,
      save: (extensionId, name, apiKey) =>
        runSaveCredential(
          isAuthenticated,
          {
            workspaceId,
            extensionId,
            scope: "workspace",
            name,
            secrets: { apiKey },
          },
          layer,
        ),
    };
  }, [active, workspaceId, credentials, isAuthenticated, layer]);
}

/**
 * The reactive credential-metadata listing for a workspace (which connectors are
 * connected — never plaintext/ciphertext), STRANGLER-branched on the cloud path:
 *   - NEW path  → the tRPC `credentials.list` query via react-query.
 *   - LEGACY path → the reactive Convex `credentialsData.listCredentials` query.
 * `undefined` while loading; issues zero calls when `workspaceId` is `null` (cloud
 * off / signed out / no workspace). `cloudViaApi` is a module constant so the hook
 * order is stable across renders.
 */
function useCredentialMeta(
  workspaceId: Id<"workspaces"> | null,
): readonly CredentialMeta[] | undefined {
  if (cloudViaApi) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- module-constant branch.
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
  // eslint-disable-next-line react-hooks/rules-of-hooks -- module-constant branch.
  return useQuery(
    api.credentialsData.listCredentials,
    workspaceId !== null ? { workspaceId } : "skip",
  ) as readonly CredentialMeta[] | undefined;
}
