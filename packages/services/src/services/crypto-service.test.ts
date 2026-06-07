/**
 * Tests for the injectable {@link CryptoService}, run entirely against the
 * in-memory {@link cryptoServiceLayer} — REAL AES-256-GCM under a fixed test
 * master key, NO env and NO database (crypto tests need no DB, per the AC).
 *
 * Covers the AC's encrypt/decrypt round-trip plus the security boundaries the
 * envelope guarantees: ciphertext is opaque (no plaintext leaks into it), the
 * workspace binding (AAD) is enforced, tampering is rejected, and a different
 * master key cannot decrypt.
 */

import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  CryptoService,
  cryptoServiceLayer,
  TEST_MASTER_KEY,
} from "./crypto-service.js";

const WS = "11111111-1111-1111-1111-111111111111";
const OTHER_WS = "22222222-2222-2222-2222-222222222222";
const OTHER_KEY = new Uint8Array(32).map((_, i) => (i + 1) * 7);

/** Run an Effect against the default test crypto layer. */
const run = <A, E>(program: Effect.Effect<A, E, CryptoService>) =>
  Effect.runPromiseExit(program.pipe(Effect.provide(cryptoServiceLayer())));

/** Pull the typed failure tag out of a failed exit. */
const failureTag = <A, E>(exit: Exit.Exit<A, E>): string | undefined =>
  Exit.isSuccess(exit)
    ? undefined
    : Option.getOrUndefined(
        Option.map(
          Cause.failureOption(exit.cause),
          (f) => (f as { _tag?: string })._tag ?? "",
        ),
      );

describe("CryptoService round-trip", () => {
  it("encrypts then decrypts back to the original secret map", async () => {
    const secrets = { apiKey: "sk-test-123", region: "eu" };
    const exit = await run(
      Effect.gen(function* () {
        const svc = yield* CryptoService;
        const enc = yield* svc.encrypt(WS, secrets);
        return yield* svc.decrypt(WS, enc);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toEqual(secrets);
  });

  it("produces ciphertext that does not contain the plaintext secret", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const svc = yield* CryptoService;
        return yield* svc.encrypt(WS, { apiKey: "super-secret-value" });
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).not.toContain("super-secret-value");
      // The envelope is versioned JSON of base64 fields, never the raw map.
      expect(JSON.parse(exit.value)).toMatchObject({ v: 1 });
    }
  });

  it("emits a fresh envelope per encrypt (random data key + IVs)", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const svc = yield* CryptoService;
        const a = yield* svc.encrypt(WS, { apiKey: "x" });
        const b = yield* svc.encrypt(WS, { apiKey: "x" });
        return [a, b] as const;
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value[0]).not.toEqual(exit.value[1]);
  });
});

describe("CryptoService workspace binding", () => {
  it("rejects decrypt under a DIFFERENT workspace id (AAD mismatch)", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const svc = yield* CryptoService;
        const enc = yield* svc.encrypt(WS, { apiKey: "bound" });
        return yield* svc.decrypt(OTHER_WS, enc);
      }),
    );
    expect(failureTag(exit)).toBe("DecryptError");
  });
});

describe("CryptoService failure modes", () => {
  it("rejects a tampered envelope with DecryptError", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* CryptoService;
        const enc = yield* svc.encrypt(WS, { apiKey: "tamper" });
        const env = JSON.parse(enc) as { data: string };
        // Flip the secret ciphertext so the GCM auth tag no longer verifies.
        const tampered = JSON.stringify({
          ...env,
          data: Buffer.from("not-the-real-ciphertext").toString("base64"),
        });
        return yield* svc.decrypt(WS, tampered);
      }).pipe(Effect.provide(cryptoServiceLayer())),
    );
    expect(failureTag(exit)).toBe("DecryptError");
  });

  it("rejects malformed (non-envelope) ciphertext with DecryptError", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const svc = yield* CryptoService;
        return yield* svc.decrypt(WS, "{not valid json");
      }),
    );
    expect(failureTag(exit)).toBe("DecryptError");
  });

  it("cannot decrypt with a DIFFERENT master key (rotation / wrong key)", async () => {
    // Encrypt under the default key, then try to decrypt under another key.
    const encExit = await run(
      Effect.gen(function* () {
        const svc = yield* CryptoService;
        return yield* svc.encrypt(WS, { apiKey: "rotated" });
      }),
    );
    expect(Exit.isSuccess(encExit)).toBe(true);
    if (!Exit.isSuccess(encExit)) return;

    const decExit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* CryptoService;
        return yield* svc.decrypt(WS, encExit.value);
      }).pipe(Effect.provide(cryptoServiceLayer(OTHER_KEY))),
    );
    expect(failureTag(decExit)).toBe("DecryptError");
  });

  it("round-trips with an explicit fixed master key too", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* CryptoService;
        const enc = yield* svc.encrypt(WS, { token: "abc" });
        return yield* svc.decrypt(WS, enc);
      }).pipe(Effect.provide(cryptoServiceLayer(TEST_MASTER_KEY))),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toEqual({ token: "abc" });
  });
});
