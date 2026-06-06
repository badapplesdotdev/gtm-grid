/**
 * Tests for the production Live-adapter config decoding (live-config.ts).
 *
 * The Convex Live port adapters (convex/model/crypto.ts, convex/model/seats.ts)
 * delegate their fail-closed env decoding to these pure functions, which are
 * `"use node"`-free and Convex-codegen-free so they run in the root vitest.
 *
 * Covers the finding-#crypto-adapters acceptance criteria — at least
 * CONSTRUCTION (a valid key/secret decodes) and the ENV-MISSING error
 * (fail-closed typed failure) for the master-key (crypto) and Autumn-secret
 * (seats) adapters. Auth's Live adapter is ctx-backed (no env to decode), so it
 * has no env-missing construction path to cover here.
 */

import { describe, expect, it } from "vitest";
import { EncryptError, KEY_BYTES } from "./crypto.js";
import {
  decodeMasterKeyBytes,
  MissingSecretError,
  requireSecret,
} from "./live-config.js";

describe("decodeMasterKeyBytes (CREDENTIALS_MASTER_KEY adapter)", () => {
  it("decodes a 64-char hex key to exactly 32 bytes", () => {
    const hex = "a".repeat(64);
    const key = decodeMasterKeyBytes(hex);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.byteLength).toBe(KEY_BYTES);
  });

  it("decodes a base64 key of 32 bytes", () => {
    const b64 = Buffer.from(new Uint8Array(KEY_BYTES).fill(7)).toString(
      "base64",
    );
    const key = decodeMasterKeyBytes(b64);
    expect(key.byteLength).toBe(KEY_BYTES);
    expect([...key]).toEqual(Array.from({ length: KEY_BYTES }, () => 7));
  });

  it("throws EncryptError when the key is missing (fail closed)", () => {
    expect(() => decodeMasterKeyBytes(undefined)).toThrow(EncryptError);
    expect(() => decodeMasterKeyBytes("")).toThrow(EncryptError);
  });

  it("throws EncryptError when the key decodes to the wrong length", () => {
    // 8 hex chars → 4 bytes, not 32.
    expect(() => decodeMasterKeyBytes("deadbeef")).toThrow(EncryptError);
  });
});

describe("requireSecret (AUTUMN_SECRET_KEY adapter)", () => {
  it("returns the secret when present", () => {
    expect(requireSecret("AUTUMN_SECRET_KEY", "am_sk_live_123")).toBe(
      "am_sk_live_123",
    );
  });

  it("throws MissingSecretError when absent (fail closed)", () => {
    expect(() => requireSecret("AUTUMN_SECRET_KEY", undefined)).toThrow(
      MissingSecretError,
    );
    expect(() => requireSecret("AUTUMN_SECRET_KEY", "")).toThrow(
      MissingSecretError,
    );
  });

  it("names the missing secret on the typed error", () => {
    try {
      requireSecret("AUTUMN_SECRET_KEY", undefined);
      throw new Error("expected MissingSecretError");
    } catch (e) {
      expect(e).toBeInstanceOf(MissingSecretError);
      if (e instanceof MissingSecretError) {
        expect(e.name).toBe("AUTUMN_SECRET_KEY");
      }
    }
  });
});
