/**
 * Tests for {@link BillingService.checkout}, exercised against the in-memory
 * {@link TestLayer} with the FAKE Autumn port (@gtmgrid/cloud `fakeAutumnLayer`)
 * — NO SDK, NO env, NO HTTP, NO live database.
 *
 * Outcome-focused: assert the returned checkout URL or the typed error `_tag`.
 * Covers the AC paths: owner/admin gets the Autumn URL; a non-owner/admin is
 * rejected; an unknown plan fails closed before any Autumn call; a misconfigured
 * plan (no URL) surfaces NoCheckoutUrlError; an Autumn transport error surfaces
 * AutumnError (fail-closed).
 */

import type { Membership } from "@gtmgrid/cloud";
import {
  failingAutumnLayer,
  identityLayer,
  memberRepoLayer,
  MembershipService,
  SeatsService,
} from "@gtmgrid/cloud";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { TestLayer, type TestLayerFixtures } from "../layers.js";
import type { Workspace, WorkspaceUser } from "../repositories/workspace-repo.js";
import { workspaceRepoLayer } from "../repositories/workspace-repo.js";
import { BillingService } from "./billing-service.js";

const WS_ID = "11111111-1111-1111-1111-111111111111";

const workspaces: readonly Workspace[] = [
  { id: WS_ID, name: "Alpha", ownerId: "user_owner" },
];
const users: readonly WorkspaceUser[] = [
  { id: "user_owner", name: "Olive", email: "olive@example.com" },
];

const failureTag = <A, E>(exit: Exit.Exit<A, E>): string | undefined => {
  if (Exit.isSuccess(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure)
    ? (failure.value as { _tag?: string })._tag
    : undefined;
};

const run = (fixtures: TestLayerFixtures, planId?: string) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const svc = yield* BillingService;
      return yield* svc.checkout(WS_ID, planId);
    }).pipe(Effect.provide(TestLayer(fixtures))),
  );

describe("BillingService.checkout", () => {
  const ownerMembership: readonly Membership[] = [
    { workspaceId: WS_ID, userId: "user_owner", role: "owner" },
  ];

  it("returns the Autumn checkout URL for an owner on a valid plan", async () => {
    const exit = await run(
      {
        workspaces,
        users,
        memberships: ownerMembership,
        currentUserId: "user_owner",
        autumn: { checkoutUrl: "https://billing.example.com/upgrade/1" },
      },
      "team",
    );
    if (!Exit.isSuccess(exit)) throw new Error("expected success");
    expect(exit.value).toEqual({
      checkoutUrl: "https://billing.example.com/upgrade/1",
    });
  });

  it("rejects a non-owner/admin with InsufficientRoleError (before Autumn)", async () => {
    const exit = await run(
      {
        workspaces,
        users,
        memberships: [
          { workspaceId: WS_ID, userId: "user_member", role: "member" },
        ],
        currentUserId: "user_member",
        autumn: { checkoutUrl: "https://should-not-be-used" },
      },
      "team",
    );
    expect(failureTag(exit)).toBe("InsufficientRoleError");
  });

  it("rejects an unauthenticated caller", async () => {
    const exit = await run(
      { workspaces, users, memberships: ownerMembership, currentUserId: null },
      "team",
    );
    expect(failureTag(exit)).toBe("UnauthenticatedError");
  });

  it("fails closed with UnknownPlanError for a forged plan", async () => {
    const exit = await run(
      {
        workspaces,
        users,
        memberships: ownerMembership,
        currentUserId: "user_owner",
      },
      "not-a-real-plan",
    );
    expect(failureTag(exit)).toBe("UnknownPlanError");
  });

  it("surfaces NoCheckoutUrlError when Autumn returns no URL", async () => {
    const exit = await run(
      {
        workspaces,
        users,
        memberships: ownerMembership,
        currentUserId: "user_owner",
        autumn: { checkoutUrl: null },
      },
      "team",
    );
    expect(failureTag(exit)).toBe("NoCheckoutUrlError");
  });

  it("surfaces AutumnError when the Autumn attach call fails", async () => {
    // Compose BillingService with the FAILING Autumn port on attach, providing
    // its three deps (membership, workspace repo, seats) directly.
    const membership = MembershipService.Default.pipe(
      Layer.provide(identityLayer("user_owner")),
      Layer.provide(memberRepoLayer(ownerMembership)),
    );
    const seats = SeatsService.Default.pipe(
      Layer.provide(failingAutumnLayer("attach")),
    );
    const billing = BillingService.Default.pipe(
      Layer.provide(membership),
      Layer.provide(workspaceRepoLayer(workspaces, users)),
      Layer.provide(seats),
    );
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* BillingService;
        return yield* svc.checkout(WS_ID, "team");
      }).pipe(Effect.provide(billing)),
    );
    expect(failureTag(exit)).toBe("AutumnError");
  });
});
