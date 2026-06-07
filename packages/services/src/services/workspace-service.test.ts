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
