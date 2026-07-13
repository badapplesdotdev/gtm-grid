import { describe, expect, it } from "vitest";
import { decryptSecrets, encryptSecrets } from "./crypto.js";

// AES-256-GCM with a per-machine key at ~/.gtmgrid/key. These tests exercise the
// round-trip + tamper-rejection against whatever key the machine has (the round
// trip is key-agnostic), so they need no fixture key.
describe("credential crypto — AES-256-GCM secret encryption", () => {
  it("round-trips a secret map", () => {
    const secrets = { TRIGIFY_API_KEY: "abc-123", OPENAI_API_KEY: "sk-xyz" };
    expect(decryptSecrets(encryptSecrets(secrets))).toEqual(secrets);
  });

  it("round-trips an empty map", () => {
    expect(decryptSecrets(encryptSecrets({}))).toEqual({});
  });

  it("preserves unicode + special characters", () => {
    const secrets = { note: "café — 🔑 \"quoted\" \\slash\\" };
    expect(decryptSecrets(encryptSecrets(secrets))).toEqual(secrets);
  });

  it("produces a different blob each time for the same input (random IV)", () => {
    const s = { k: "v" };
    expect(encryptSecrets(s)).not.toBe(encryptSecrets(s));
  });

  it("rejects a tampered blob (GCM auth tag catches modification)", () => {
    const blob = encryptSecrets({ k: "v" });
    const buf = Buffer.from(blob, "base64");
    buf[buf.length - 1] ^= 0xff; // flip the last ciphertext byte
    expect(() => decryptSecrets(buf.toString("base64"))).toThrow();
  });
});
