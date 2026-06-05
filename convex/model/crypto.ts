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
  DecryptError,
  EncryptError,
  KEY_BYTES,
  MasterKey,
  type SecretMap,
  TAG_BYTES,
} from "@gtmgrid/cloud";
import { ConvexError } from "convex/values";
import { Cause, Effect, Exit, Layer, Option } from "effect";

/**
 * Decode `CREDENTIALS_MASTER_KEY` from the deployment env into a raw 32-byte
 * key. Accepts a 64-char hex string or a base64 string; anything that does not
 * decode to exactly {@link KEY_BYTES} bytes is a misconfiguration and fails the
 * {@link MasterKey} port with {@link EncryptError} (fail-closed: we never
 * encrypt under, or decrypt with, a bad key).
 */
function decodeMasterKey(): Uint8Array {
  const raw = process.env.CREDENTIALS_MASTER_KEY;
  if (raw === undefined || raw === "") {
    throw new EncryptError({
      message: "CREDENTIALS_MASTER_KEY is not set on the Convex deployment.",
    });
  }
  const trimmed = raw.trim();
  // Prefer hex when the string is exactly 64 hex chars; else try base64.
  const isHex = /^[0-9a-fA-F]{64}$/.test(trimmed);
  const buf = isHex
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (buf.byteLength !== KEY_BYTES) {
    throw new EncryptError({
      message:
        `CREDENTIALS_MASTER_KEY must decode to ${KEY_BYTES} bytes ` +
        `(got ${buf.byteLength}); use 64 hex chars or base64 of 32 bytes.`,
    });
  }
  return new Uint8Array(buf);
}

/** {@link MasterKey} Layer backed by the deployment env. */
const masterKeyLayer: Layer.Layer<MasterKey> = Layer.succeed(MasterKey, {
  bytes: Effect.try({
    try: () => decodeMasterKey(),
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
          const decipher = createDecipheriv("aes-256-gcm", key, iv);
          if (tag.byteLength !== TAG_BYTES) {
            throw new Error("invalid auth tag length");
          }
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
    const err = failure.value as { _tag?: string; message?: string };
    throw new ConvexError({
      code: err._tag ?? "CryptoError",
      message: err.message ?? "Credential encryption failed.",
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
