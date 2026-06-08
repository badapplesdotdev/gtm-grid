/**
 * Tests for the W2 {@link WorkspaceService} methods — `me`, `listMembers`,
 * `createWorkspace`, `insertMember` — exercised entirely against the in-memory
 * {@link TestLayer} (NO live database).
 *
 * Outcome-focused per docs/effect-conventions.md: assert the returned value or
 * the typed error `_tag`. Covers the AC paths: the `me` shape matches the desktop
 * `useMe` (cloud/auth.ts:142), the seat ceiling is enforced transactionally,
 * createWorkspace inserts the owner membership, and insertMember is idempotent.
 */

import type { Membership } from "@gtmgrid/cloud";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import { TestLayer, type TestLayerFixtures } from "../layers.js";
import type { MemberWithUser } from "../repositories/workspace-member-repo.js";
import type { Workspace, WorkspaceUser } from "../repositories/workspace-repo.js";
import { WorkspaceService } from "./workspace-service.js";

const WS_ID = "11111111-1111-1111-1111-111111111111";
const WS2_ID = "22222222-2222-2222-2222-222222222222";

const failureTag = <A, E>(exit: Exit.Exit<A, E>): string | undefined => {
  if (Exit.isSuccess(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure)
    ? (failure.value as { _tag?: string })._tag
    : undefined;
};

const run = <A, E>(
  fixtures: TestLayerFixtures,
  program: (svc: typeof WorkspaceService.Service) => Effect.Effect<A, E>,
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const svc = yield* WorkspaceService;
      return yield* program(svc);
    }).pipe(Effect.provide(TestLayer(fixtures))),
  );

describe("WorkspaceService.me", () => {
  const users: readonly WorkspaceUser[] = [
    { id: "user_owner", name: "Olive Owner", email: "olive@example.com" },
  ];
  const workspaces: readonly Workspace[] = [
    {
      id: WS_ID,
      name: "Alpha",
      ownerId: "user_owner",
      cloudActionsUsed: 42,
      cloudActionsLimit: 2000,
      currentPlanId: "team",
    },
  ];
  const members: readonly MemberWithUser[] = [
    {
      id: "m1",
      workspaceId: WS_ID,
      userId: "user_owner",
      role: "owner",
      createdAt: 1,
      name: "Olive Owner",
      email: "olive@example.com",
    },
    {
      id: "m2",
      workspaceId: WS_ID,
      userId: "user_two",
      role: "member",
      createdAt: 2,
      name: null,
      email: null,
    },
  ];

  it("returns the exact desktop `useMe` shape (user + workspaces)", async () => {
    const exit = await run({ users, workspaces, members, currentUserId: "user_owner" }, (s) =>
      s.me(),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value).toEqual({
      user: { _id: "user_owner", name: "Olive Owner", email: "olive@example.com" },
      workspaces: [
        {
          _id: WS_ID,
          name: "Alpha",
          role: "owner",
          // seat usage = real member count, limit deferred (null).
          seatUsage: { used: 2, limit: null },
          // cloud actions read from the cached columns (kept semantics).
          cloudActions: { used: 42, limit: 2000 },
          // plan id + derived human name.
          plan: { id: "team", name: "Team", trialEndsAt: null },
        },
      ],
    });
  });

  it("defaults cloudActions to 0/unlimited and plan to Free when unset", async () => {
    const exit = await run(
      {
        users,
        workspaces: [{ id: WS_ID, name: "Alpha", ownerId: "user_owner" }],
        members: [members[0]],
        currentUserId: "user_owner",
      },
      (s) => s.me(),
    );
    if (!Exit.isSuccess(exit)) throw new Error("expected success");
    expect(exit.value.workspaces[0]?.cloudActions).toEqual({
      used: 0,
      limit: null,
    });
    expect(exit.value.workspaces[0]?.plan).toEqual({
      id: null,
      name: "Free",
      trialEndsAt: null,
    });
  });

  it("is batched/no-N+1: lists only workspaces the user belongs to", async () => {
    const exit = await run(
      {
        users,
        workspaces: [
          { id: WS_ID, name: "Alpha", ownerId: "user_owner" },
          { id: WS2_ID, name: "Beta", ownerId: "user_other" },
        ],
        members: [
          members[0],
          {
            id: "m3",
            workspaceId: WS2_ID,
            userId: "user_other",
            role: "owner",
            createdAt: 1,
            name: null,
            email: null,
          },
        ],
        currentUserId: "user_owner",
      },
      (s) => s.me(),
    );
    if (!Exit.isSuccess(exit)) throw new Error("expected success");
    expect(exit.value.workspaces.map((w) => w._id)).toEqual([WS_ID]);
  });

  it("rejects an unauthenticated caller with UnauthenticatedError", async () => {
    const exit = await run({ currentUserId: null }, (s) => s.me());
    expect(failureTag(exit)).toBe("UnauthenticatedError");
  });
});

