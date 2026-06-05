/**
 * Workspace credential envelope-encryption domain logic for the cloud tier (T7).
 *
 * Cloud (team) connector credentials are shared across a workspace's members, so
 * unlike LOCAL projects — which keep the machine-local `~/.gtmgrid/key` model in
 * packages/engine/src/crypto.ts (left UNTOUCHED) — the cloud needs a
 * SERVER-HELD secret. We use **envelope encryption**:
 *
 *   1. A fresh random 256-bit **data key (DEK)** encrypts the secret map with
 *      AES-256-GCM (the same cipher the local model uses, but workspace-scoped).
 *   2. That data key is itself wrapped (encrypted, AES-256-GCM) by a per-process
 *      **master key (KEK)** derived from the backend `CREDENTIALS_MASTER_KEY`
 *      env var. Only the wrapped data key + ciphertext are stored in Convex.
 *
 * Binding the wrap to the `workspaceId` (as GCM additional-authenticated-data)
 * means a ciphertext stolen from one workspace's row cannot be decrypted under
 * another workspace's id — the envelope is cryptographically workspace-scoped.
 *
 * This module is DELIBERATELY free of any Convex import and of any ambient env
 * read. The two pieces of environment it needs — "the master key" and "raw
 * crypto primitives" — are abstracted behind Effect services
 * ({@link MasterKey}, {@link CryptoPrimitives}). The Convex layer
 * (convex/model/crypto.ts) provides them backed by `CREDENTIALS_MASTER_KEY` +
 * `node:crypto`; the tests provide deterministic in-memory `Layer`s. That keeps
 * the encryption rules exhaustively unit-testable with zero mocking and no
 * Convex codegen.
 *
 * Follows the canonical Effect pattern (membership.ts / seats.ts): typed
 * `Data.TaggedError`s in the error channel, external dependencies as
 * `Context.Tag` ports, the service as an `Effect.Service` with a `.Default`
 * Layer.
 */

import { Context, Data, Effect } from "effect";

/** AES-256-GCM constants. 12-byte IV + 16-byte auth tag are the GCM standard. */
export const KEY_BYTES = 32 as const;
export const IV_BYTES = 12 as const;
export const TAG_BYTES = 16 as const;

/**
 * The on-the-wire envelope persisted as `credentials.secretsEnc`. A versioned,
 * self-describing JSON blob (base64 fields) so the wrapped data key, its IV/tag,
 * and the secret ciphertext travel together. `v` lets us evolve the format.
 */
export interface CredentialEnvelope {
  /** Envelope format version. */
  readonly v: 1;
  /** base64 IV used to wrap the data key under the master key. */
  readonly dkIv: string;
  /** base64 GCM auth tag from wrapping the data key. */
  readonly dkTag: string;
  /** base64 ciphertext of the data key (wrapped by the master key). */
  readonly dk: string;
  /** base64 IV used to encrypt the secret map under the data key. */
  readonly iv: string;
  /** base64 GCM auth tag from encrypting the secret map. */
  readonly tag: string;
  /** base64 ciphertext of the JSON secret map (under the data key). */
  readonly data: string;
}

/**
 * Raised when encryption of a secret map fails (bad master key length, crypto
 * primitive error). Carries the underlying cause for the Convex layer to log.
 */
