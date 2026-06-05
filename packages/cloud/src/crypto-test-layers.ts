/**
 * Deterministic test `Layer`s for credential envelope encryption (T7).
 *
 * Per the Effect test conventions the two environment ports —
 * {@link MasterKey} and {@link CryptoPrimitives} — are substituted with real,
 * in-memory `Layer`s rather than a mocking framework.
 *
 * `realCryptoPrimitivesLayer` runs ACTUAL AES-256-GCM via `node:crypto` (the
 * same primitives the Convex layer uses), so the round-trip tests exercise real
 * cryptography end to end and don't trust a fake to be correct. The master-key
 * layers let a test inject a fixed key, an absent key (misconfiguration), or a
 * DIFFERENT key (rotation / wrong-key decryption) deterministically.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Effect, Layer } from "effect";
import {
  CryptoPrimitives,
  DecryptError,
  EncryptError,
  KEY_BYTES,
  MasterKey,
  TAG_BYTES,
} from "./crypto.js";

/** A fixed, valid 32-byte master key for deterministic encrypt/decrypt tests. */
export const TEST_MASTER_KEY = new Uint8Array(KEY_BYTES).map((_, i) => i + 1);

/** A DIFFERENT valid 32-byte key — models a rotated / wrong master key. */
export const OTHER_MASTER_KEY = new Uint8Array(KEY_BYTES).map(
  (_, i) => (i + 1) * 7,
);

/** A {@link MasterKey} Layer that yields the given (or default) fixed key. */
export const masterKeyLayer = (
  key: Uint8Array = TEST_MASTER_KEY,
): Layer.Layer<MasterKey> =>
  Layer.succeed(MasterKey, { bytes: Effect.succeed(key) });

/**
 * A {@link MasterKey} Layer that fails with {@link EncryptError} — models a
 * missing/short `CREDENTIALS_MASTER_KEY` so we can assert the service fails
 * closed (never encrypts under, or decrypts to, a bad key).
 */
export const missingMasterKeyLayer = (): Layer.Layer<MasterKey> =>
  Layer.succeed(MasterKey, {
    bytes: Effect.fail(
      new EncryptError({ message: "CREDENTIALS_MASTER_KEY is not configured." }),
    ),
  });

/**
 * A {@link CryptoPrimitives} Layer backed by REAL `node:crypto` AES-256-GCM.
 * This is intentionally not a fake: round-trip tests run genuine cryptography,
 * matching exactly what convex/model/crypto.ts provides in production.
 */
export const realCryptoPrimitivesLayer = (): Layer.Layer<CryptoPrimitives> =>
  Layer.succeed(CryptoPrimitives, {
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
          // A GCM tag mismatch (wrong key, tampering, wrong AAD) throws here.
          new DecryptError({
            message: "AES-256-GCM decrypt failed (auth tag mismatch?).",
            cause,
          }),
      }),
  });
