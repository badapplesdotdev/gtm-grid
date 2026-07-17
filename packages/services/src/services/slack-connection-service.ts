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

import type { SecretMap } from "@gtmgrid/cloud";
import { Effect, Option } from "effect";
import { CredentialRepo } from "../repositories/credential-repo.js";
import { CredentialService, type GetForRunError, type SaveCredentialError } from "./credential-service.js";
import { CryptoService } from "./crypto-service.js";
import type { OAuthTokens } from "../oauth/types.js";

/**
 * The credential slot for a workspace's Slack connection. MUST match the
 * connector id in `extensions/slack.json` — see the header.
 */
export const SLACK_CONNECTION_SLOT = "slack";

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

      return {
        /**
         * Store a connection from the OAuth callback.
         *
         * No membership check here, mirroring the CRM write path: the callback's
         * VERIFIED SIGNED STATE is the trust boundary, and the browser
         * completing the handshake carries no session cookie (the desktop opens
         * it externally), so there is no member to check against.
         */
        saveConnection: (args: {
          readonly workspaceId: string;
          readonly tokens: OAuthTokens;
          readonly meta: SlackConnectionMeta;
        }): Effect.Effect<void, SaveCredentialError> =>
          credentials
            .saveCredential({
              workspaceId: args.workspaceId,
              extensionId: SLACK_CONNECTION_SLOT,
              scope: "workspace",
              name: "Slack",
              secrets: toSecrets(args.tokens, args.meta),
            })
            .pipe(Effect.asVoid),

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
        connectedTeamIdForWorker: (workspaceId: string) =>
          Effect.gen(function* () {
            const row = yield* repo.findSharedForWorker({
              workspaceId,
              extensionId: SLACK_CONNECTION_SLOT,
            });
            if (Option.isNone(row)) return null;
            const secrets = yield* crypto.decrypt(workspaceId, row.value.secretsEnc);
            const teamId = secrets.teamId ?? "";
            return teamId === "" ? null : teamId;
          }).pipe(
            // A read failure must FAIL CLOSED at the caller: it returns null, and
            // the receiver drops the event rather than accepting an unverified one.
            Effect.catchAll(() => Effect.succeed(null)),
          ),

        /** The connection for a MEMBER (membership is the trust boundary), or None. */
        memberConnection: (
          workspaceId: string,
        ): Effect.Effect<Option.Option<SlackConnection>, GetForRunError> =>
          credentials
            .getCredentialForRun({
              workspaceId,
              extensionId: SLACK_CONNECTION_SLOT,
              scope: "workspace",
            })
            .pipe(
              Effect.map((secrets) =>
                Option.isNone(secrets)
                  ? Option.none<SlackConnection>()
                  : Option.fromNullable(parseConnection(secrets.value)),
              ),
            ),

        /**
         * Remove the connection. Returns true when a row was deleted.
         *
         * No Slack-side `auth.revoke` call, matching the CRM disconnect: tokens
         * are only deleted locally. Revoking would also kill any OTHER
         * installation sharing the grant, and a user who wants that can uninstall
         * the app from Slack directly.
         */
        disconnect: (workspaceId: string) =>
          repo.remove({
            workspaceId,
            extensionId: SLACK_CONNECTION_SLOT,
            scope: "workspace",
            ownerUserId: null,
          }),
      } as const;
    }),
    dependencies: [],
  },
) {}