export class EncryptError extends Data.TaggedError("EncryptError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Raised when decryption fails — malformed envelope, wrong/rotated master key,
 * a GCM auth-tag mismatch (tampering), or the wrong `workspaceId` (the AAD
 * binding). The single typed failure the decrypt-for-run path surfaces.
 */
export class DecryptError extends Data.TaggedError("DecryptError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Port for the backend master key (KEK). Backed by `CREDENTIALS_MASTER_KEY` in
 * convex/model/crypto.ts; by a fixed in-memory key in tests. Returns the raw
 * 32-byte key so the domain never reads `process.env`.
 */
export class MasterKey extends Context.Tag("CloudMasterKey")<
  MasterKey,
  {
    /** The 32-byte master key. Fails with {@link EncryptError} if misconfigured. */
    readonly bytes: Effect.Effect<Uint8Array, EncryptError>;
  }
>() {}

/**
 * Port for the low-level AES-256-GCM primitives + secure randomness. Backed by
 * `node:crypto` in convex/model/crypto.ts; by a deterministic in-memory fake in
 * tests. Keeping primitives behind a port means the domain logic (envelope
 * assembly, workspace binding, error mapping) is testable without real crypto.
 */
export class CryptoPrimitives extends Context.Tag("CloudCryptoPrimitives")<
  CryptoPrimitives,
  {
    /** `n` cryptographically-random bytes (data keys + IVs). */
    readonly randomBytes: (n: number) => Effect.Effect<Uint8Array>;
    /**
     * AES-256-GCM encrypt `plaintext` under `key` + `iv`, with optional
     * additional-authenticated-data (`aad`). Returns ciphertext + auth tag.
     */
    readonly encrypt: (args: {
      readonly key: Uint8Array;
      readonly iv: Uint8Array;
      readonly plaintext: Uint8Array;
      readonly aad?: Uint8Array;
    }) => Effect.Effect<
      { readonly ciphertext: Uint8Array; readonly tag: Uint8Array },
      EncryptError
    >;
    /**
     * AES-256-GCM decrypt `ciphertext` under `key` + `iv`, verifying `tag` (and
     * `aad` if provided). Fails with {@link DecryptError} on any tag/AAD
     * mismatch — i.e. tampering, wrong key, or wrong workspace binding.
     */
    readonly decrypt: (args: {
      readonly key: Uint8Array;
      readonly iv: Uint8Array;
      readonly ciphertext: Uint8Array;
      readonly tag: Uint8Array;
      readonly aad?: Uint8Array;
    }) => Effect.Effect<Uint8Array, DecryptError>;
  }
>() {}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
const toB64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

/** A secret map (e.g. `{ apiKey: "sk-..." }`). Mirrors the local crypto shape. */
export type SecretMap = Record<string, string>;

/**
 * Workspace credential encryption service. Performs envelope encryption /
 * decryption of connector secret maps, binding each envelope to its workspace.
 *
 * Used by convex/credentials.ts `saveCredential` (encrypt before storing) and
 * the decrypt-for-run path (decrypt only for an authorized member).
 */
export class CredentialCryptoService extends Effect.Service<CredentialCryptoService>()(
  "CredentialCryptoService",
  {
    effect: Effect.gen(function* () {
      const master = yield* MasterKey;
      const prims = yield* CryptoPrimitives;

      /**
       * Envelope-encrypt `secrets` for `workspaceId`. Generates a fresh data
       * key, encrypts the secret map under it, then wraps the data key under the
       * master key — binding the wrap to `workspaceId` so the envelope cannot be
       * decrypted under another workspace. Returns the JSON envelope string
       * stored as `credentials.secretsEnc`.
       */
      const encrypt = (
        workspaceId: string,
        secrets: SecretMap,
      ): Effect.Effect<string, EncryptError> =>
        Effect.gen(function* () {
          const kek = yield* master.bytes;
          const dek = yield* prims.randomBytes(KEY_BYTES);

          // 1. Encrypt the secret map under the fresh data key.
          const iv = yield* prims.randomBytes(IV_BYTES);
          const plaintext = utf8.encode(JSON.stringify(secrets));
          const { ciphertext: data, tag } = yield* prims.encrypt({
            key: dek,
            iv,
            plaintext,
          });

          // 2. Wrap the data key under the master key, bound to the workspace.
          const dkIv = yield* prims.randomBytes(IV_BYTES);
          const { ciphertext: dk, tag: dkTag } = yield* prims.encrypt({
            key: kek,
            iv: dkIv,
            plaintext: dek,
            aad: utf8.encode(workspaceId),
          });

          const envelope: CredentialEnvelope = {
            v: 1,
            dkIv: toB64(dkIv),
            dkTag: toB64(dkTag),
            dk: toB64(dk),
            iv: toB64(iv),
            tag: toB64(tag),
            data: toB64(data),
          };
          return JSON.stringify(envelope);
        });

      /**
       * Decrypt a `secretsEnc` envelope back into the secret map. Unwraps the
       * data key (verifying the `workspaceId` AAD binding) then decrypts the
       * secret map. Fails with {@link DecryptError} on a malformed envelope, a
       * wrong/rotated master key, tampering, or a workspace mismatch.
       *
       * This is the ONLY path that yields plaintext, and only the trusted Convex
       * decrypt-for-run path (an authorized member) ever calls it.
       */
      const decrypt = (
        workspaceId: string,
        secretsEnc: string,
      ): Effect.Effect<SecretMap, DecryptError> =>
        Effect.gen(function* () {
          const kek = yield* master.bytes.pipe(
            Effect.mapError(
              (e) =>
                new DecryptError({ message: e.message, cause: e.cause }),
            ),
          );
          const env = yield* parseEnvelope(secretsEnc);

          // 1. Unwrap the data key, asserting the workspace binding via AAD.
          const dek = yield* prims.decrypt({
            key: kek,
            iv: fromB64(env.dkIv),
            ciphertext: fromB64(env.dk),
            tag: fromB64(env.dkTag),
            aad: utf8.encode(workspaceId),
          });

          // 2. Decrypt the secret map under the recovered data key.
          const plaintext = yield* prims.decrypt({
            key: dek,
            iv: fromB64(env.iv),
            ciphertext: fromB64(env.data),
            tag: fromB64(env.tag),
          });

          return yield* parseSecrets(plaintext);
        });

      return { encrypt, decrypt } as const;
    }),
    dependencies: [],
  },
) {}

/** Parse + shallowly validate a stored envelope, failing typed on garbage. */
const parseEnvelope = (
  secretsEnc: string,
): Effect.Effect<CredentialEnvelope, DecryptError> =>
  Effect.try({
    try: () => {
      const parsed = JSON.parse(secretsEnc) as Partial<CredentialEnvelope>;
      const fields = [
        parsed.dkIv,
        parsed.dkTag,
        parsed.dk,
        parsed.iv,
        parsed.tag,
        parsed.data,
      ];
      if (parsed.v !== 1 || fields.some((f) => typeof f !== "string")) {
        throw new Error("malformed credential envelope");
      }
      return parsed as CredentialEnvelope;
    },
    catch: (cause) =>
      new DecryptError({
        message: "Could not parse the credential envelope.",
        cause,
      }),
  });

/** Parse decrypted bytes back into the `SecretMap`, failing typed on garbage. */
const parseSecrets = (
  plaintext: Uint8Array,
): Effect.Effect<SecretMap, DecryptError> =>
  Effect.try({
    try: () => JSON.parse(fromUtf8.decode(plaintext)) as SecretMap,
    catch: (cause) =>
      new DecryptError({
        message: "Decrypted credential payload was not valid JSON.",
        cause,
      }),
  });
