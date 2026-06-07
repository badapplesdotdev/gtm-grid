/**
 * `CryptoService` — the injectable envelope-encryption service the credentials
 * router runs to encrypt secrets before storage and decrypt them for a run.
 *
 * This is the Postgres-tier port of convex/model/crypto.ts (`encryptSecrets`
 * :158, `decryptSecretsForRun` :176). The PURE envelope-encryption rules already
 * live in `@gtmgrid/cloud` as {@link CredentialCryptoService} (AES-256-GCM,
 * per-credential data key wrapped by a workspace-bound master key); this module
 * wraps that pure core behind a single injectable `Context.Tag` so the credential
 * domain service and the tRPC procedures depend on ONE crypto seam:
 *
 *   - {@link CryptoServiceLive} — wires the pure crypto core to its two
 *     environment ports backed by REAL `node:crypto` AES-256-GCM and the
 *     `CREDENTIALS_MASTER_KEY` env var. Used in production. Importing this module
 *     never reads the env or opens anything; the env is read lazily when the
 *     master key is first needed.
 *   - {@link cryptoServiceLayer} — a test factory wiring the SAME pure core to
 *     deterministic in-memory ports (a fixed master key + real AES-256-GCM), so
 *     encrypt/decrypt round-trips are exercised with genuine cryptography and NO
 *     live database / no env. This is the injectability the AC requires.
 *
 * Why a thin wrapper instead of exposing `CredentialCryptoService` directly: the
 * pure core needs its two ports ({@link MasterKey}, {@link CryptoPrimitives})
 * provided, which is environment-specific wiring. Collapsing that wiring behind
 * one `CryptoService` tag means `appLayer`/`TestLayer` provide a single
 * dependency and the credential service never touches `node:crypto` or env.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  CredentialCryptoService,
  CryptoPrimitives,
  type DecryptError,
  DecryptError as DecryptErrorClass,
  decodeMasterKeyBytes,
  type EncryptError,
  EncryptError as EncryptErrorClass,
  IV_BYTES,
  MasterKey,
  type SecretMap,
  TAG_BYTES,
} from "@gtmgrid/cloud";
import { Context, Effect, Layer } from "effect";

/**
 * The injectable crypto seam. One `Context.Tag` exposing the two operations the
 * credential domain needs: encrypt a secret map for storage, decrypt a stored
 * envelope for a run. Both are workspace-bound (the workspace id is the GCM AAD,
 * so a ciphertext cannot be decrypted under another workspace).
 */
export class CryptoService extends Context.Tag("CryptoService")<
  CryptoService,
  {
    /**
     * Envelope-encrypt `secrets` for `workspaceId`, returning the `secretsEnc`
     * ciphertext to persist. Plaintext never reaches the DB — the save path calls
     * this BEFORE the upsert.
     */
    readonly encrypt: (
      workspaceId: string,
      secrets: SecretMap,
    ) => Effect.Effect<string, EncryptError>;
    /**
     * Decrypt a stored `secretsEnc` envelope back into the secret map. The ONLY
     * path that yields plaintext; callers MUST have authorized the member first.
     * Fails (DecryptError) on a wrong key, tampering, or a workspace mismatch.
     */
    readonly decrypt: (
      workspaceId: string,
      secretsEnc: string,
    ) => Effect.Effect<SecretMap, DecryptError>;
  }
>() {}

/**
 * Build a {@link CryptoService} Layer that wires the pure
 * {@link CredentialCryptoService} to the given environment ports. Both the live
 * and test Layers share this so production and tests run the IDENTICAL crypto
 * core, differing only in where the master key + primitives come from.
 */
const cryptoServiceFrom = (
  masterKeyLayer: Layer.Layer<MasterKey>,
  primitivesLayer: Layer.Layer<CryptoPrimitives>,
): Layer.Layer<CryptoService> =>
  Layer.effect(
    CryptoService,
    Effect.gen(function* () {
      const core = yield* CredentialCryptoService;
      return {
        encrypt: (workspaceId, secrets) => core.encrypt(workspaceId, secrets),
        decrypt: (workspaceId, secretsEnc) =>
          core.decrypt(workspaceId, secretsEnc),
      };
    }),
  ).pipe(
    Layer.provide(CredentialCryptoService.Default),
    Layer.provide(masterKeyLayer),
    Layer.provide(primitivesLayer),
  );

