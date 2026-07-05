/**
 * `CrmConnectionService` — owns the workspace's Attio connection (TRI:
 * crm-sync). Tokens live in the existing `credentials` table under
 * `extensionId: "attio-crm"`, `scope: "workspace"` as an envelope-encrypted secret
 * map, so storage, rotation, and the member/worker read split all reuse the
 * credential machinery:
 *
 * - MEMBER path (tRPC): {@link CredentialService.getCredentialForRun} — the
 *   caller's membership is the trust boundary.
 * - WORKER path (Inngest cron): {@link CredentialRepo.findSharedForWorker} +
 *   {@link CryptoService.decrypt} — the worker secret is the trust boundary.
 * - WRITE path (OAuth callback / refresh): encrypt + upsert directly; the
 *   callback's verified signed state (or an in-flight sync) is the trust
 *   boundary, mirroring how the worker path skips membership.
 *
 * Secret map keys: accessToken, refreshToken?, expiresAtMs?, plus display
 * metadata (connectedByUserId/Name, attioWorkspaceId/Name) so "connected by
 * Morgan · Trigify GTM" renders without a second store.
 */

import { Effect, Option } from "effect";
import type { SecretMap } from "@gtmgrid/cloud";
import { CrmConnectionMissing, CrmSyncError } from "../crm/errors.js";
import type { AttioSession } from "./attio-client.js";
import type { AttioTokens } from "./attio-auth.js";
import { CredentialRepo } from "../repositories/credential-repo.js";
import { CredentialService } from "./credential-service.js";
import { CryptoService } from "./crypto-service.js";

/**
 * Credential slot for the OAuth CONNECTION — deliberately distinct from the
 * engine's apiKey slot ("attio"): they share the credentials table, and a
 * shared id let the Tools panel's "Replace key" overwrite OAuth tokens.
 */
export const ATTIO_EXTENSION_ID = "attio-crm";

/** Display metadata alongside the tokens. */
export interface CrmConnectionMeta {
  readonly connectedByUserId: string;
  readonly connectedByName: string;
  readonly attioWorkspaceId: string;
  readonly attioWorkspaceName: string;
}

const toSecrets = (tokens: AttioTokens, meta: CrmConnectionMeta): SecretMap => ({
  accessToken: tokens.accessToken,
  ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
  ...(tokens.expiresAtMs !== undefined ? { expiresAtMs: String(tokens.expiresAtMs) } : {}),
  connectedByUserId: meta.connectedByUserId,
  connectedByName: meta.connectedByName,
  attioWorkspaceId: meta.attioWorkspaceId,
  attioWorkspaceName: meta.attioWorkspaceName,
});

const parseTokens = (secrets: SecretMap): AttioTokens | null => {
  const accessToken = secrets.accessToken ?? "";
  if (!accessToken) return null;
  const expires = Number(secrets.expiresAtMs);
  return {
    accessToken,
    ...(secrets.refreshToken ? { refreshToken: secrets.refreshToken } : {}),
    ...(Number.isFinite(expires) && expires > 0 ? { expiresAtMs: expires } : {}),
  };
};

const parseMeta = (secrets: SecretMap): CrmConnectionMeta => ({
  connectedByUserId: secrets.connectedByUserId ?? "",
  connectedByName: secrets.connectedByName ?? "",
  attioWorkspaceId: secrets.attioWorkspaceId ?? "",
  attioWorkspaceName: secrets.attioWorkspaceName ?? "",
});

