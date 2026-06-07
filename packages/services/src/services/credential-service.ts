/**
 * `CredentialService` — the credential domain service: the single port the
 * credentials tRPC router runs for save / get-for-run / list.
 *
 * Collapses the Convex `"use node"` action/mutation split (convex/credentials.ts
 * + convex/credentialsData.ts) into ONE Effect service. It composes four pieces:
 *
 *   - {@link CredentialRepo}            — the Drizzle/in-memory table adapter.
 *   - {@link CryptoService}             — AES-256-GCM envelope encrypt/decrypt.
 *   - `MembershipService` (@gtmgrid/cloud) — workspace membership gate.
 *   - `CredentialOwnershipService` (@gtmgrid/cloud) — personal-scope owner rules.
 *
 * The three operations and their security invariants (the AC):
 *
 *   - {@link CredentialService.saveCredential} (ports `saveCredential` :46 +
 *     `storeCredential` :146): require membership, ENCRYPT the plaintext, then
 *     upsert ONLY the ciphertext on (workspace, extension, scope, owner). A
 *     `personal` row binds to the caller; rotating an existing row re-asserts
 *     ownership. Plaintext never reaches the repo.
 *   - {@link CredentialService.getCredentialForRun} (ports `getCredentialForRun`
 *     :78 + `getCredentialEnc` :205): require membership, fetch the owner-keyed
 *     row, assert ownership, then DECRYPT — the ONLY path that yields plaintext.
 *   - {@link CredentialService.listCredentials} (ports `listCredentials` :110):
 *     require membership, return METADATA ONLY (never `secretsEnc`), filtering
 *     personal rows to the caller so a member never sees another's personal key.
 */

import {
  CredentialOwnershipService,
  type CredentialOwnershipError,
  type CredentialScope,
  type DecryptError,
  type EncryptError,
  type InsufficientRoleError,
  type MemberRepoError,
  MembershipService,
  type NotAMemberError,
  type SecretMap,
  type UnauthenticatedError,
} from "@gtmgrid/cloud";
import { Effect, Option } from "effect";
import {
  type CredentialMetadata,
  CredentialRepo,
  type CredentialRepoError,
} from "../repositories/credential-repo.js";
import { CryptoService } from "./crypto-service.js";

/** Input for {@link CredentialService.saveCredential}. */
export interface SaveCredentialInput {
  readonly workspaceId: string;
  readonly extensionId: string;
  readonly scope: CredentialScope;
  readonly name: string;
  /** PLAINTEXT secret map (e.g. `{ apiKey: "..." }`). Encrypted before storage. */
  readonly secrets: SecretMap;
}

/** Input for {@link CredentialService.getCredentialForRun}. */
export interface GetForRunInput {
  readonly workspaceId: string;
  readonly extensionId: string;
  readonly scope: CredentialScope;
}

/** The authz failures every credential op can raise (membership + ownership). */
type CredentialAuthzError =
  | UnauthenticatedError
  | NotAMemberError
  | InsufficientRoleError
  | MemberRepoError
  | CredentialOwnershipError;

/** Full error channel of {@link CredentialService.saveCredential}. */
export type SaveCredentialError =
  | CredentialAuthzError
  | CredentialRepoError
  | EncryptError;

/** Full error channel of {@link CredentialService.getCredentialForRun}. */
export type GetForRunError =
  | CredentialAuthzError
  | CredentialRepoError
  | DecryptError;

/** Full error channel of {@link CredentialService.listCredentials}. */
export type ListCredentialsError =
  | UnauthenticatedError
  | NotAMemberError
  | InsufficientRoleError
  | MemberRepoError
  | CredentialRepoError;

/**
 * Credential domain service. Membership is asserted FIRST in every method, so a
 * non-member is rejected before any data is touched; ownership rules then bind
 * `personal` rows to their owner.
 */
