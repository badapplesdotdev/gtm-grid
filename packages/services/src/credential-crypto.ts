/**
 * Live `CredentialCryptoService` Layer for the web/server tier.
 *
 * The web-tier equivalent of `convex/model/crypto.ts`: it backs the PURE
 * envelope-encryption rules in `@gtmgrid/cloud` (`CredentialCryptoService`) with
 * the two environment ports it needs —
 *   - {@link MasterKey} from `CREDENTIALS_MASTER_KEY` (hex|base64 -> 32 bytes,
 *     decoded by the unit-tested `decodeMasterKeyBytes`), and
 *   - {@link CryptoPrimitives} backed by real `node:crypto` AES-256-GCM.
 *
 * The worker credential endpoint (apps/web/app/api/worker/getCredential) DECRYPTS
 * a shared credential through this layer. `node:crypto` runs in the Next.js Node
 * runtime, so the worker route declares `runtime = "nodejs"`.
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
  TAG_BYTES,
} from "@gtmgrid/cloud";
import { Effect, Layer } from "effect";

/** {@link MasterKey} backed by `CREDENTIALS_MASTER_KEY`; fail-closed if unset. */
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

/** {@link CryptoPrimitives} backed by real `node:crypto` AES-256-GCM. */
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
          if (iv.byteLength !== IV_BYTES) throw new Error("invalid IV length");
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

/** Composed live Layer: the crypto service with its env-backed ports. */
export const credentialCryptoLive: Layer.Layer<CredentialCryptoService> =
  CredentialCryptoService.Default.pipe(
    Layer.provide(masterKeyLayer),
    Layer.provide(cryptoPrimitivesLayer),
  );
