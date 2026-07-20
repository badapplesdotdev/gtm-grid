/**
 * `OAuthCredentialService` — hand the engine a token that is valid NOW.
 *
 * The engine reads connector credentials through `WebhookService.getCredential`
 * (worker/sidecar → `/api/worker/getCredential`). For an apiKey connector the
 * stored secret IS the credential and there is nothing to do. For an OAuth
 * connector the stored access token may be stale, so this refreshes it — server
 * side, before the plaintext ever leaves the box.
 *
 * WHY REFRESH HERE AND NOWHERE ELSE:
 *   - The engine never holds a `client_secret` and never rotates. It asks for a
 *     credential and gets a live one. That keeps the sandbox's blast radius to
 *     one access token.
 *   - Refresh therefore has ONE home, which is what makes the per-connection
 *     lock meaningful. Slack's refresh tokens are single-use with at most two
 *     live at once; a sidecar and the worker both refreshing would revoke each
 *     other's token mid-run.
 *
 * A REGISTRY, not `if (extensionId === "slack")`. The engine resolves a
 * connector's credential by connector id, so the slot IS the provider id — a map
 * keyed on it stays honest as connectors are added, and a miss means "not an
 * OAuth slot, pass the secrets through untouched" rather than a wrong branch.
 */

import type { SecretMap } from "@gtmgrid/cloud";
import { Effect, Option } from "effect";
import { CrmAuthRevoked, type CrmError } from "../crm/errors.js";
import type { OAuthAdapter } from "../oauth/adapter.js";
import { freshTokens } from "../oauth/token-service.js";
import type { OAuthNotConfiguredError, OAuthTokens, RefreshPolicy } from "../oauth/types.js";
import { CredentialRepo } from "../repositories/credential-repo.js";
import { CryptoService } from "./crypto-service.js";
import { SLACK_ADAPTER } from "./slack-auth.js";
import {
  parseConnection as parseSlackConnection,
  SLACK_CONNECTION_SLOT,
  toSecrets as slackToSecrets,
} from "./slack-connection-service.js";

/**
 * How one OAuth connector's secret map maps to tokens and back.
 *
 * `adapter` is widened to `OAuthAdapter<OAuthNotConfiguredError>` — safe, since
 * `E` only appears in the error channel (covariant).
 */
export interface OAuthSlotSpec {
  readonly adapter: OAuthAdapter<OAuthNotConfiguredError>;
  readonly policy: RefreshPolicy;
  /** Read stored secrets into tokens; null when there is no usable token. */
  readonly parse: (secrets: SecretMap) => OAuthTokens | null;
  /** Write refreshed tokens back over the stored secrets, preserving display meta. */
  readonly merge: (secrets: SecretMap, tokens: OAuthTokens) => SecretMap;
}

/** Connector id (== credential slot) → how to refresh it. */
export const OAUTH_SLOTS: Readonly<Record<string, OAuthSlotSpec>> = {
  [SLACK_CONNECTION_SLOT]: {
    adapter: SLACK_ADAPTER,
    policy: SLACK_ADAPTER.refreshPolicy,
    parse: (secrets) => parseSlackConnection(secrets)?.tokens ?? null,
    merge: (secrets, tokens) => {
      const existing = parseSlackConnection(secrets);
      return slackToSecrets(
        tokens,
        existing?.meta ?? {
          connectedByUserId: secrets.connectedByUserId ?? "",
          connectedByName: secrets.connectedByName ?? "",
          teamId: secrets.teamId ?? "",
          teamName: secrets.teamName ?? "",
          botUserId: secrets.botUserId ?? "",
        },
      );
    },
  },
};

