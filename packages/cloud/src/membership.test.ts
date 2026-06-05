/**
 * Tests for the workspace authz core (requireMember / requireRole).
 *
 * Outcome-focused per docs/effect-conventions.md: we assert the returned
 * membership or the typed error `_tag` in the Effect error channel via
 * `Effect.runPromiseExit` + `Cause.failureOption` — never internal calls, never
 * try/catch. Dependencies come from in-memory test `Layer`s (no mocks).
 *
 * Covers the acceptance-criteria paths: member, non-member, unauthenticated,
 * plus role enforcement and store-failure propagation.
 */

import { Cause, Effect, Exit, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  InsufficientRoleError,
  type Membership,
  MembershipService,
  NotAMemberError,
  UnauthenticatedError,
} from "./membership.js";
import {
  failingMemberRepoLayer,
  identityLayer,
  memberRepoLayer,
} from "./test-layers.js";

const WS = "ws_alpha";
const OTHER_WS = "ws_beta";

const memberships: readonly Membership[] = [
  { workspaceId: WS, userId: "user_owner", role: "owner" },
  { workspaceId: WS, userId: "user_admin", role: "admin" },
  { workspaceId: WS, userId: "user_member", role: "member" },
];

/**
 * Build the full Layer for a run: MembershipService wired to a fixed identity
 * and the standard membership list (overridable for failure cases).
 */
const layerFor = (
  userId: string | null,
  repo: Layer.Layer<
    import("./membership.js").MemberRepo
  > = memberRepoLayer(memberships),
) =>
  MembershipService.Default.pipe(
    Layer.provide(identityLayer(userId)),
    Layer.provide(repo),
  );

/** Resolve the typed failure of a run, asserting it failed (not died/succeeded). */
const failureOf = async <A, E>(
  effect: Effect.Effect<A, E, MembershipService>,
  userId: string | null,
  repo?: Layer.Layer<import("./membership.js").MemberRepo>,
): Promise<E> => {
  const exit = await Effect.runPromiseExit(
    effect.pipe(Effect.provide(layerFor(userId, repo))),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.failureOption(exit.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) return failure.value;
  }
  throw new Error("expected a typed failure");
};

const run = <A, E>(
  effect: Effect.Effect<A, E, MembershipService>,
  userId: string | null,
  repo?: Layer.Layer<import("./membership.js").MemberRepo>,
): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(layerFor(userId, repo))));

const program = Effect.gen(function* () {
  return yield* MembershipService;
});

describe("requireMember", () => {
  it("returns the membership for a member of the workspace", async () => {
    const membership = await run(
      Effect.gen(function* () {
        const svc = yield* program;
        return yield* svc.requireMember(WS);
      }),
      "user_member",
    );
    expect(membership).toEqual({
      workspaceId: WS,
      userId: "user_member",
      role: "member",
    });
  });

  it("preserves the caller's role (owner) on the returned membership", async () => {
    const membership = await run(
      Effect.gen(function* () {
        const svc = yield* program;
        return yield* svc.requireMember(WS);
      }),
      "user_owner",
    );
    expect(membership.role).toBe("owner");
  });

  it("fails with NotAMemberError when authenticated but not a member", async () => {
    const error = await failureOf(
      Effect.gen(function* () {
        const svc = yield* program;
        return yield* svc.requireMember(WS);
      }),
      "user_stranger",
    );
    expect(error).toBeInstanceOf(NotAMemberError);
    if (error instanceof NotAMemberError) {
      expect(error.workspaceId).toBe(WS);
      expect(error.userId).toBe("user_stranger");
    }
  });

  it("fails with NotAMemberError when a member of a DIFFERENT workspace asks", async () => {
    // user_member belongs to WS, not OTHER_WS.
    const error = await failureOf(
      Effect.gen(function* () {
        const svc = yield* program;
        return yield* svc.requireMember(OTHER_WS);
      }),
      "user_member",
    );
    expect(error).toBeInstanceOf(NotAMemberError);
    if (error instanceof NotAMemberError) {
      expect(error.workspaceId).toBe(OTHER_WS);
    }
  });

  it("fails with UnauthenticatedError when no one is signed in", async () => {
    const error = await failureOf(
      Effect.gen(function* () {
        const svc = yield* program;
        return yield* svc.requireMember(WS);
      }),
      null,
    );
    expect(error).toBeInstanceOf(UnauthenticatedError);
  });

  it("propagates a typed MemberRepoError when the lookup fails", async () => {
    const error = await failureOf(
      Effect.gen(function* () {
        const svc = yield* program;
        return yield* svc.requireMember(WS);
      }),
      "user_member",
      failingMemberRepoLayer("boom"),
    );
    expect(error).toMatchObject({ _tag: "MemberRepoError", message: "boom" });
  });
});

describe("requireRole", () => {
  it("returns the membership when the role is allowed", async () => {
    const membership = await run(
      Effect.gen(function* () {
        const svc = yield* program;
        return yield* svc.requireRole(WS, ["owner", "admin"]);
      }),
      "user_admin",
    );
    expect(membership.role).toBe("admin");
  });

  it("fails with InsufficientRoleError when the role is too low", async () => {
    const error = await failureOf(
      Effect.gen(function* () {
        const svc = yield* program;
        return yield* svc.requireRole(WS, ["owner"]);
      }),
      "user_member",
    );
    expect(error).toBeInstanceOf(InsufficientRoleError);
    if (error instanceof InsufficientRoleError) {
      expect(error.required).toEqual(["owner"]);
      expect(error.actual).toBe("member");
    }
  });

  it("still fails with NotAMemberError (not role) for a non-member", async () => {
    const error = await failureOf(
      Effect.gen(function* () {
        const svc = yield* program;
        return yield* svc.requireRole(WS, ["member"]);
      }),
      "user_stranger",
    );
    expect(error).toBeInstanceOf(NotAMemberError);
  });

  it("still fails with UnauthenticatedError before any role check", async () => {
    const error = await failureOf(
      Effect.gen(function* () {
        const svc = yield* program;
        return yield* svc.requireRole(WS, ["member"]);
      }),
      null,
    );
    expect(error).toBeInstanceOf(UnauthenticatedError);
  });
});

describe("requireUserId", () => {
  it("returns the user id when authenticated", async () => {
    const userId = await run(
      Effect.gen(function* () {
        const svc = yield* program;
        return yield* svc.requireUserId;
      }),
      "user_owner",
    );
    expect(userId).toBe("user_owner");
  });

  it("fails with UnauthenticatedError when signed out", async () => {
    const error = await failureOf(
      Effect.gen(function* () {
        const svc = yield* program;
        return yield* svc.requireUserId;
      }),
      null,
    );
    expect(error).toBeInstanceOf(UnauthenticatedError);
  });
});
