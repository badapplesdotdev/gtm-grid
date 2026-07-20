/**
 * `SlackConnectionService` — owns a workspace's Slack connection (TRI: slack).
 *
 * DELIBERATELY NOT `CrmConnectionService`. That service exists because CRM sync
 * needs sessions, bindings, pause/resume and a per-provider HTTP client; Slack
 * has none of those. It is a connector the ENGINE calls, so all it needs is
 * tokens in the `credentials` table — which `CredentialService` already stores
 * and reads provider-agnostically. Riding the CRM service would have dragged
 * Slack through `CrmProvider`, `CRM_DISPLAY_NAMES` and the sync machinery for no
 * gain, and would have forced a rename of the CRM meta keys (and their legacy
 * `attioWorkspaceId` fallback) purely to accommodate a non-CRM product.
 *
 * THE SLOT IS BARE `"slack"`, not `"slack-crm"`. The CRM slots are suffixed
 * because the engine ALSO has apiKey connectors called "attio"/"hubspot", and a
 * shared id would let the Tools panel's "Replace key" clobber OAuth tokens.
 * Slack has no apiKey connector, and the engine resolves a connector's
 * credential by its connector id — so the slot MUST equal the manifest id
 * (`extensions/slack.json` → `"slack"`) or `sdk.slack.*` finds nothing.
 */

import type { EncryptError, SecretMap } from "@gtmgrid/cloud";
import { Data, Effect, Option } from "effect";
import {
  ACCOUNT_DEFAULT,
  type CredentialRepoError,
  type CredentialRow,
  CredentialRepo,
} from "../repositories/credential-repo.js";
import { CredentialService, type GetForRunError } from "./credential-service.js";
import { CryptoService } from "./crypto-service.js";
import type { OAuthTokens } from "../oauth/types.js";

/**
 * The credential slot for a workspace's Slack connections. MUST match the
 * connector id in `extensions/slack.json` — see the header.
 *
 * STILL A BARE, SINGULAR SLOT even though a workspace may now connect several
 * Slack teams. The teams are discriminated by the `account_id` COLUMN, not by
 * mangling this string into `slack:{teamId}`. Encoding the team in the slot was
 * the obvious first move and it is wrong twice over: it breaks the invariant
 * this file's header rests on (slot == manifest id, or `sdk.slack.*` resolves
 * nothing), and it silently breaks `OAUTH_SLOTS[extensionId]` in
 * `oauth-credential-service.ts`, which is an exact-match registry lookup — a
 * prefixed id would miss it, and a missed lookup means "not an OAuth slot, pass
 * the secrets through untouched", i.e. tokens silently stop refreshing.
 */
export const SLACK_CONNECTION_SLOT = "slack";

/**
 * Raised when a caller did not name a team and the workspace has more than one
 * connected, so there is no non-arbitrary answer.
 *
 * FAILING is the point. The alternative — take the first row — makes a column
 * post into whichever team happens to sort first, changes silently when someone
 * connects another team, and is invisible until a customer's message lands in a
 * stranger's channel.
 */
export class SlackAccountAmbiguous extends Data.TaggedError(
  "SlackAccountAmbiguous",
)<{
  readonly workspaceId: string;
  /** Team ids the workspace has connected, so the UI can offer a choice. */
  readonly teamIds: readonly string[];
}> {}

/** Display metadata stored alongside the tokens, so the UI needs no second store. */
export interface SlackConnectionMeta {
  readonly connectedByUserId: string;
  readonly connectedByName: string;
  /** The connected Slack workspace ("team" in Slack's vocabulary). */
  readonly teamId: string;
  readonly teamName: string;
  /** The bot user the app posts as. */
  readonly botUserId: string;
}

/** The whole connection: what to call Slack with, plus what to show the user. */
export interface SlackConnection {
  readonly tokens: OAuthTokens;
  readonly meta: SlackConnectionMeta;
}

/**
 * Flatten tokens + meta into the encrypted secret map.
 *
 * `expiresAtMs` is stringified because `SecretMap` is `Record<string, string>` —
 * the envelope stores strings only. {@link parseConnection} parses it back and
 * drops it when it isn't a finite number, so a corrupt value degrades to "no
 * known expiry" (never refresh proactively) rather than to `NaN` comparisons
 * that would silently refresh on every single read.
 */
