/**
 * Procedure tests via `createCaller`, run OFFLINE against a `TestLayer` context.
 *
 * Proves the Effect-DI seam end-to-end at the procedure level:
 *   - `health` returns ok with no auth/DB.
 *   - `workspace.get` returns the workspace for a member (a real procedure
 *     resolving `WorkspaceService` from the runtime and running an Effect).
 *   - `workspace.get` rejects a non-member with FORBIDDEN (the `workspaceProcedure`
 *     membership assertion) and an unauthenticated caller with UNAUTHORIZED.
 *
 * Swapping `TestLayer` fixtures changes behaviour with no live database — the
 * acceptance criterion this file verifies.
 */

import type { Membership } from "@gtmgrid/services";
import { TestLayer, type TestLayerFixtures } from "@gtmgrid/services";
import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { createTestContext } from "./context";
import { appRouter } from "./root";
import { createCallerFactory } from "./trpc";

const createCaller = createCallerFactory(appRouter);

const WS_ID = "11111111-1111-1111-1111-111111111111";

const workspaces = [{ id: WS_ID, name: "Alpha", ownerId: "user_owner" }];
const memberships: readonly Membership[] = [
  { workspaceId: WS_ID, userId: "user_member", role: "member" },
];

/** A caller whose context uses a `TestLayer` built from `fixtures`. */
const callerFor = (fixtures: TestLayerFixtures) =>
  createCaller(
    createTestContext({
      layer: TestLayer(fixtures),
      userId: fixtures.currentUserId ?? null,
    }),
  );

describe("appRouter.health", () => {
  it("returns ok without auth or DB", async () => {
    const caller = callerFor({});
    const result = await caller.health();
    expect(result.status).toBe("ok");
  });
});

describe("appRouter.workspace.get", () => {
  it("returns the workspace for a member", async () => {
    const caller = callerFor({
      workspaces,
      memberships,
      currentUserId: "user_member",
    });
    const ws = await caller.workspace.get({ workspaceId: WS_ID });
    expect(ws).toEqual({ id: WS_ID, name: "Alpha", ownerId: "user_owner" });
  });

  it("rejects a non-member with FORBIDDEN", async () => {
    const caller = callerFor({
      workspaces,
      memberships,
      currentUserId: "user_stranger",
    });
    await expect(
      caller.workspace.get({ workspaceId: WS_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects an unauthenticated caller with UNAUTHORIZED", async () => {
    const caller = callerFor({
      workspaces,
      memberships,
      currentUserId: null,
    });
    await expect(
      caller.workspace.get({ workspaceId: WS_ID }),
    ).rejects.toBeInstanceOf(TRPCError);
    await expect(
      caller.workspace.get({ workspaceId: WS_ID }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
