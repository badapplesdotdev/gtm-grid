/**
 * Shared (workspace-scoped) credential save orchestration tests (T11).
 *
 * The orchestration is client-side LOGIC (an Effect service), so we test it by
 * providing a FAKE {@link CredentialSaver} Layer — no real Convex, no network.
 * We assert it:
 *   1. refuses to save without a signed-in session (typed error, saver never
 *      called — so plaintext never leaves the client),
 *   2. refuses to save an empty / whitespace-only key (typed error, saver never
 *      called),
 *   3. on a valid request, forwards the EXACT input (workspace scope + secrets)
 *      to the saver and succeeds, and
 *   4. surfaces a saver failure as a typed {@link CredentialError}.
 *
 * It also covers `aiProviderCredId` namespacing so AI-provider keys can't
 * collide with an extension of the same id in the shared workspace table.
 */

import { Cause, Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  aiProviderCredId,
  apiCredentialSaver,
  CredentialError,
  CredentialSaver,
  CredentialService,
  CredentialServiceLive,
  type SaveCredentialInput,
} from "./credentials";

const input: SaveCredentialInput = {
  workspaceId: "ws1",
  extensionId: "trigify",
  scope: "workspace",
  name: "Trigify",
  secrets: { apiKey: "sk-secret-123" },
};

/** A Live service Layer over a fake saver that records each call and succeeds. */
function fakeSaver() {
  const calls: SaveCredentialInput[] = [];
  const layer = CredentialServiceLive.pipe(
    Layer.provide(
      Layer.succeed(CredentialSaver, {
        save: (i) => {
          calls.push(i);
          return Effect.void;
        },
      }),
    ),
  );
  return { layer, calls };
}

/** A Live service Layer whose saver always fails (records calls too). */
function failingSaver() {
  const calls: SaveCredentialInput[] = [];
  const layer = CredentialServiceLive.pipe(
    Layer.provide(
      Layer.succeed(CredentialSaver, {
        save: (i) => {
          calls.push(i);
          return Effect.fail(new CredentialError({ message: "backend error" }));
        },
      }),
    ),
  );
  return { layer, calls };
}

const run = <A>(
  program: Effect.Effect<A, CredentialError, CredentialService>,
  layer: Layer.Layer<CredentialService>,
) => Effect.runPromiseExit(program.pipe(Effect.provide(layer)));

const save = (hasSession: boolean, i: SaveCredentialInput = input) =>
  Effect.gen(function* () {
    const svc = yield* CredentialService;
    return yield* svc.saveCredential(hasSession, i);
  });

describe("CredentialService", () => {
  it("fails with a typed CredentialError when there is no session", async () => {
    const { layer, calls } = fakeSaver();

    const exit = await run(save(false), layer);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag).toBe("Some");
      if (err._tag === "Some") {
        expect(err.value).toBeInstanceOf(CredentialError);
        expect(err.value.message).toMatch(/sign in/i);
      }
    }
    // Short-circuited: the saver was never called, so no plaintext left the client.
    expect(calls).toHaveLength(0);
  });

  it("fails with a typed CredentialError on an empty / whitespace key", async () => {
    const { layer, calls } = fakeSaver();

    const exit = await run(
      save(true, { ...input, secrets: { apiKey: "   " } }),
      layer,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag === "Some" && err.value instanceof CredentialError).toBe(
        true,
      );
      if (err._tag === "Some") {
        expect(err.value.message).toMatch(/api key/i);
      }
    }
    expect(calls).toHaveLength(0);
  });

  it("forwards the workspace-scoped input to the saver and succeeds", async () => {
    const { layer, calls } = fakeSaver();

    const exit = await run(save(true), layer);

    expect(Exit.isSuccess(exit)).toBe(true);
    // The saver received the EXACT request, including the workspace scope and
    // the plaintext secret map (which it alone forwards to the encrypting action).
    expect(calls).toEqual([input]);
  });

  it("surfaces a saver failure as a typed CredentialError", async () => {
    const { layer, calls } = failingSaver();

    const exit = await run(save(true), layer);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag === "Some" && err.value instanceof CredentialError).toBe(
        true,
      );
      if (err._tag === "Some") {
        expect(err.value.message).toBe("backend error");
      }
    }
    // The save was attempted (the session + key guards passed before it failed).
    expect(calls).toEqual([input]);
  });
});

describe("aiProviderCredId", () => {
  it("namespaces an AI provider id so it can't collide with an extension id", () => {
    expect(aiProviderCredId("openai")).toBe("ai:openai");
    // An extension keeps its raw id, so the two never share a credential key.
    expect(aiProviderCredId("openai")).not.toBe("openai");
  });
});

// ─── apiCredentialSaver — the NEW tRPC `credentials.save` branch (TRI-3255) ────
//
// The strangler-fig replacement for the inline Convex `useAction`-derived saver.
// We inject a fake `mutate` (the tRPC call) to assert it forwards the EXACT input
// (workspace scope + plaintext secrets) and resolves to `void` discarding the row
// id, and maps a tRPC/transport failure to a typed CredentialError — no live
// client. The session/empty-key guards are exercised by the CredentialService
// tests above; here we prove the saver is a transparent transport.

describe("apiCredentialSaver", () => {
  it("forwards the input to the tRPC mutate and resolves to void", async () => {
    const calls: SaveCredentialInput[] = [];
    const saver = apiCredentialSaver(async (i) => {
      calls.push(i as SaveCredentialInput);
      // The tRPC mutation returns the saved row id; the saver discards it.
      return "cred_123";
    });

    const got = await Effect.runPromise(saver.save(input));

    expect(got).toBeUndefined();
    expect(calls).toEqual([input]);
  });

  it("maps a tRPC/transport failure to a typed CredentialError", async () => {
    const saver = apiCredentialSaver(async () => {
      throw new Error("FORBIDDEN");
    });

    const exit = await Effect.runPromiseExit(saver.save(input));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag === "Some" && err.value instanceof CredentialError).toBe(
        true,
      );
      if (err._tag === "Some") expect(err.value.message).toBe("FORBIDDEN");
    }
  });
});