export class CredentialService extends Effect.Service<CredentialService>()(
  "CredentialService",
  {
    effect: Effect.gen(function* () {
      const repo = yield* CredentialRepo;
      const crypto = yield* CryptoService;
      const membership = yield* MembershipService;
      const ownership = yield* CredentialOwnershipService;

      /** The owner binding a row of `scope` is stored/looked-up under. */
      const ownerFor = (scope: CredentialScope, userId: string): string | null =>
        Option.getOrNull(ownership.ownerFor(scope, userId));

      /**
       * Save (insert or rotate) a credential, encrypting the plaintext first.
       * Requires membership; binds a `personal` row to the caller; persists ONLY
       * the ciphertext. Returns the row id.
       */
      const saveCredential = (
        input: SaveCredentialInput,
      ): Effect.Effect<string, SaveCredentialError> =>
        Effect.gen(function* () {
          const member = yield* membership.requireMember(input.workspaceId);
          const ownerUserId = ownerFor(input.scope, member.userId);

          // Defense in depth: if a row already exists on this owner key, assert
          // the caller may rotate it before re-encrypting (mirrors :179).
          const existing = yield* repo.findForAccess({
            workspaceId: input.workspaceId,
            extensionId: input.extensionId,
            scope: input.scope,
            ownerUserId,
          });
          if (Option.isSome(existing)) {
            yield* ownership.assertCanAccess({
              scope: existing.value.scope,
              extensionId: existing.value.extensionId,
              currentUserId: member.userId,
              storedOwnerUserId: Option.fromNullable(existing.value.ownerUserId),
            });
          }

          const secretsEnc = yield* crypto.encrypt(
            input.workspaceId,
            input.secrets,
          );
          return yield* repo.upsert({
            workspaceId: input.workspaceId,
            extensionId: input.extensionId,
            scope: input.scope,
            ownerUserId,
            name: input.name,
            secretsEnc,
          });
        });

      /**
       * Decrypt-for-run: return the PLAINTEXT secret map for a connector to an
       * authorized member. Requires membership, fetches the owner-keyed row,
       * asserts ownership, then decrypts. Returns `None` when no row exists. The
       * ONLY path that yields plaintext.
       */
      const getCredentialForRun = (
        input: GetForRunInput,
      ): Effect.Effect<Option.Option<SecretMap>, GetForRunError> =>
        Effect.gen(function* () {
          const member = yield* membership.requireMember(input.workspaceId);
          const ownerUserId = ownerFor(input.scope, member.userId);

          const row = yield* repo.findForAccess({
            workspaceId: input.workspaceId,
            extensionId: input.extensionId,
            scope: input.scope,
            ownerUserId,
          });
          if (Option.isNone(row)) return Option.none<SecretMap>();

          // Defense in depth: reject a personal row that isn't the caller's
          // before any ciphertext is decrypted (mirrors :235).
          yield* ownership.assertCanAccess({
            scope: row.value.scope,
            extensionId: row.value.extensionId,
            currentUserId: member.userId,
            storedOwnerUserId: Option.fromNullable(row.value.ownerUserId),
          });

          const secrets = yield* crypto.decrypt(
            input.workspaceId,
            row.value.secretsEnc,
          );
          return Option.some(secrets);
        });

      /**
       * List a workspace's credentials as METADATA ONLY (never `secretsEnc`).
       * Requires membership; a member sees the shared `workspace` rows plus only
       * their OWN `personal` keys, never another member's.
       */
      const listCredentials = (
        workspaceId: string,
      ): Effect.Effect<readonly CredentialMetadata[], ListCredentialsError> =>
        Effect.gen(function* () {
          const member = yield* membership.requireMember(workspaceId);
          const rows = yield* repo.listMetadata(workspaceId);
          return rows.filter(
            (c) =>
              c.scope === "workspace" || c.ownerUserId === member.userId,
          );
        });

      return { saveCredential, getCredentialForRun, listCredentials } as const;
    }),
    dependencies: [],
  },
) {}
