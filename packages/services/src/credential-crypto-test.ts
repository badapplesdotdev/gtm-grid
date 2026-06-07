/**
 * Deterministic TEST `CredentialCryptoService` Layer for offline service/router
 * tests.
 *
 * Mirrors the web-tier {@link credentialCryptoLive} but with a FIXED in-memory
 * master key (no env read) and real `node:crypto` AES-256-GCM primitives, so a
 * test can encrypt a credential envelope and assert the worker `getCredential`
 * path decrypts it round-trip — with NO live database and no env configuration.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  CredentialCryptoService,
  CryptoPrimitives,
  DecryptError,
  EncryptError,
  IV_BYTES,
  KEY_BYTES,
  MasterKey,
  TAG_BYTES,
} from "@gtmgrid/cloud";
import { Effect, Layer } from "effect";

/** A fixed, valid 32-byte master key for deterministic tests. */
export const TEST_MASTER_KEY = new Uint8Array(KEY_BYTES).map((_, i) => i + 1);

const masterKeyLayer = (key: Uint8Array): Layer.Layer<MasterKey> =>
  Layer.succeed(MasterKey, { bytes: Effect.succeed(key) });

const realPrimitivesLayer: Layer.Layer<CryptoPrimitives> = Layer.succeed(
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
          new EncryptError({ message: "encrypt failed", cause }),
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
          new DecryptError({ message: "decrypt failed", cause }),
      }),
  },
);

/** The composed test crypto service (fixed key + real AES-256-GCM). */
export const credentialCryptoTest = (
  key: Uint8Array = TEST_MASTER_KEY,
): Layer.Layer<CredentialCryptoService> =>
  CredentialCryptoService.Default.pipe(
    Layer.provide(masterKeyLayer(key)),
    Layer.provide(realPrimitivesLayer),
  );
