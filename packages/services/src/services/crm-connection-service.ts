/**
 * `CrmConnectionService` — owns the workspace's CRM connections (TRI:
 * crm-sync). Tokens live in the existing `credentials` table under
 * `extensionId: "{provider}-crm"`, `scope: "workspace"` as an envelope-
 * encrypted secret map, so storage, rotation, and the member/worker read
 * split all reuse the credential machinery. One slot per provider — a
 * workspace can hold Attio AND HubSpot simultaneously.
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
 * metadata (connectedByUserId/Name, crmWorkspaceId/Name — legacy rows use
 * attioWorkspaceId/Name and are read via fallback) so "connected by Morgan ·
 * Trigify GTM" renders without a second store.
 *
 * REFRESH: sessions minted here renew the access token according to the
 * PROVIDER'S OWN policy (`RefreshPolicy`, carried by its OAuth adapter and
 * interpreted by `oauth/token-service.ts`) rather than one hard-coded rule:
 * Attio and HubSpot are Proactive (refresh ahead of expiry; their refresh
 * tokens are reusable, so a redundant refresh is harmless), while Slack is
 * Rotating (single-use refresh tokens, so the refresh must be serialized per
 * connection). Attio tokens that carry no expiry simply never look stale, which
 * is how its documented ambiguity is honoured without a policy of its own.
 *
 * Unchanged in every case: a refresh REFUSAL fails the mint with
 * {@link CrmAuthRevoked} (the connection is dead), while transient refresh
 * failures fall back to the stored token — the client's 401 backstop covers it.
 */

import { Effect, Option } from "effect";
import type { SecretMap } from "@gtmgrid/cloud";
import { CrmAuthRevoked, CrmConnectionMissing, CrmSyncError, type CrmError } from "../crm/errors.js";
import { CRM_DISPLAY_NAMES, type CrmProvider, type CrmSession, type CrmTokens } from "./crm-client.js";
import { CrmAuthRegistry } from "./crm-auth-registry.js";
import { freshTokens as interpretRefreshPolicy } from "../oauth/token-service.js";
import { CredentialRepo } from "../repositories/credential-repo.js";
import { CredentialService } from "./credential-service.js";
import { CryptoService } from "./crypto-service.js";

/**
 * Credential slot for a provider's OAuth CONNECTION — deliberately distinct
 * from the engine's apiKey slots ("attio", "hubspot"): they share the
 * credentials table, and a shared id let the Tools panel's "Replace key"
 * overwrite OAuth tokens.
 */
export const crmConnectionSlot = (provider: CrmProvider): string => `${provider}-crm`;

/** @deprecated The Attio slot ("attio-crm") — use {@link crmConnectionSlot}. */
export const ATTIO_EXTENSION_ID = crmConnectionSlot("attio");

/** Display metadata alongside the tokens. */
export interface CrmConnectionMeta {
  readonly connectedByUserId: string;
  readonly connectedByName: string;
  /** The connected CRM workspace/portal id + display name. */
  readonly crmWorkspaceId: string;
  readonly crmWorkspaceName: string;
}

const toSecrets = (tokens: CrmTokens, meta: CrmConnectionMeta): SecretMap => ({
  accessToken: tokens.accessToken,
  ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
  ...(tokens.expiresAtMs !== undefined ? { expiresAtMs: String(tokens.expiresAtMs) } : {}),
  connectedByUserId: meta.connectedByUserId,
  connectedByName: meta.connectedByName,
  crmWorkspaceId: meta.crmWorkspaceId,
  crmWorkspaceName: meta.crmWorkspaceName,
});

const parseTokens = (secrets: SecretMap): CrmTokens | null => {
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
  // Legacy Attio rows stored provider-named keys; new writes are neutral.
  crmWorkspaceId: secrets.crmWorkspaceId ?? secrets.attioWorkspaceId ?? "",
  crmWorkspaceName: secrets.crmWorkspaceName ?? secrets.attioWorkspaceName ?? "",
});

