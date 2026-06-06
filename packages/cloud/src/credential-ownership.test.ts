/**
 * Tests for personal-credential ownership rules (CredentialOwnershipService).
 *
 * Outcome-focused per docs/effect-conventions.md: we assert the returned
 * owner-binding (`ownerFor`) and the typed authz outcome (`assertCanAccess`
 * succeeds, or fails with `CredentialOwnershipError`) via `Effect.runPromiseExit`
 * + `Cause.failureOption` — never internals, never try/catch.
 *
 * Covers the finding-#21 acceptance criteria:
 *   - personal rows are owner-bound (so two members no longer collide);
 *   - workspace rows are shared (no owner binding, any member may access);
 *   - a member CANNOT read/rotate ANOTHER member's personal key;
 *   - the owner CAN read/rotate their own personal key;
 *   - a legacy personal row with no owner binding fails closed.
 */

import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  CredentialOwnershipError,
  CredentialOwnershipService,
} from "./credential-ownership.js";

const run = <A, E>(
  effect: Effect.Effect<A, E, CredentialOwnershipService>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(CredentialOwnershipService.Default)),
  );

/** Resolve the typed failure of a run, asserting it failed (not died/succeeded). */
const failureOf = async <A, E>(
  effect: Effect.Effect<A, E, CredentialOwnershipService>,
): Promise<E> => {
  const exit = await Effect.runPromiseExit(
    effect.pipe(Effect.provide(CredentialOwnershipService.Default)),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.failureOption(exit.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) return failure.value;
  }
  throw new Error("expected a typed failure");
};

const ALICE = "user_alice";
const BOB = "user_bob";
const EXT = "ai:openai";

describe("ownerFor (the owner a row is stored/looked-up under)", () => {
  it("binds a personal row to the current user", async () => {
    const owner = await run(
      Effect.gen(function* () {
        const svc = yield* CredentialOwnershipService;
        return svc.ownerFor("personal", ALICE);
      }),
    );
    expect(owner).toEqual(Option.some(ALICE));
  });

  it("leaves a workspace row un-owned (shared)", async () => {
    const owner = await run(
      Effect.gen(function* () {
        const svc = yield* CredentialOwnershipService;
        return svc.ownerFor("workspace", ALICE);
      }),
    );
    expect(owner).toEqual(Option.none());
  });

  it("binds different users to distinct owners (no collision)", async () => {
    const [aliceOwner, bobOwner] = await run(
      Effect.gen(function* () {
        const svc = yield* CredentialOwnershipService;
        return [svc.ownerFor("personal", ALICE), svc.ownerFor("personal", BOB)];
      }),
    );
    // Two members saving a personal key for the same connector resolve to
    // distinct owner bindings, so the upsert key (ws, ext, scope, owner) differs.
    expect(aliceOwner).toEqual(Option.some(ALICE));
    expect(bobOwner).toEqual(Option.some(BOB));
    expect(aliceOwner).not.toEqual(bobOwner);
  });
});

describe("assertCanAccess (read/rotate authz on an existing row)", () => {
  it("allows the owner to access their own personal row", async () => {
    await run(
      Effect.gen(function* () {
        const svc = yield* CredentialOwnershipService;
        return yield* svc.assertCanAccess({
          scope: "personal",
          extensionId: EXT,
          currentUserId: ALICE,
          storedOwnerUserId: Option.some(ALICE),
        });
      }),
    );
    // No throw / failure → access permitted.
  });

  it("rejects another member reading/rotating a personal row", async () => {
    const error = await failureOf(
      Effect.gen(function* () {
        const svc = yield* CredentialOwnershipService;
        return yield* svc.assertCanAccess({
          scope: "personal",
          extensionId: EXT,
          currentUserId: BOB,
          storedOwnerUserId: Option.some(ALICE),
        });
      }),
    );
    expect(error).toBeInstanceOf(CredentialOwnershipError);
    if (error instanceof CredentialOwnershipError) {
      expect(error.extensionId).toBe(EXT);
    }
  });

  it("allows any member to access a workspace (shared) row", async () => {
    await run(
      Effect.gen(function* () {
        const svc = yield* CredentialOwnershipService;
        return yield* svc.assertCanAccess({
          scope: "workspace",
          extensionId: EXT,
          currentUserId: BOB,
          storedOwnerUserId: Option.none(),
        });
      }),
    );
    // No failure: workspace rows are shared (membership enforced upstream).
  });

  it("fails closed on a legacy personal row with no owner binding", async () => {
    const error = await failureOf(
      Effect.gen(function* () {
        const svc = yield* CredentialOwnershipService;
        return yield* svc.assertCanAccess({
          scope: "personal",
          extensionId: EXT,
          currentUserId: ALICE,
          storedOwnerUserId: Option.none(),
        });
      }),
    );
    expect(error).toBeInstanceOf(CredentialOwnershipError);
  });
});
