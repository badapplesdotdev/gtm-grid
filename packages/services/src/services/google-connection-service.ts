/**
 * `GoogleConnectionService` — owns a workspace's Google connection.
 *
 * Mirrors `SlackConnectionService` (see its header for why an OAuth connector
 * does NOT ride `CrmConnectionService`), with two Google-specific additions:
 *
 * 1. **The slot is `"google"`, not `"googlesheets"`.** One grant is meant to
 *    serve every Google connector — Sheets today, Docs/Drive/Gmail later. The
 *    connectors reach it via `auth.credentialSlot` in their manifests, which is
 *    exactly why that field was added to the engine. Any drift between this
 *    constant and the manifests' `credentialSlot` hands the connector an empty
 *    credential with no error until the first 401.
 *
 * 2. **The connection carries PICKED FILES.** Under the `drive.file` scope the
 *    grant conveys no blanket access: each spreadsheet is authorised
 *    individually when the user selects it in the Google Picker. So "which files
 *    may we touch?" is part of the connection's state, not a lookup we can
 *    perform against Drive. It is persisted in the same encrypted envelope as
 *    the tokens (as JSON, since `SecretMap` is `Record<string, string>`), which
 *    keeps it atomic with the grant it belongs to and needs no migration.
 *
 * A refresh must PRESERVE both the display meta and the picked files — see the
 * `merge` in `OAUTH_SLOTS`. Losing the picked-file list would leave a live token
 * that the UI believes can reach nothing.
 */

import type { EncryptError, SecretMap } from "@gtmgrid/cloud";
import { Effect, Option } from "effect";
import { type CredentialRepoError, CredentialRepo } from "../repositories/credential-repo.js";
import { CredentialService, type GetForRunError } from "./credential-service.js";
import { CryptoService } from "./crypto-service.js";
import { GOOGLE_CONNECTION_SLOT } from "./google-auth.js";
import type { OAuthTokens } from "../oauth/types.js";

export { GOOGLE_CONNECTION_SLOT };

/**
 * How many picked files one connection may carry.
 *
 * The list lives inside the encrypted secret blob, which is read and decrypted
 * on every credential fetch for a run — an unbounded list would grow that hot
 * path without limit. 200 is far beyond any realistic number of spreadsheets
 * bound to one workspace, and going over drops the OLDEST rather than rejecting
 * the pick, so the user's most recent action always takes effect.
 */
export const MAX_PICKED_FILES = 200;

/** A spreadsheet the user authorised through the Picker. */
export interface GooglePickedFile {
  readonly id: string;
  readonly name: string;
}

/** Display metadata stored alongside the tokens, so the UI needs no second store. */
export interface GoogleConnectionMeta {
  readonly connectedByUserId: string;
  readonly connectedByName: string;
  /**
   * The Google account that granted access. Load-bearing for the UI, not
   * decoration: users routinely have a personal and a work Google account signed
   * in at once, and "Connected to Google" with no account name gives them no way
   * to tell they authorised the wrong one.
   */
  readonly googleEmail: string;
  /** Spreadsheets authorised via the Picker. Empty is a legitimate state. */
  readonly pickedFiles: readonly GooglePickedFile[];
}

/** The whole connection: what to call Google with, plus what to show the user. */
export interface GoogleConnection {
  readonly tokens: OAuthTokens;
  readonly meta: GoogleConnectionMeta;
}

/**
 * Total parse of the picked-file JSON.
 *
 * Anything malformed degrades to an EMPTY list rather than throwing. A corrupt
 * blob must not make the whole connection unreadable — the tokens beside it are
 * still valid, and an empty list is a state the UI already renders ("no sheets
 * selected yet, pick some"), so the user has a route back. Throwing here would
 * present as "Google is disconnected" and invite them to re-run consent.
 */
const parsePickedFiles = (raw: string | undefined): readonly GooglePickedFile[] => {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (entry === null || typeof entry !== "object") return [];
      const id = Reflect.get(entry, "id");
      const name = Reflect.get(entry, "name");
      if (typeof id !== "string" || id === "") return [];
      return [{ id, name: typeof name === "string" ? name : id }];
    });
  } catch {
    return [];
  }
};

/**
 * Merge newly-picked files into the existing set, newest LAST and deduped by id.
 *
 * Re-picking a file must not duplicate it, and must refresh its name (users
 * rename spreadsheets). Keeping the newest occurrence is what makes a re-pick
 * act as an update rather than a no-op.
 */
export const mergePickedFiles = (
  existing: readonly GooglePickedFile[],
  added: readonly GooglePickedFile[],
): readonly GooglePickedFile[] => {
  const byId = new Map<string, GooglePickedFile>();
  for (const file of [...existing, ...added]) byId.set(file.id, file);
  const merged = [...byId.values()];
  return merged.length > MAX_PICKED_FILES ? merged.slice(merged.length - MAX_PICKED_FILES) : merged;
};

/**
 * Flatten tokens + meta into the encrypted secret map.
 *
 * `expiresAtMs` is stringified because `SecretMap` is `Record<string, string>`.
 * {@link parseConnection} drops it when it isn't a finite number, so a corrupt
 * value degrades to "no known expiry" (never refresh proactively) rather than to
 * `NaN` comparisons that would refresh on every single read.
 */
export const toSecrets = (tokens: OAuthTokens, meta: GoogleConnectionMeta): SecretMap => ({
  accessToken: tokens.accessToken,
  ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
  ...(tokens.expiresAtMs !== undefined ? { expiresAtMs: String(tokens.expiresAtMs) } : {}),
  connectedByUserId: meta.connectedByUserId,
  connectedByName: meta.connectedByName,
  googleEmail: meta.googleEmail,
  pickedFiles: JSON.stringify(meta.pickedFiles),
});

