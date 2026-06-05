/**
 * Tests for workspace credential envelope encryption (T7).
 *
 * Outcome-focused per docs/effect-conventions.md: we assert the returned
 * plaintext (round-trip) or the typed error `_tag` in the Effect error channel
 * via `Effect.runPromiseExit` + `Cause.failureOption` — never internals, never
 * try/catch. The crypto primitives are REAL `node:crypto` (so round-trips
 * exercise genuine AES-256-GCM); only the master key is injected.
 *
 * Covers the acceptance-criteria crypto paths:
 *   - round-trip encrypt → decrypt recovers the exact secret map;
 *   - ciphertext is opaque (no plaintext substring leaks into `secretsEnc`);
 *   - the envelope is workspace-bound: decrypting under a different workspace id
 *     fails (the AAD binding), so a stolen row can't cross workspaces;
 *   - a wrong/rotated master key fails closed (DecryptError, never plaintext);
 *   - a missing master key fails closed on both encrypt and decrypt;
 *   - tampered ciphertext fails the GCM auth tag;
 *   - malformed envelopes fail typed rather than crashing.
 */

import { Cause, Effect, Exit, type Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  CredentialCryptoService,
  DecryptError,
  EncryptError,
  type MasterKey,
  type SecretMap,
} from "./crypto.js";
import {
  masterKeyLayer,
  missingMasterKeyLayer,
  OTHER_MASTER_KEY,
  realCryptoPrimitivesLayer,
} from "./crypto-test-layers.js";

const WORKSPACE = "ws_alpha";
const OTHER_WORKSPACE = "ws_beta";
const SECRETS: SecretMap = { apiKey: "sk-live-SUPER-SECRET-123", region: "eu" };

/** Provide the service + its two ports, with the chosen master-key layer. */
const provide = <A, E>(
  effect: Effect.Effect<A, E, CredentialCryptoService>,
  master: Layer.Layer<MasterKey> = masterKeyLayer(),
): Effect.Effect<A, E> =>
  effect.pipe(
    Effect.provide(CredentialCryptoService.Default),
    Effect.provide(master),
    Effect.provide(realCryptoPrimitivesLayer()),
  );

const run = <A, E>(
  effect: Effect.Effect<A, E, CredentialCryptoService>,
  master?: Layer.Layer<MasterKey>,
): Promise<A> => Effect.runPromise(provide(effect, master));

/** Resolve the typed failure of a run, asserting it failed (not died/succeeded). */
const failureOf = async <A, E>(
  effect: Effect.Effect<A, E, CredentialCryptoService>,
  master?: Layer.Layer<MasterKey>,
): Promise<E> => {
  const exit = await Effect.runPromiseExit(provide(effect, master));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.failureOption(exit.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) return failure.value;
  }
  throw new Error("expected a typed failure");
};

const encrypt = (workspaceId: string, secrets: SecretMap) =>
  Effect.gen(function* () {
    const svc = yield* CredentialCryptoService;
    return yield* svc.encrypt(workspaceId, secrets);
  });

const decrypt = (workspaceId: string, secretsEnc: string) =>
  Effect.gen(function* () {
    const svc = yield* CredentialCryptoService;
    return yield* svc.decrypt(workspaceId, secretsEnc);
  });

describe("envelope encrypt → decrypt round-trip", () => {
  it("recovers the exact secret map", async () => {
    const enc = await run(encrypt(WORKSPACE, SECRETS));
    const dec = await run(decrypt(WORKSPACE, enc));
    expect(dec).toEqual(SECRETS);
  });

  it("produces a fresh data key per encryption (ciphertexts differ)", async () => {
    const a = await run(encrypt(WORKSPACE, SECRETS));
    const b = await run(encrypt(WORKSPACE, SECRETS));
    // Random DEK + IVs mean identical input yields distinct ciphertext, yet
    // both still decrypt back to the same secret.
    expect(a).not.toEqual(b);
    expect(await run(decrypt(WORKSPACE, a))).toEqual(SECRETS);
    expect(await run(decrypt(WORKSPACE, b))).toEqual(SECRETS);
  });

  it("handles an empty secret map", async () => {
    const enc = await run(encrypt(WORKSPACE, {}));
    expect(await run(decrypt(WORKSPACE, enc))).toEqual({});
  });
});

describe("ciphertext is opaque (plaintext never leaks)", () => {
  it("the stored envelope contains no plaintext secret value", async () => {
    const enc = await run(encrypt(WORKSPACE, SECRETS));
    // The raw secret must not appear anywhere in the at-rest ciphertext.
    expect(enc).not.toContain("sk-live-SUPER-SECRET-123");
    expect(enc).not.toContain("SUPER-SECRET");
  });
});

describe("workspace binding (envelope is workspace-scoped)", () => {
  it("fails to decrypt a workspace's envelope under a DIFFERENT workspace id", async () => {
    const enc = await run(encrypt(WORKSPACE, SECRETS));
    // A row stolen from ws_alpha cannot be decrypted as ws_beta: the AAD
    // binding makes the data-key unwrap fail.
    const error = await failureOf(decrypt(OTHER_WORKSPACE, enc));
    expect(error).toBeInstanceOf(DecryptError);
  });
});

describe("master key failures (fail closed)", () => {
  it("decrypting under a wrong/rotated master key fails (never plaintext)", async () => {
    const enc = await run(encrypt(WORKSPACE, SECRETS));
    const error = await failureOf(
      decrypt(WORKSPACE, enc),
      masterKeyLayer(OTHER_MASTER_KEY),
    );
    expect(error).toBeInstanceOf(DecryptError);
  });

  it("encrypt fails with EncryptError when the master key is missing", async () => {
    const error = await failureOf(
      encrypt(WORKSPACE, SECRETS),
      missingMasterKeyLayer(),
    );
    expect(error).toBeInstanceOf(EncryptError);
  });

  it("decrypt fails with DecryptError when the master key is missing", async () => {
    // Encrypt with a valid key, then attempt decrypt with no key configured.
    const enc = await run(encrypt(WORKSPACE, SECRETS));
    const error = await failureOf(
      decrypt(WORKSPACE, enc),
      missingMasterKeyLayer(),
    );
    expect(error).toBeInstanceOf(DecryptError);
  });
});

describe("tamper + malformed handling", () => {
  it("fails when the secret ciphertext is tampered with", async () => {
    const enc = await run(encrypt(WORKSPACE, SECRETS));
    const env = JSON.parse(enc) as { data: string };
    // Flip the data ciphertext → GCM auth-tag verification must reject it.
    const tampered = JSON.stringify({
      ...env,
      data: Buffer.from("totally-different-bytes").toString("base64"),
    });
    const error = await failureOf(decrypt(WORKSPACE, tampered));
    expect(error).toBeInstanceOf(DecryptError);
  });

  it("fails typed (not a crash) on a non-JSON envelope", async () => {
    const error = await failureOf(decrypt(WORKSPACE, "not-an-envelope"));
    expect(error).toBeInstanceOf(DecryptError);
  });

  it("fails typed on a JSON object missing envelope fields", async () => {
    const error = await failureOf(decrypt(WORKSPACE, JSON.stringify({ v: 1 })));
    expect(error).toBeInstanceOf(DecryptError);
  });
});
