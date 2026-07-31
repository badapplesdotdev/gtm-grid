/**
 * Tests for the worked-example {@link WorkspaceService.getWorkspace}, exercised
 * entirely against the in-memory {@link TestLayer} — NO live database.
 *
 * Outcome-focused per docs/effect-conventions.md: assert the returned workspace
 * or the typed error `_tag` via `Effect.runPromiseExit` + `Cause.failureOption`.
 * Covers the AC paths: member reads it, non-member is rejected, unauthenticated
 * is rejected, missing workspace 404s, and a role guard enforces the role — all
 * by swapping fixtures into the same Test Layer.
 */

import type { Membership } from "@gtmgrid/cloud";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import { TestLayer, type TestLayerFixtures } from "../layers.js";
import type { Workspace } from "../repositories/workspace-repo.js";
import { WorkspaceService } from "./workspace-service.js";

const WS_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_WS_ID = "22222222-2222-2222-2222-222222222222";

const workspaces: readonly Workspace[] = [
  { id: WS_ID, name: "Alpha", ownerId: "user_owner" },
];

const memberships: readonly Membership[] = [
  { workspaceId: WS_ID, userId: "user_owner", role: "owner" },
  { workspaceId: WS_ID, userId: "user_member", role: "member" },
];

/** Run `getWorkspace(WS_ID)` against a Test Layer built from `fixtures`. */
const runGet = (fixtures: TestLayerFixtures, workspaceId = WS_ID) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const svc = yield* WorkspaceService;
      return yield* svc.getWorkspace(workspaceId);
    }).pipe(Effect.provide(TestLayer(fixtures))),
  );

/** Pull the typed failure tag out of a failed exit. */
const failureTag = <A, E>(exit: Exit.Exit<A, E>): string | undefined => {
  if (Exit.isSuccess(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure)
    ? (failure.value as { _tag?: string })._tag
    : undefined;
};

describe("WorkspaceService.getWorkspace", () => {
  it("returns the workspace for a member", async () => {
    const exit = await runGet({
      workspaces,
      memberships,
      currentUserId: "user_member",
    });
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual({
        id: WS_ID,
        name: "Alpha",
        ownerId: "user_owner",
      });
    }
  });

  it("rejects a non-member with NotAMemberError", async () => {
    const exit = await runGet({
      workspaces,
      memberships,
      currentUserId: "user_stranger",
    });
    expect(failureTag(exit)).toBe("NotAMemberError");
  });

  it("rejects an unauthenticated caller with UnauthenticatedError", async () => {
    const exit = await runGet({
      workspaces,
      memberships,
      currentUserId: null,
    });
    expect(failureTag(exit)).toBe("UnauthenticatedError");
  });

  it("404s when the workspace does not exist for a member", async () => {
    const exit = await runGet(
      {
        workspaces: [],
        memberships: [
          { workspaceId: OTHER_WS_ID, userId: "user_member", role: "member" },
        ],
        currentUserId: "user_member",
      },
      OTHER_WS_ID,
    );
    expect(failureTag(exit)).toBe("WorkspaceNotFoundError");
  });
});

describe("WorkspaceService.requireWorkspaceRole", () => {
  const runRole = (
    fixtures: TestLayerFixtures,
    roles: readonly ("owner" | "admin" | "member")[],
  ) =>
    Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* WorkspaceService;
        return yield* svc.requireWorkspaceRole(WS_ID, roles);
      }).pipe(Effect.provide(TestLayer(fixtures))),
    );

  it("returns the membership when the role is satisfied", async () => {
    const exit = await runRole(
      { memberships, currentUserId: "user_owner" },
      ["owner"],
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.role).toBe("owner");
  });

  it("rejects with InsufficientRoleError when the role is too low", async () => {
    const exit = await runRole(
      { memberships, currentUserId: "user_member" },
      ["owner", "admin"],
    );
    expect(failureTag(exit)).toBe("InsufficientRoleError");
  });
});

