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

import { useAction, useQuery } from "convex/react";
import { useMemo } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { WorkspaceCredSource } from "../Panels";
import { Effect, Layer } from "effect";
import {
  CredentialError,
  CredentialSaver,
  CredentialService,
  CredentialServiceLive,
  runSaveCredential,
  type SaveCredentialInput,
} from "./credentials";
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

  // Reactive metadata listing (no plaintext, no ciphertext). `skip` keeps a
  // local-only / signed-out build from issuing any Convex query.
  const credentials = useQuery(
    api.credentialsData.listCredentials,
    active ? { workspaceId } : "skip",
  ) as readonly CredentialMeta[] | undefined;

  // The Convex encrypted-save action, wrapped as the Effect `CredentialSaver` port.
  const saveAction = useAction(api.credentials.saveCredential);

  // Compose the Live save Layer once from the React-bound action.
  const layer = useMemo<Layer.Layer<CredentialService>>(
    () =>
      CredentialServiceLive.pipe(
        Layer.provide(
          Layer.succeed(CredentialSaver, {
            save: (input: SaveCredentialInput) =>
              Effect.tryPromise({
                try: () =>
                  saveAction({
                    workspaceId: input.workspaceId as Id<"workspaces">,
                    extensionId: input.extensionId,
                    scope: "workspace",
                    name: input.name,
                    secrets: input.secrets,
                  }).then(() => undefined),
                catch: (cause) =>
                  new CredentialError({
                    message:
                      cause instanceof Error
                        ? cause.message
                        : "Could not save the shared key.",
                    cause,
                  }),
              }),
          }),
        ),
      ),
    [saveAction],
  );

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