/**
 * A {@link CryptoPrimitives} Layer backed by REAL `node:crypto` AES-256-GCM.
 * Identical to the primitives convex/model/crypto.ts provides — round-trips run
 * genuine cryptography. The IV/tag length checks fail closed on a tampered
 * envelope rather than crashing inside the cipher.
 */
const nodeCryptoPrimitivesLayer: Layer.Layer<CryptoPrimitives> = Layer.succeed(
  CryptoPrimitives,
  {
    randomBytes: (n) => Effect.sync(() => new Uint8Array(randomBytes(n))),
    encrypt: ({ key, iv, plaintext, aad }) =>
      Effect.try({
        try: () => {
          const cipher = createCipheriv("aes-256-gcm", key, iv);
          if (aad !== undefined) cipher.setAAD(aad);
          const ciphertext = new Uint8Array(
            Buffer.concat([cipher.update(plaintext), cipher.final()]),
          );
          return { ciphertext, tag: new Uint8Array(cipher.getAuthTag()) };
        },
        catch: (cause) =>
          new EncryptErrorClass({
            message: "AES-256-GCM encrypt failed.",
            cause,
          }),
      }),
    decrypt: ({ key, iv, ciphertext, tag, aad }) =>
      Effect.try({
        try: () => {
          // Validate the IV/tag length BEFORE node:crypto so a tampered/truncated
          // envelope fails closed as a typed DecryptError, not an opaque crash.
          if (iv.byteLength !== IV_BYTES) {
            throw new Error("invalid IV length");
          }
          if (tag.byteLength !== TAG_BYTES) {
            throw new Error("invalid auth tag length");
          }
          const decipher = createDecipheriv("aes-256-gcm", key, iv);
          decipher.setAuthTag(tag);
          if (aad !== undefined) decipher.setAAD(aad);
          return new Uint8Array(
            Buffer.concat([decipher.update(ciphertext), decipher.final()]),
          );
        },
        catch: (cause) =>
          new DecryptErrorClass({
            message: "AES-256-GCM decrypt failed (auth tag mismatch?).",
            cause,
          }),
      }),
  },
);

/**
 * The LIVE {@link MasterKey} Layer. Reads `CREDENTIALS_MASTER_KEY` from the
 * environment LAZILY (inside the Effect, not at import), decoding it to exactly
 * 32 bytes via the pure {@link decodeMasterKeyBytes}; a missing/malformed key
 * fails closed with the typed error so the service never encrypts under a bad key.
 */
const liveMasterKeyLayer: Layer.Layer<MasterKey> = Layer.succeed(MasterKey, {
  bytes: Effect.try({
    try: () => decodeMasterKeyBytes(process.env.CREDENTIALS_MASTER_KEY),
    catch: (cause) =>
      // decodeMasterKeyBytes throws an EncryptError already; re-wrap any other
      // cause so the channel stays the typed EncryptError.
      cause instanceof EncryptErrorClass
        ? cause
        : new EncryptErrorClass({
            message: "Could not read CREDENTIALS_MASTER_KEY.",
            cause,
          }),
  }),
});

/**
 * The production {@link CryptoService} Layer: real `node:crypto` AES-256-GCM with
 * the master key sourced from `CREDENTIALS_MASTER_KEY`.
 */
export const CryptoServiceLive: Layer.Layer<CryptoService> = cryptoServiceFrom(
  liveMasterKeyLayer,
  nodeCryptoPrimitivesLayer,
);

/** A fixed, valid 32-byte master key for deterministic encrypt/decrypt tests. */
export const TEST_MASTER_KEY: Uint8Array = new Uint8Array(32).map(
  (_, i) => i + 1,
);

/**
 * A test {@link CryptoService} Layer using REAL AES-256-GCM but a FIXED master
 * key, so encrypt/decrypt round-trips run genuine cryptography offline with no
 * env and no live database — the injectable seam the AC requires.
 */
export const cryptoServiceLayer = (
  masterKey: Uint8Array = TEST_MASTER_KEY,
): Layer.Layer<CryptoService> =>
  cryptoServiceFrom(
    Layer.succeed(MasterKey, { bytes: Effect.succeed(masterKey) }),
    nodeCryptoPrimitivesLayer,
  );