export class CrmConnectionService extends Effect.Service<CrmConnectionService>()(
  "CrmConnectionService",
  {
    effect: Effect.gen(function* () {
      const credentials = yield* CredentialService;
      const repo = yield* CredentialRepo;
      const crypto = yield* CryptoService;

      /** Encrypt + upsert the full secret map (no membership — see header). */
      const writeSecrets = (workspaceId: string, secrets: SecretMap) =>
        Effect.gen(function* () {
          const secretsEnc = yield* crypto.encrypt(workspaceId, secrets);
          yield* repo.upsert({
            workspaceId,
            extensionId: ATTIO_EXTENSION_ID,
            scope: "workspace",
            ownerUserId: null,
            name: "Attio",
            secretsEnc,
          });
        }).pipe(
          Effect.mapError(
            (e) => new CrmSyncError({ message: "Could not store the Attio connection", cause: e }),
          ),
        );

      /** Worker-path read of the raw secret map (no membership). */
      const readSecretsForWorker = (workspaceId: string) =>
        Effect.gen(function* () {
          const row = yield* repo.findSharedForWorker({
            workspaceId,
            extensionId: ATTIO_EXTENSION_ID,
          });
          if (Option.isNone(row)) return yield* Effect.fail(new CrmConnectionMissing());
          return yield* crypto.decrypt(workspaceId, row.value.secretsEnc);
        }).pipe(
          Effect.catchTags({
            CredentialRepoError: (e) =>
              Effect.fail(new CrmSyncError({ message: "Could not read the Attio connection", cause: e })),
            DecryptError: (e) =>
              Effect.fail(new CrmSyncError({ message: "Could not decrypt the Attio connection", cause: e })),
          }),
        );

      /**
       * Refresh-persist for a session: merge new tokens over stored secrets so
       * display metadata survives rotation. Never fails — a persist failure
       * only costs a re-refresh on the next run.
       */
      const persistTokens = (workspaceId: string, tokens: AttioTokens): Effect.Effect<void, never> =>
        Effect.gen(function* () {
          const current = yield* readSecretsForWorker(workspaceId);
          yield* writeSecrets(workspaceId, toSecrets(tokens, parseMeta(current)));
        }).pipe(
          Effect.catchAll((e) =>
            Effect.logWarning("attio token persist failed; continuing with in-memory token").pipe(
              Effect.annotateLogs({ workspaceId, error: e._tag }),
            ),
          ),
        );

      const sessionFrom = (workspaceId: string, secrets: SecretMap) =>
        Effect.gen(function* () {
          const tokens = parseTokens(secrets);
          if (tokens === null) return yield* Effect.fail(new CrmConnectionMissing());
          const session: AttioSession = {
            workspaceId,
            tokens,
            persist: (t) => persistTokens(workspaceId, t),
          };
          return session;
        });

      return {
        /**
         * Store a fresh connection from the OAuth callback (verified signed
         * state is the caller's trust boundary).
         */
        saveConnection: (args: {
          readonly workspaceId: string;
          readonly tokens: AttioTokens;
          readonly meta: CrmConnectionMeta;
        }) => writeSecrets(args.workspaceId, toSecrets(args.tokens, args.meta)),

        /** Member-gated session (tRPC paths). */
        memberSession: (workspaceId: string) =>
          Effect.gen(function* () {
            const secrets = yield* credentials.getCredentialForRun({
              workspaceId,
              extensionId: ATTIO_EXTENSION_ID,
              scope: "workspace",
            });
            if (Option.isNone(secrets)) return yield* Effect.fail(new CrmConnectionMissing());
            return yield* sessionFrom(workspaceId, secrets.value);
          }),

        /** Worker session (Inngest cron; caller's worker secret is the trust boundary). */
        workerSession: (workspaceId: string) =>
          Effect.gen(function* () {
            const secrets = yield* readSecretsForWorker(workspaceId);
            return yield* sessionFrom(workspaceId, secrets);
          }),

        /**
         * Delete the stored OAuth connection (explicit disconnect). Caller
         * handles authz + pausing bindings. True when a row existed.
         */
        removeConnection: (workspaceId: string) =>
          repo
            .remove({ workspaceId, extensionId: ATTIO_EXTENSION_ID, scope: "workspace", ownerUserId: null })
            .pipe(
              Effect.mapError(
                (e) => new CrmSyncError({ message: "Could not remove the Attio connection", cause: e }),
              ),
            ),

        /** Member-gated connection metadata for the UI, or `None` when not connected. */
        connectionMeta: (workspaceId: string) =>
          Effect.gen(function* () {
            const secrets = yield* credentials.getCredentialForRun({
              workspaceId,
              extensionId: ATTIO_EXTENSION_ID,
              scope: "workspace",
            });
            if (Option.isNone(secrets) || parseTokens(secrets.value) === null) {
              return Option.none<CrmConnectionMeta>();
            }
            return Option.some(parseMeta(secrets.value));
          }),
      } as const;
    }),
    dependencies: [],
  },
) {}
