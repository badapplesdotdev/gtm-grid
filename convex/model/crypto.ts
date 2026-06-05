"use node";
/**
 * Convex ↔ Effect bridge for workspace credential encryption (T7).
 *
 * The envelope-encryption business rules live as a PURE Effect service in
 * `@gtmgrid/cloud` (packages/cloud/src/crypto.ts): `CredentialCryptoService`
 * encrypts/decrypts a connector secret map under a per-workspace data key that
 * is itself wrapped by a backend master key, talking to the environment through
 * two ports — {@link MasterKey} (the server-held secret) and
 * {@link CryptoPrimitives} (AES-256-GCM + secure randomness). This file is the
 * seam that:
 *
 *   1. builds a {@link MasterKey} Layer from `CREDENTIALS_MASTER_KEY` in the
 *      Convex deployment env (hex or base64, decoded to exactly 32 bytes), and
 *   2. builds a {@link CryptoPrimitives} Layer backed by real `node:crypto`, and
 *   3. runs the service via `Effect.runPromiseExit`, translating its typed error
 *      channel into a `ConvexError` the client can read.
 *
 * `encryptSecrets` is called by the `saveCredential` mutation (convex/
 * credentials.ts) BEFORE storing — plaintext is encrypted at the trusted
 * boundary and only ciphertext is persisted. `decryptSecretsForRun` is the
 * decrypt-for-run path: the ONLY place plaintext is produced, and only after
 * `requireMember` has authorized the caller.
 *
 * This mirrors convex/model/auth.ts and convex/model/seats.ts: pure rules in
 * @gtmgrid/cloud, env/SDK wiring here. The local machine-key model
 * (packages/engine/src/crypto.ts) is untouched — cloud needs a server-held
 * secret, not a per-machine key.
 *
 * NOTE: `node:crypto` runs only in Convex's Node ("use node") action runtime,
 * NOT in the default query/mutation V8 runtime. The encrypt path therefore runs
 * from a Convex ACTION (the saveCredential action wrapper / mutation calls it
 * through an action), and the decrypt-for-run path is itself an action.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  CredentialCryptoService,
  CryptoPrimitives,
  decodeMasterKeyBytes,
  DecryptError,
  EncryptError,
  IV_BYTES,
  MasterKey,
  type SecretMap,
  TAG_BYTES,
} from "@gtmgrid/cloud";
import { ConvexError } from "convex/values";
import { Cause, Effect, Exit, Layer, Option } from "effect";

/**
 * {@link MasterKey} Layer backed by the deployment env. The decode/validation
 * rules (hex|base64 → exactly 32 bytes, fail-closed on missing/malformed) live
 * in the pure, unit-tested {@link decodeMasterKeyBytes} (@gtmgrid/cloud); this
 * adapter only feeds it the raw env value.
 */
const masterKeyLayer: Layer.Layer<MasterKey> = Layer.succeed(MasterKey, {
  bytes: Effect.try({
    try: () => decodeMasterKeyBytes(process.env.CREDENTIALS_MASTER_KEY),
    catch: (cause) =>
      cause instanceof EncryptError
        ? cause
        : new EncryptError({
            message: "Could not read CREDENTIALS_MASTER_KEY.",
            cause,
          }),
  }),
});

/** {@link CryptoPrimitives} Layer backed by real `node:crypto` AES-256-GCM. */
const cryptoPrimitivesLayer: Layer.Layer<CryptoPrimitives> = Layer.succeed(
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
          new EncryptError({ message: "AES-256-GCM encrypt failed.", cause }),
      }),
    decrypt: ({ key, iv, ciphertext, tag, aad }) =>
      Effect.try({
        try: () => {
          // Validate the IV/nonce length BEFORE handing it to node:crypto: a
          // malformed (tampered/truncated) IV must fail closed as a typed
          // DecryptError, not provoke an opaque crash inside the cipher.
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
          new DecryptError({
            message: "AES-256-GCM decrypt failed (auth tag mismatch?).",
            cause,
          }),
      }),
  },
);

/** Composed Layer: the crypto service with its env-backed ports. */
const cryptoLayer: Layer.Layer<CredentialCryptoService> =
  CredentialCryptoService.Default.pipe(
    Layer.provide(masterKeyLayer),
    Layer.provide(cryptoPrimitivesLayer),
  );

/**
 * Run a `CredentialCryptoService` program, translating a typed failure
 * (`EncryptError` / `DecryptError`) into a `ConvexError` the client can read. A
 * defect (non-typed crash) is rethrown for Convex to log. Mirrors `runSeats` /
 * `runAuthz`.
 */
async function runCrypto<A>(
  program: Effect.Effect<A, unknown, CredentialCryptoService>,
): Promise<A> {
  const exit = await Effect.runPromiseExit(
    program.pipe(Effect.provide(cryptoLayer)),
  );
  if (Exit.isSuccess(exit)) return exit.value;

  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) {
    // The error channel is `EncryptError | DecryptError`; narrow via a typed
    // guard rather than an `as` cast at the Convex seam.
    const err = failure.value;
    if (err instanceof EncryptError || err instanceof DecryptError) {
      throw new ConvexError({ code: err._tag, message: err.message });
    }
    throw new ConvexError({
      code: "CryptoError",
      message: "Credential encryption failed.",
    });
  }
  throw new Error(Cause.pretty(exit.cause));
}

/**
 * Envelope-encrypt a connector secret map for `workspaceId`, returning the
 * `secretsEnc` ciphertext to persist. Called by the trusted save path BEFORE
 * the `saveCredential` mutation stores it — plaintext never reaches the DB.
 */
export function encryptSecrets(
  workspaceId: string,
  secrets: SecretMap,
): Promise<string> {
  return runCrypto(
    Effect.gen(function* () {
      const svc = yield* CredentialCryptoService;
      return yield* svc.encrypt(workspaceId, secrets);
    }),
  );
}

/**
 * Decrypt a stored `secretsEnc` envelope back into the secret map for a run.
 * The ONLY path that yields plaintext; callers MUST have authorized the member
 * (`requireMember`) first. Fails (ConvexError) on a wrong key, tampering, or a
 * workspace mismatch rather than ever returning a wrong/partial secret.
 */
export function decryptSecretsForRun(
  workspaceId: string,
  secretsEnc: string,
): Promise<SecretMap> {
  return runCrypto(
    Effect.gen(function* () {
      const svc = yield* CredentialCryptoService;
      return yield* svc.decrypt(workspaceId, secretsEnc);
    }),
  );
}