describe("WorkspaceService.updateMemberRole", () => {
  const ADMIN_MEMBERSHIPS: readonly Membership[] = [
    ...memberships,
    { workspaceId: WS_ID, userId: "user_admin", role: "admin" },
  ];

  /**
   * Run `updateMemberRole` and then read back the roster + the workspace row, so
   * every assertion is about OUTCOME (who holds which role, who owns the
   * workspace) rather than which repo call was made.
   */
  const runUpdate = (
    fixtures: TestLayerFixtures,
    args: {
      readonly userId: string;
      readonly role: "owner" | "admin" | "member";
    },
  ) =>
    Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* WorkspaceService;
        yield* svc.updateMemberRole({ workspaceId: WS_ID, ...args });
        const roster = yield* svc.listMembers(WS_ID);
        const workspace = yield* svc.getWorkspace(WS_ID);
        return {
          roles: new Map(roster.members.map((m) => [m.userId, m.role])),
          ownerId: workspace.ownerId,
        };
      }).pipe(Effect.provide(TestLayer(fixtures))),
    );

  it("lets the owner promote a member to admin", async () => {
    const exit = await runUpdate(
      { workspaces, memberships, currentUserId: "user_owner" },
      { userId: "user_member", role: "admin" },
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.roles.get("user_member")).toBe("admin");
      expect(exit.value.roles.get("user_owner")).toBe("owner");
      expect(exit.value.ownerId).toBe("user_owner");
    }
  });

  it("lets the owner demote an admin back to member", async () => {
    const exit = await runUpdate(
      {
        workspaces,
        memberships: ADMIN_MEMBERSHIPS,
        currentUserId: "user_owner",
      },
      { userId: "user_admin", role: "member" },
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.roles.get("user_admin")).toBe("member");
    }
  });

  it("transfers ownership: the target owns it, the caller becomes admin", async () => {
    const exit = await runUpdate(
      { workspaces, memberships, currentUserId: "user_owner" },
      { userId: "user_member", role: "owner" },
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.roles.get("user_member")).toBe("owner");
      expect(exit.value.roles.get("user_owner")).toBe("admin");
      // The workspace row follows the new owner — billing contact and the
      // owner-only actions must not be left pointing at the previous owner.
      expect(exit.value.ownerId).toBe("user_member");
    }
  });

  it("leaves exactly one owner after a transfer", async () => {
    const exit = await runUpdate(
      {
        workspaces,
        memberships: ADMIN_MEMBERSHIPS,
        currentUserId: "user_owner",
      },
      { userId: "user_admin", role: "owner" },
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      const owners = [...exit.value.roles.values()].filter(
        (r) => r === "owner",
      );
      expect(owners).toEqual(["owner"]);
    }
  });

  it("rejects an admin trying to promote someone with InsufficientRoleError", async () => {
    const exit = await runUpdate(
      {
        workspaces,
        memberships: ADMIN_MEMBERSHIPS,
        currentUserId: "user_admin",
      },
      { userId: "user_member", role: "admin" },
    );
    expect(failureTag(exit)).toBe("InsufficientRoleError");
  });

  it("rejects a plain member trying to promote themselves", async () => {
    const exit = await runUpdate(
      { workspaces, memberships, currentUserId: "user_member" },
      { userId: "user_member", role: "owner" },
    );
    expect(failureTag(exit)).toBe("InsufficientRoleError");
  });

  it("rejects a non-member caller with NotAMemberError", async () => {
    const exit = await runUpdate(
      { workspaces, memberships, currentUserId: "user_stranger" },
      { userId: "user_member", role: "admin" },
    );
    expect(failureTag(exit)).toBe("NotAMemberError");
  });

  it("rejects an unauthenticated caller with UnauthenticatedError", async () => {
    const exit = await runUpdate(
      { workspaces, memberships, currentUserId: null },
      { userId: "user_member", role: "admin" },
    );
    expect(failureTag(exit)).toBe("UnauthenticatedError");
  });

  it("404s when the target is not a member of the workspace", async () => {
    const exit = await runUpdate(
      { workspaces, memberships, currentUserId: "user_owner" },
      { userId: "user_stranger", role: "admin" },
    );
    expect(failureTag(exit)).toBe("MemberNotFoundError");
  });

  it("refuses to let the owner demote themselves (LastOwnerError)", async () => {
    const exit = await runUpdate(
      { workspaces, memberships, currentUserId: "user_owner" },
      { userId: "user_owner", role: "admin" },
    );
    expect(failureTag(exit)).toBe("LastOwnerError");
  });

  it("is a no-op when the member already holds the role", async () => {
    const exit = await runUpdate(
      { workspaces, memberships, currentUserId: "user_owner" },
      { userId: "user_member", role: "member" },
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.roles.get("user_member")).toBe("member");
      expect(exit.value.ownerId).toBe("user_owner");
    }
  });

  it("treats the owner re-asserting their own role as a no-op, not LastOwnerError", async () => {
    const exit = await runUpdate(
      { workspaces, memberships, currentUserId: "user_owner" },
      { userId: "user_owner", role: "owner" },
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.roles.get("user_owner")).toBe("owner");
    }
  });
});