export class OAuthCredentialService extends Effect.Service<OAuthCredentialService>()(
  "OAuthCredentialService",
  {
    effect: Effect.gen(function* () {
      const repo = yield* CredentialRepo;
      const crypto = yield* CryptoService;

      /** Read + decrypt the shared row for a slot. Used for the in-lock re-read. */
      const readSecrets = (
        workspaceId: string,
        extensionId: string,
        accountId: string | undefined,
      ) =>
        Effect.gen(function* () {
          const row = yield* repo.findSharedForWorker({
            workspaceId,
            extensionId,
            accountId,
          });
          if (Option.isNone(row)) return null;
          return yield* crypto.decrypt(workspaceId, row.value.secretsEnc);
        });

      /** The row's display name, so a refresh does not rename it. */
      const readName = (
        workspaceId: string,
        extensionId: string,
        accountId: string | undefined,
        fallback: string,
      ) =>
        repo
          .findSharedForWorker({ workspaceId, extensionId, accountId })
          .pipe(
            Effect.map((row) => (Option.isNone(row) ? fallback : row.value.name)),
            Effect.catchAll(() => Effect.succeed(fallback)),
          );

      return {
        /**
         * Return `secrets` with a live access token, refreshing if the slot's
         * {@link RefreshPolicy} says it is stale. A slot that isn't OAuth (every
         * apiKey connector) passes straight through.
         */
        freshSecrets: (
          workspaceId: string,
          extensionId: string,
          secrets: SecretMap,
          /**
           * Which account's row to re-read and write back to. Omitting it means
           * the single-account row (`""`), which is correct for every connector
           * but Slack.
           *
           * THIS IS NOT COSMETIC. Without it a Slack refresh re-read and
           * persisted the `""` row while the caller was running team `T_B`: the
           * fresh token would be merged over the wrong secrets and written to
           * the wrong row, so team B would burn its single-use rotating refresh
           * token and then store the result somewhere nothing reads.
           */
          accountId?: string,
        ): Effect.Effect<SecretMap, CrmError> => {
          const slot = OAUTH_SLOTS[extensionId];
          if (slot === undefined) return Effect.succeed(secrets);
          const stored = slot.parse(secrets);
          if (stored === null) return Effect.succeed(secrets);

          return freshTokens(stored, {
            policy: slot.policy,
            provider: slot.adapter.displayName,
            // Namespaced per (workspace, slot) so two workspaces on one provider
            // — and two providers in one workspace — never contend.
            // Namespaced per ACCOUNT as well as per (workspace, slot): Slack's
            // refresh tokens are single-use per install, so team A refreshing
            // must not block — nor be serialized against — team B. Sharing one
            // key across a workspace's teams would be safe but needlessly
            // convoy them behind a network round-trip each.
            lockKey: `oauth-refresh:${workspaceId}:${extensionId}:${accountId ?? ""}`,
            reread: readSecrets(workspaceId, extensionId, accountId).pipe(
              Effect.map((s) => (s === null ? null : slot.parse(s))),
              Effect.catchAll(() => Effect.succeed(null)),
            ),
            refresh: (refreshToken) =>
              slot.adapter.refresh(refreshToken).pipe(
                Effect.mapError((e): CrmError =>
                  "missing" in e
                    ? new CrmAuthRevoked({
                        provider: slot.adapter.displayName,
                        detail: `OAuth not configured: ${e.missing}`,
                      })
                    : e,
                ),
              ),
            persist: (tokens) =>
              Effect.gen(function* () {
                // Merge over the CURRENT stored map, not the one we were handed:
                // display meta may have changed since, and a refresh must never
                // clobber it.
                const current = yield* readSecrets(
                  workspaceId,
                  extensionId,
                  accountId,
                );
                const next = slot.merge(current ?? secrets, tokens);
                const secretsEnc = yield* crypto.encrypt(workspaceId, next);
                // Preserve the stored display name. A rotation is not a
                // reconnect, and writing `displayName` unconditionally would
                // rename "Slack — Acme EU" back to "Slack" every 12 hours.
                const name = yield* readName(
                  workspaceId,
                  extensionId,
                  accountId,
                  slot.adapter.displayName,
                );
                yield* repo.upsert({
                  workspaceId,
                  extensionId,
                  accountId,
                  scope: "workspace",
                  ownerUserId: null,
                  name,
                  secretsEnc,
                });
              }).pipe(
                // A persist failure must never fail the caller: it only costs a
                // re-refresh next read.
                Effect.catchAll((e) =>
                  Effect.logWarning("oauth token persist failed; continuing with in-memory token").pipe(
                    Effect.annotateLogs({ extensionId, workspaceId, error: e._tag }),
                  ),
                ),
              ),
            withTryLock: (args) =>
              repo.withTryRefreshLock(args).pipe(
                Effect.catchTag("CredentialRepoError", (e) =>
                  // The lock is an optimisation, not a correctness gate for the
                  // caller: if Postgres is unreachable, serving the stored token
                  // (still inside its skew window) beats failing the run.
                  Effect.logWarning("could not take the oauth refresh lock; using stored token").pipe(
                    Effect.annotateLogs({ extensionId, workspaceId, error: e._tag }),
                    Effect.as(stored),
                  ),
                ),
              ),
          }).pipe(Effect.map((tokens) => slot.merge(secrets, tokens)));
        },
      } as const;
    }),
    dependencies: [],
  },
) {}