export const toSecrets = (tokens: OAuthTokens, meta: SlackConnectionMeta): SecretMap => ({
  accessToken: tokens.accessToken,
  ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
  ...(tokens.expiresAtMs !== undefined ? { expiresAtMs: String(tokens.expiresAtMs) } : {}),
  connectedByUserId: meta.connectedByUserId,
  connectedByName: meta.connectedByName,
  teamId: meta.teamId,
  teamName: meta.teamName,
  botUserId: meta.botUserId,
});

/** Read a stored secret map back into tokens + meta; null when there is no usable token. */
export const parseConnection = (secrets: SecretMap): SlackConnection | null => {
  const accessToken = secrets.accessToken ?? "";
  if (accessToken === "") return null;
  const expires = Number(secrets.expiresAtMs);
  const extra = {
    teamId: secrets.teamId ?? "",
    teamName: secrets.teamName ?? "",
    botUserId: secrets.botUserId ?? "",
  };
  return {
    tokens: {
      accessToken,
      ...(secrets.refreshToken ? { refreshToken: secrets.refreshToken } : {}),
      ...(Number.isFinite(expires) && expires > 0 ? { expiresAtMs: expires } : {}),
      extra,
    },
    meta: {
      connectedByUserId: secrets.connectedByUserId ?? "",
      connectedByName: secrets.connectedByName ?? "",
      ...extra,
    },
  };
};