export class CrmConnectionService extends Effect.Service<CrmConnectionService>()(
  "CrmConnectionService",
  {
    effect: Effect.gen(function* () {
      const credentials = yield* CredentialService;
      const repo = yield* CredentialRepo;
      const crypto = yield* CryptoService;
      const auth = yield* CrmAuthRegistry;

      /** Encrypt + upsert the full secret map (no membership — see header). */
      const writeSecrets = (provider: CrmProvider, workspaceId: string, secrets: SecretMap) =>
        Effect.gen(function* () {
          const secretsEnc = yield* crypto.encrypt(workspaceId, secrets);
          yield* repo.upsert({
            workspaceId,
            extensionId: crmConnectionSlot(provider),
            scope: "workspace",
            ownerUserId: null,
            name: CRM_DISPLAY_NAMES[provider],
            secretsEnc,
          });
        }).pipe(
          Effect.mapError(
            (e) =>
              new CrmSyncError({
                message: `Could not store the ${CRM_DISPLAY_NAMES[provider]} connection`,
                cause: e,
              }),
          ),
        );

      /** Worker-path read of the raw secret map (no membership). */
      const readSecretsForWorker = (provider: CrmProvider, workspaceId: string) =>
        Effect.gen(function* () {
          const row = yield* repo.findSharedForWorker({
            workspaceId,
            extensionId: crmConnectionSlot(provider),
          });
          if (Option.isNone(row)) {
            return yield* Effect.fail(new CrmConnectionMissing({ provider: CRM_DISPLAY_NAMES[provider] }));
          }
          return yield* crypto.decrypt(workspaceId, row.value.secretsEnc);
        }).pipe(
          Effect.catchTags({
            CredentialRepoError: (e) =>
              Effect.fail(
                new CrmSyncError({ message: `Could not read the ${CRM_DISPLAY_NAMES[provider]} connection`, cause: e }),
              ),
            DecryptError: (e) =>
              Effect.fail(
                new CrmSyncError({ message: `Could not decrypt the ${CRM_DISPLAY_NAMES[provider]} connection`, cause: e }),
              ),
          }),
        );

      /**
       * Refresh-persist for a session: merge new tokens over stored secrets so
       * display metadata survives rotation. Never fails — a persist failure
       * only costs a re-refresh on the next run.
       */
      const persistTokens = (
        provider: CrmProvider,
        workspaceId: string,
        tokens: CrmTokens,
      ): Effect.Effect<void, never> =>
        Effect.gen(function* () {
          const current = yield* readSecretsForWorker(provider, workspaceId);
          yield* writeSecrets(provider, workspaceId, toSecrets(tokens, parseMeta(current)));
        }).pipe(
          Effect.catchAll((e) =>
            Effect.logWarning("crm token persist failed; continuing with in-memory token").pipe(
              Effect.annotateLogs({ provider, workspaceId, error: e._tag }),
            ),
          ),
        );

      /**
       * Refresh tokens the provider's {@link RefreshPolicy} says are stale.
       *
       * The decision itself lives in `oauth/token-service.ts` so that all three
       * providers share one interpretation; this only supplies the I/O. What
       * used to be an inline `expiringSoon` check hard-coded HubSpot's
       * proactive-refresh strategy for EVERY provider — fine while the roster
       * was Attio + HubSpot, but wrong for Slack, whose refresh tokens are
       * single-use and must be serialized.
       */
      const freshTokens = (
        provider: CrmProvider,
        workspaceId: string,
        tokens: CrmTokens,
      ): Effect.Effect<CrmTokens, CrmError> =>
        interpretRefreshPolicy(tokens, {
          policy: auth.policyFor(provider),
          provider: CRM_DISPLAY_NAMES[provider],
          // Namespaced per (workspace, slot) so two providers in one workspace —
          // and two workspaces on one provider — never contend with each other.
          lockKey: `oauth-refresh:${workspaceId}:${crmConnectionSlot(provider)}`,
          reread: readSecretsForWorker(provider, workspaceId).pipe(Effect.map(parseTokens)),
          refresh: (refreshToken) => auth.refresh(provider, refreshToken),
          persist: (t) => persistTokens(provider, workspaceId, t),
          withTryLock: (args) =>
            repo.withTryRefreshLock(args).pipe(
              Effect.catchTag("CredentialRepoError", (e) =>
                // The lock is an OPTIMISATION, not a correctness gate for the
                // caller: if we cannot even reach Postgres to take it, failing
                // the sync outright is worse than serving the stored token,
                // which is still inside its skew window.
                Effect.logWarning("could not take the oauth refresh lock; using stored token").pipe(
                  Effect.annotateLogs({ provider, workspaceId, error: e._tag }),
                  Effect.as(tokens),
                ),
              ),
            ),
        });

      const sessionFrom = (provider: CrmProvider, workspaceId: string, secrets: SecretMap) =>
        Effect.gen(function* () {
          const stored = parseTokens(secrets);
          if (stored === null) {
            return yield* Effect.fail(new CrmConnectionMissing({ provider: CRM_DISPLAY_NAMES[provider] }));
          }
          const tokens = yield* freshTokens(provider, workspaceId, stored);
          const session: CrmSession = {
            workspaceId,
            tokens,
            persist: (t) => persistTokens(provider, workspaceId, t),
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
          readonly provider: CrmProvider;
          readonly tokens: CrmTokens;
          readonly meta: CrmConnectionMeta;
        }) => writeSecrets(args.provider, args.workspaceId, toSecrets(args.tokens, args.meta)),

        /** Member-gated session (tRPC paths). */
        memberSession: (workspaceId: string, provider: CrmProvider = "attio") =>
          Effect.gen(function* () {
            const secrets = yield* credentials.getCredentialForRun({
              workspaceId,
              extensionId: crmConnectionSlot(provider),
              scope: "workspace",
            });
            if (Option.isNone(secrets)) {
              return yield* Effect.fail(new CrmConnectionMissing({ provider: CRM_DISPLAY_NAMES[provider] }));
            }
            return yield* sessionFrom(provider, workspaceId, secrets.value);
          }),

        /** Worker session (Inngest cron; caller's worker secret is the trust boundary). */
        workerSession: (workspaceId: string, provider: CrmProvider = "attio") =>
          Effect.gen(function* () {
            const secrets = yield* readSecretsForWorker(provider, workspaceId);
            return yield* sessionFrom(provider, workspaceId, secrets);
          }),

        /**
         * Delete the stored OAuth connection (explicit disconnect). Caller
         * handles authz + pausing bindings. True when a row existed.
         */
        removeConnection: (workspaceId: string, provider: CrmProvider = "attio") =>
          repo
            .remove({
              workspaceId,
              extensionId: crmConnectionSlot(provider),
              scope: "workspace",
              ownerUserId: null,
            })
            .pipe(
              Effect.mapError(
                (e) =>
                  new CrmSyncError({
                    message: `Could not remove the ${CRM_DISPLAY_NAMES[provider]} connection`,
                    cause: e,
                  }),
              ),
            ),

        /** Member-gated connection metadata for the UI, or `None` when not connected. */
        connectionMeta: (workspaceId: string, provider: CrmProvider = "attio") =>
          Effect.gen(function* () {
            const secrets = yield* credentials.getCredentialForRun({
              workspaceId,
              extensionId: crmConnectionSlot(provider),
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
