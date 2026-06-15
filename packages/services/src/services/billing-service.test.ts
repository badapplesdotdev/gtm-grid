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
  planName,
  SeatsService,
} from "@gtmgrid/cloud";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { TestLayer, type TestLayerFixtures } from "../layers.js";
import type { Workspace, WorkspaceUser } from "../repositories/workspace-repo.js";
import { workspaceRepoLayer } from "../repositories/workspace-repo.js";
import { workspaceMemberRepoLayer } from "../repositories/workspace-member-repo.js";
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
    const autumn = failingAutumnLayer("attach");
    const seats = SeatsService.Default.pipe(Layer.provide(autumn));
    const billing = BillingService.Default.pipe(
      Layer.provide(membership),
      Layer.provide(workspaceRepoLayer(workspaces, users)),
      Layer.provide(workspaceMemberRepoLayer([])),
      Layer.provide(seats),
      Layer.provide(autumn),
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

describe("BillingService.syncPlan", () => {
  const ownerMembership: readonly Membership[] = [
    { workspaceId: WS_ID, userId: "user_owner", role: "owner" },
  ];

  const runSync = (fixtures: TestLayerFixtures) =>
    Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* BillingService;
        return yield* svc.syncPlan(WS_ID);
      }).pipe(Effect.provide(TestLayer(fixtures))),
    );

  it("reflects the active paid plan reported by Autumn", async () => {
    const exit = await runSync({
      workspaces,
      users,
      memberships: ownerMembership,
      currentUserId: "user_owner",
      autumn: { activePlanIds: ["business"] },
    });
    if (!Exit.isSuccess(exit)) throw new Error("expected success");
    expect(exit.value).toEqual({
      id: "business",
      name: planName("business"),
      trialEndsAt: null,
    });
  });

  it("normalises an annual plan id to its tier name", async () => {
    const exit = await runSync({
      workspaces,
      users,
      memberships: ownerMembership,
      currentUserId: "user_owner",
      autumn: { activePlanIds: ["business_annual"] },
    });
    if (!Exit.isSuccess(exit)) throw new Error("expected success");
    expect(exit.value).toEqual({
      id: "business_annual",
      name: planName("business_annual"),
      trialEndsAt: null,
    });
  });

  it("surfaces the trial end when the active subscription is trialing", async () => {
    const exit = await runSync({
      workspaces,
      users,
      memberships: ownerMembership,
      currentUserId: "user_owner",
      autumn: { activePlanIds: ["team"], trialEndsAt: 1_999_000_000_000 },
    });
    if (!Exit.isSuccess(exit)) throw new Error("expected success");
    expect(exit.value).toEqual({
      id: "team",
      name: planName("team"),
      trialEndsAt: 1_999_000_000_000,
    });
  });

  it("resolves to Free when Autumn has no active paid plan", async () => {
    const exit = await runSync({
      workspaces,
      users,
      memberships: ownerMembership,
      currentUserId: "user_owner",
      autumn: { activePlanIds: ["free"] },
    });
    if (!Exit.isSuccess(exit)) throw new Error("expected success");
    expect(exit.value).toEqual({ id: null, name: "Free", trialEndsAt: null });
  });

  it("allows any member (not only owner/admin) to refresh the plan", async () => {
    const exit = await runSync({
      workspaces,
      users,
      memberships: [
        { workspaceId: WS_ID, userId: "user_member", role: "member" },
      ],
      currentUserId: "user_member",
      autumn: { activePlanIds: ["team"] },
    });
    expect(failureTag(exit)).toBeUndefined();
  });

  it("rejects a non-member with NotAMemberError", async () => {
    const exit = await runSync({
      workspaces,
      users,
      memberships: [],
      currentUserId: "user_stranger",
      autumn: { activePlanIds: ["team"] },
    });
    expect(failureTag(exit)).toBe("NotAMemberError");
  });
});

describe("BillingService.syncPlanFromWebhook", () => {
  const runWebhookSync = (fixtures: TestLayerFixtures) =>
    Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* BillingService;
        return yield* svc.syncPlanFromWebhook(WS_ID);
      }).pipe(Effect.provide(TestLayer(fixtures))),
    );

  it("reflects the active paid plan WITHOUT any member identity (secret-trusted webhook)", async () => {
    // No memberships, no current user — the webhook has no session. syncPlan would
    // reject (NotAMemberError / UnauthenticatedError); syncPlanFromWebhook must NOT.
    const exit = await runWebhookSync({
      workspaces,
      users,
      memberships: [],
      currentUserId: null,
      autumn: { activePlanIds: ["business"] },
    });
    if (!Exit.isSuccess(exit)) throw new Error("expected success");
    expect(exit.value).toEqual({
      id: "business",
      name: planName("business"),
      trialEndsAt: null,
    });
  });

  it("REVOKES to Free (id null) when Autumn reports no active paid plan — the out-of-app cancellation path", async () => {
    const exit = await runWebhookSync({
      workspaces,
      users,
      memberships: [],
      currentUserId: null,
      autumn: { activePlanIds: ["free"] },
    });
    if (!Exit.isSuccess(exit)) throw new Error("expected success");
    expect(exit.value).toEqual({ id: null, name: "Free", trialEndsAt: null });
  });

  it("does NOT fail with NotAMemberError for a non-member workspace id (no authz on this path)", async () => {
    const exit = await runWebhookSync({
      workspaces,
      users,
      memberships: [],
      currentUserId: "user_stranger",
      autumn: { activePlanIds: ["team"] },
    });
    expect(failureTag(exit)).toBeUndefined();
  });
});

describe("BillingService.previewSeatChange", () => {
  const ownerMembership: readonly Membership[] = [
    { workspaceId: WS_ID, userId: "user_owner", role: "owner" },
  ];

  it("previews the new bill for current members + 1 seat", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* BillingService;
        return yield* svc.previewSeatChange(WS_ID);
      }).pipe(
        Effect.provide(
          TestLayer({
            workspaces,
            users,
            memberships: ownerMembership,
            members: [
              {
                id: "m1",
                workspaceId: WS_ID,
                userId: "user_owner",
                role: "owner",
                createdAt: 1,
                name: null,
                email: null,
              },
            ],
            currentUserId: "user_owner",
            autumn: { perSeatPrice: 20 },
          }),
        ),
      ),
    );
    if (!Exit.isSuccess(exit)) throw new Error("expected success");
    // 1 existing member + 1 new seat = 2 seats × $20 = $40.
    expect(exit.value).toEqual({ seats: 2, total: 40, currency: "usd" });
  });

  it("rejects a non-member with NotAMemberError", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* BillingService;
        return yield* svc.previewSeatChange(WS_ID);
      }).pipe(
        Effect.provide(
          TestLayer({
            workspaces,
            users,
            memberships: [],
            currentUserId: "stranger",
            autumn: { perSeatPrice: 20 },
          }),
        ),
      ),
    );
    expect(failureTag(exit)).toBe("NotAMemberError");
  });
});