export class SlackConnectionService extends Effect.Service<SlackConnectionService>()(
  "SlackConnectionService",
  {
    effect: Effect.gen(function* () {
      const credentials = yield* CredentialService;
      const repo = yield* CredentialRepo;
      const crypto = yield* CryptoService;

      /**
       * Every stored Slack row for a workspace, decrypted, with any LEGACY row
       * healed in passing.
       *
       * A legacy row is one written before `account_id` existed: it sits at
       * `accountId === ""` with the real team id buried in its encrypted blob.
       * Left alone it is indistinguishable from "the sole account" — fine while
       * a workspace has one connection, actively wrong the moment it has two,
       * because a column pinned to `T_LEGACY` would never match the `""` row.
       *
       * Healing happens HERE, on read, rather than in a deploy-time backfill
       * script, because the team id is inside the ciphertext: SQL cannot reach
       * it, so a backfill would need its own decrypt loop, its own runbook, and
       * a window between migrate and backfill in which the two disagree. This
       * path already decrypts every row to build the display meta, so the
       * upgrade is free, idempotent, and cannot be forgotten.
       *
       * A row whose blob carries NO team id is left at `""` — it is unusable
       * for a multi-team choice either way, and rewriting it would only move
       * the problem.
       */
      const loadAccounts = (workspaceId: string) =>
        Effect.gen(function* () {
          const rows = yield* repo.findSharedAccounts({
            workspaceId,
            extensionId: SLACK_CONNECTION_SLOT,
          });
          const loaded: { row: CredentialRow; conn: SlackConnection }[] = [];
          for (const row of rows) {
            const secrets = yield* crypto.decrypt(workspaceId, row.secretsEnc);
            const conn = parseConnection(secrets);
            if (conn === null) continue;
            const teamId = conn.meta.teamId;
            if (row.accountId === ACCOUNT_DEFAULT && teamId !== "") {
              yield* repo.upsert({
                workspaceId,
                extensionId: SLACK_CONNECTION_SLOT,
                accountId: teamId,
                scope: "workspace",
                ownerUserId: null,
                name: row.name,
                secretsEnc: row.secretsEnc,
              });
              yield* repo.remove({
                workspaceId,
                extensionId: SLACK_CONNECTION_SLOT,
                accountId: ACCOUNT_DEFAULT,
                scope: "workspace",
                ownerUserId: null,
              });
              loaded.push({ row: { ...row, accountId: teamId }, conn });
              continue;
            }
            loaded.push({ row, conn });
          }
          return loaded;
        });

      /**
       * One account's connection, through the MEMBERSHIP-gated read path.
       *
       * Deliberately still `CredentialService.getCredentialForRun` and not the
       * repo directly: that is what applies `requireMember` and the ownership
       * assertion before anything is decrypted. Only the OAuth CALLBACK write
       * bypasses membership (no browser session — see `saveConnection`); reads
       * never do.
       */
      const readAccount = (workspaceId: string, accountId: string) =>
        credentials
          .getCredentialForRun({
            workspaceId,
            extensionId: SLACK_CONNECTION_SLOT,
            accountId,
            scope: "workspace",
          })
          .pipe(
            Effect.map((secrets) =>
              Option.isNone(secrets)
                ? Option.none<SlackConnection>()
                : Option.fromNullable(parseConnection(secrets.value)),
            ),
          );

      return {
        /**
         * Store a connection from the OAuth callback.
         *
         * NO MEMBERSHIP CHECK — encrypt + `repo.upsert` directly, exactly as
         * `CrmConnectionService.writeSecrets` does, and for the same reason: the
         * callback's VERIFIED SIGNED STATE is the trust boundary, and there is no
         * member to check against because THE BROWSER HAS NO SESSION. The desktop
         * opens the consent URL with `openExternal`, so the system browser carries
         * no gtmgrid.dev cookie; the callback lands with `sessionUser === null`.
         *
         * That is sound, not a shortcut: `slack.authorizeUrl` mints a state only
         * after `requireMember`, and `crm-callback` verifies the state BEFORE
         * calling here. So reaching this line already proves the workspace claim
         * came from a member.
         *
         * This used to call `CredentialService.saveCredential`, whose first line
         * is `requireMember` — which made the PRIMARY flow impossible. With no
         * session, identity resolved to None, requireMember failed
         * UnauthenticatedError, and the user got the 502 "couldn't finish
         * connecting" page AFTER a successful consent — having burned the
         * single-use code and, under rotation, minted tokens that were then
         * dropped. The doc comment here claimed "no membership check, mirroring
         * the CRM write path" the entire time; only the comment was mirroring it.
         *
         * Every test supplied a session user who was a member, so the one flow the
         * route header calls the trust model ("NO BROWSER SESSION IS REQUIRED")
         * was the only one never exercised. See the `sessionUser: null` case in
         * `app/api/oauth/slack/callback/route.test.ts`.
         */
        saveConnection: (args: {
          readonly workspaceId: string;
          readonly tokens: OAuthTokens;
          readonly meta: SlackConnectionMeta;
        }): Effect.Effect<void, EncryptError | CredentialRepoError> =>
          Effect.gen(function* () {
            const secretsEnc = yield* crypto.encrypt(
              args.workspaceId,
              toSecrets(args.tokens, args.meta),
            );
            yield* repo.upsert({
              workspaceId: args.workspaceId,
              extensionId: SLACK_CONNECTION_SLOT,
              // KEYED ON THE TEAM, which is what makes connecting a second
              // Slack workspace an INSERT rather than an overwrite. Previously
              // every connect landed on the same row: member B connecting
              // "Acme EU" silently replaced member A's "Acme" tokens, every
              // `sdk.slack.*` call across the grid switched team without a
              // word, and every inbound event from "Acme" then failed the
              // team-id gate and was dropped as a mismatch.
              //
              // Falls back to `ACCOUNT_DEFAULT` when Slack sent no team id,
              // which keeps a degraded response storable instead of writing a
              // row under a key nothing can address.
              accountId: args.meta.teamId || ACCOUNT_DEFAULT,
              scope: "workspace",
              // A SHARED workspace row, so it has no owning member — the same
              // shape the CRM connection writes, and what `findSharedForWorker`
              // reads back on the worker path.
              ownerUserId: null,
              name: args.meta.teamName === "" ? "Slack" : `Slack — ${args.meta.teamName}`,
              secretsEnc,
            });
          }),

        /**
         * Every Slack team this workspace has connected, newest last, WITHOUT
         * tokens — display meta only, so the tRPC/UI boundary can never leak an
         * access token into a client bundle.
         */
        listConnections: (workspaceId: string) =>
          loadAccounts(workspaceId).pipe(
            Effect.map((loaded) => loaded.map(({ conn }) => conn.meta)),
          ),

        /**
         * The Slack TEAM this workspace is connected to, for the secret-gated
         * worker path (no membership — the worker secret is the trust boundary).
         * `null` when there is no connection or it carries no team.
         *
         * Returns ONLY the team id, never the secret map: the sole caller is the
         * Events receiver, which needs to answer "is this event from the team
         * this workspace connected?" and has no business holding an access token.
         *
         * This exists because Slack's Events API delivers EVERY installation of
         * an app to ONE app-global Request URL, signed with ONE app-global
         * signing secret. A valid v0 signature therefore proves only "Slack sent
         * this on behalf of this APP" — NOT "this came from the workspace that
         * owns this webhook". Without comparing the team, anyone who installs the
         * app into their own Slack workspace has their messages inserted as rows
         * into whichever tenant's webhook the configured URL names.
         */
        connectedTeamIdsForWorker: (workspaceId: string) =>
          Effect.gen(function* () {
            const loaded = yield* loadAccounts(workspaceId);
            return loaded
              .map(({ conn }) => conn.meta.teamId)
              .filter((id) => id !== "");
          }).pipe(
            // A read failure must FAIL CLOSED at the caller: it returns an EMPTY
            // list, so the receiver matches nothing and drops the event rather
            // than accepting an unverified one. Empty is the safe value here
            // precisely because the caller's test is membership — had this
            // returned "every team" on error it would have been a bypass.
            Effect.catchAll(() => Effect.succeed([] as readonly string[])),
          ),

        /**
         * The connection for a MEMBER (membership is the trust boundary), or None.
         *
         * `teamId` names WHICH connected Slack workspace. Omitting it is only
         * unambiguous when the workspace has exactly one connection — which is
         * every workspace today and stays true for most — so that case resolves
         * silently and every existing caller keeps working untouched. With two
         * or more connected and no team named, this FAILS
         * {@link SlackAccountAmbiguous} rather than picking one.
         */
        memberConnection: (
          workspaceId: string,
          teamId?: string,
        ): Effect.Effect<
          Option.Option<SlackConnection>,
          GetForRunError | SlackAccountAmbiguous
        > =>
          Effect.gen(function* () {
            if (teamId === undefined || teamId === "") {
              const accounts = yield* repo.findSharedAccounts({
                workspaceId,
                extensionId: SLACK_CONNECTION_SLOT,
              });
              if (accounts.length === 0) return Option.none<SlackConnection>();
              if (accounts.length > 1) {
                return yield* Effect.fail(
                  new SlackAccountAmbiguous({
                    workspaceId,
                    teamIds: accounts.map((a) => a.accountId),
                  }),
                );
              }
              // Exactly one — use its key, whatever it is. A not-yet-healed
              // legacy row sits at `""` and resolves here just as it always did.
              return yield* readAccount(workspaceId, accounts[0].accountId);
            }
            return yield* readAccount(workspaceId, teamId);
          }),

        /**
         * Remove the connection. Returns true when a row was deleted.
         *
         * No Slack-side `auth.revoke` call, matching the CRM disconnect: tokens
         * are only deleted locally. Revoking would also kill any OTHER
         * installation sharing the grant, and a user who wants that can uninstall
         * the app from Slack directly.
         */
        disconnect: (workspaceId: string, teamId?: string) =>
          Effect.gen(function* () {
            if (teamId !== undefined && teamId !== "") {
              return yield* repo.remove({
                workspaceId,
                extensionId: SLACK_CONNECTION_SLOT,
                accountId: teamId,
                scope: "workspace",
                ownerUserId: null,
              });
            }
            // No team named: remove every connection. Symmetric with
            // `memberConnection`'s fallback for the one-connection case, and
            // for the multi-connection case "Disconnect Slack" with no further
            // qualification can only honestly mean all of them — silently
            // removing one of several would leave the UI showing a disconnect
            // that half-worked.
            const accounts = yield* repo.findSharedAccounts({
              workspaceId,
              extensionId: SLACK_CONNECTION_SLOT,
            });
            let removed = false;
            for (const account of accounts) {
              const gone = yield* repo.remove({
                workspaceId,
                extensionId: SLACK_CONNECTION_SLOT,
                accountId: account.accountId,
                scope: "workspace",
                ownerUserId: null,
              });
              removed = removed || gone;
            }
            return removed;
          }),
      } as const;
    }),
    dependencies: [],
  },
) {}