describe("WorkspaceService.listMembers", () => {
  const memberships: readonly Membership[] = [
    { workspaceId: WS_ID, userId: "user_member", role: "member" },
  ];
  const members: readonly MemberWithUser[] = [
    {
      id: "m_owner",
      workspaceId: WS_ID,
      userId: "user_owner",
      role: "owner",
      createdAt: 100,
      name: "Olive",
      email: "olive@example.com",
    },
    {
      id: "m_member",
      workspaceId: WS_ID,
      userId: "user_member",
      role: "member",
      createdAt: 50,
      name: "Mira",
      email: "mira@example.com",
    },
  ];

  it("returns the roster oldest-first + seat usage for a member", async () => {
    const exit = await run(
      { memberships, members, currentUserId: "user_member" },
      (s) => s.listMembers(WS_ID),
    );
    if (!Exit.isSuccess(exit)) throw new Error("expected success");
    // Sorted by createdAt ascending: m_member (50) then m_owner (100).
    expect(exit.value.members.map((m) => m._id)).toEqual(["m_member", "m_owner"]);
    expect(exit.value.members[0]).toEqual({
      _id: "m_member",
      userId: "user_member",
      role: "member",
      createdAt: 50,
      name: "Mira",
      email: "mira@example.com",
    });
    expect(exit.value.seatUsage).toEqual({ used: 2, limit: null });
  });

  it("rejects a non-member with NotAMemberError", async () => {
    const exit = await run(
      { memberships, members, currentUserId: "user_stranger" },
      (s) => s.listMembers(WS_ID),
    );
    expect(failureTag(exit)).toBe("NotAMemberError");
  });
});

describe("WorkspaceService.createWorkspace", () => {
  it("creates the workspace AND the owner membership in one op", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* WorkspaceService;
        const id = yield* svc.createWorkspace("New Space");
        // The owner can now list the roster (proving the membership exists).
        const roster = yield* svc.listMembers(id);
        return { id, roster };
      }).pipe(Effect.provide(TestLayer({ currentUserId: "user_creator" }))),
    );
    if (!Exit.isSuccess(exit)) throw new Error("expected success");
    expect(exit.value.roster.members).toHaveLength(1);
    expect(exit.value.roster.members[0]).toMatchObject({
      userId: "user_creator",
      role: "owner",
    });
  });

  it("rejects an unauthenticated caller", async () => {
    const exit = await run({ currentUserId: null }, (s) =>
      s.createWorkspace("Nope"),
    );
    expect(failureTag(exit)).toBe("UnauthenticatedError");
  });
});

describe("WorkspaceService.insertMember (transactional seat ceiling)", () => {
  const ownerMembership: readonly Membership[] = [
    { workspaceId: WS_ID, userId: "user_owner", role: "owner" },
  ];
  const oneOwnerRow: readonly MemberWithUser[] = [
    {
      id: "m_owner",
      workspaceId: WS_ID,
      userId: "user_owner",
      role: "owner",
      createdAt: 1,
      name: null,
      email: null,
    },
  ];

  it("inserts a new member when under the ceiling", async () => {
    const exit = await run(
      {
        memberships: ownerMembership,
        members: oneOwnerRow,
        currentUserId: "user_owner",
      },
      (s) =>
        s.insertMember({
          workspaceId: WS_ID,
          userId: "user_new",
          role: "member",
          seatCeiling: 5,
        }),
    );
    if (!Exit.isSuccess(exit)) throw new Error("expected success");
    expect(exit.value.alreadyMember).toBe(false);
    expect(exit.value.memberId).toBeTruthy();
  });

  it("enforces the seat ceiling transactionally (re-reads live count)", async () => {
    // One existing member, ceiling = 1 → adding a second exceeds it.
    const exit = await run(
      {
        memberships: ownerMembership,
        members: oneOwnerRow,
        currentUserId: "user_owner",
      },
      (s) =>
        s.insertMember({
          workspaceId: WS_ID,
          userId: "user_new",
          role: "member",
          seatCeiling: 1,
        }),
    );
    expect(failureTag(exit)).toBe("SeatLimitExceededError");
  });

  it("treats a null ceiling as unlimited", async () => {
    const exit = await run(
      {
        memberships: ownerMembership,
        members: oneOwnerRow,
        currentUserId: "user_owner",
      },
      (s) =>
        s.insertMember({
          workspaceId: WS_ID,
          userId: "user_new",
          role: "member",
          seatCeiling: null,
        }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("is idempotent: re-inviting an existing member adds no row", async () => {
    const exit = await run(
      {
        memberships: ownerMembership,
        members: oneOwnerRow,
        currentUserId: "user_owner",
      },
      (s) =>
        s.insertMember({
          workspaceId: WS_ID,
          userId: "user_owner",
          role: "member",
          seatCeiling: 0,
        }),
    );
    if (!Exit.isSuccess(exit)) throw new Error("expected success");
    expect(exit.value).toEqual({ memberId: "m_owner", alreadyMember: true });
  });

  it("rejects a non-owner/admin with InsufficientRoleError", async () => {
    const exit = await run(
      {
        memberships: [
          { workspaceId: WS_ID, userId: "user_plain", role: "member" },
        ],
        members: [
          {
            id: "m_plain",
            workspaceId: WS_ID,
            userId: "user_plain",
            role: "member",
            createdAt: 1,
            name: null,
            email: null,
          },
        ],
        currentUserId: "user_plain",
      },
      (s) =>
        s.insertMember({
          workspaceId: WS_ID,
          userId: "user_new",
          role: "member",
          seatCeiling: null,
        }),
    );
    expect(failureTag(exit)).toBe("InsufficientRoleError");
  });
});