/** Read a stored secret map back into tokens + meta; null when there is no usable token. */
export const parseConnection = (secrets: SecretMap): GoogleConnection | null => {
  const accessToken = secrets.accessToken ?? "";
  if (accessToken === "") return null;
  const expires = Number(secrets.expiresAtMs);
  return {
    tokens: {
      accessToken,
      ...(secrets.refreshToken ? { refreshToken: secrets.refreshToken } : {}),
      ...(Number.isFinite(expires) && expires > 0 ? { expiresAtMs: expires } : {}),
    },
    meta: {
      connectedByUserId: secrets.connectedByUserId ?? "",
      connectedByName: secrets.connectedByName ?? "",
      googleEmail: secrets.googleEmail ?? "",
      pickedFiles: parsePickedFiles(secrets.pickedFiles),
    },
  };
};

export class GoogleConnectionService extends Effect.Service<GoogleConnectionService>()(
  "GoogleConnectionService",
  {
    effect: Effect.gen(function* () {
      const credentials = yield* CredentialService;
      const repo = yield* CredentialRepo;
      const crypto = yield* CryptoService;

      /** Encrypt + upsert the shared workspace row. The one write path. */
      const write = (
        workspaceId: string,
        tokens: OAuthTokens,
        meta: GoogleConnectionMeta,
      ): Effect.Effect<void, EncryptError | CredentialRepoError> =>
        Effect.gen(function* () {
          const secretsEnc = yield* crypto.encrypt(workspaceId, toSecrets(tokens, meta));
          yield* repo.upsert({
            workspaceId,
            extensionId: GOOGLE_CONNECTION_SLOT,
            scope: "workspace",
            // A SHARED workspace row, so it has no owning member — the same shape
            // the Slack and CRM connections write.
            ownerUserId: null,
            name: "Google",
            secretsEnc,
          });
        });

      return {
        /**
         * Store a connection from the OAuth callback.
         *
         * NO MEMBERSHIP CHECK, for the reason spelled out at length in
         * `SlackConnectionService.saveConnection`: the callback's VERIFIED SIGNED
         * STATE is the trust boundary, and there is no member to check against
         * because THE BROWSER HAS NO SESSION — the desktop opens consent with
         * `openExternal`, so the system browser carries no gtmgrid.dev cookie and
         * the callback lands with `sessionUser === null`.
         *
         * That is sound rather than a shortcut: `google.authorizeUrl` mints a
         * state only after `requireMember`, and the callback verifies that state
         * BEFORE calling here, so reaching this line already proves the workspace
         * claim came from a member.
         *
         * Routing this through `CredentialService.saveCredential` (whose first
         * line is `requireMember`) is the specific mistake that once made Slack's
         * primary flow impossible — the user got a 502 AFTER a successful
         * consent, having already burned the single-use code.
         *
         * A fresh consent RESETS the picked files. That is correct under
         * `drive.file`: re-running consent issues a new grant, and file
         * authorisations are not guaranteed to carry across it, so claiming the
         * old list still works would leave the UI advertising files we may no
         * longer be able to open.
         */
        saveConnection: (args: {
          readonly workspaceId: string;
          readonly tokens: OAuthTokens;
          readonly meta: GoogleConnectionMeta;
        }): Effect.Effect<void, EncryptError | CredentialRepoError> =>
          write(args.workspaceId, args.tokens, args.meta),

        /**
         * Record files the user just authorised in the Picker, preserving the
         * tokens and the rest of the meta.
         *
         * Read-modify-write rather than a blind overwrite, because picking is
         * INCREMENTAL: a user opens the Picker again to add a second spreadsheet
         * and must not lose the first. A missing connection is a no-op returning
         * false — the alternative, writing a token-less row, would create a
         * credential the engine treats as "connected" but that carries nothing to
         * authenticate with.
         */
        addPickedFiles: (args: {
          readonly workspaceId: string;
          readonly files: readonly GooglePickedFile[];
        }) =>
          Effect.gen(function* () {
            const row = yield* repo.findSharedForWorker({
              workspaceId: args.workspaceId,
              extensionId: GOOGLE_CONNECTION_SLOT,
            });
            if (Option.isNone(row)) return false;
            const secrets = yield* crypto.decrypt(args.workspaceId, row.value.secretsEnc);
            const connection = parseConnection(secrets);
            if (connection === null) return false;
            yield* write(args.workspaceId, connection.tokens, {
              ...connection.meta,
              pickedFiles: mergePickedFiles(connection.meta.pickedFiles, args.files),
            });
            return true;
          }),

        /** The connection for a MEMBER (membership is the trust boundary), or None. */
        memberConnection: (
          workspaceId: string,
        ): Effect.Effect<Option.Option<GoogleConnection>, GetForRunError> =>
          credentials
            .getCredentialForRun({
              workspaceId,
              extensionId: GOOGLE_CONNECTION_SLOT,
              scope: "workspace",
            })
            .pipe(
              Effect.map((secrets) =>
                Option.isNone(secrets)
                  ? Option.none<GoogleConnection>()
                  : Option.fromNullable(parseConnection(secrets.value)),
              ),
            ),

        /**
         * Remove the connection. Returns true when a row was deleted.
         *
         * No Google-side token revocation, matching the Slack and CRM disconnects:
         * tokens are only deleted locally. Revoking at Google would also invalidate
         * the user's file authorisations, so a user who reconnects would have to
         * re-pick every spreadsheet — a surprising cost for what reads as "unlink
         * this workspace".
         */
        disconnect: (workspaceId: string) =>
          repo.remove({
            workspaceId,
            extensionId: GOOGLE_CONNECTION_SLOT,
            scope: "workspace",
            ownerUserId: null,
          }),
      } as const;
    }),
    dependencies: [],
  },
) {}
