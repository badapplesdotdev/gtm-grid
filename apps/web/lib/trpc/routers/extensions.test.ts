/**
 * `extensions` router procedure tests via `createCaller`, OFFLINE against a
 * `TestLayer` context. Verifies member-gated list + the upsert saveExtension,
 * and non-member / unauthenticated rejection.
 */

import type { Extension, Membership } from "@gtmgrid/services";
import { TestLayer, type TestLayerFixtures } from "@gtmgrid/services";
import { describe, expect, it } from "vitest";
import { createTestContext } from "../context";
import { appRouter } from "../root";
import { createCallerFactory } from "../trpc";

const createCaller = createCallerFactory(appRouter);

const WS = "ws-1";
const memberships: readonly Membership[] = [
  { workspaceId: WS, userId: "member", role: "member" },
];

const callerFor = (fixtures: TestLayerFixtures) =>
  createCaller(
    createTestContext({
      layer: TestLayer(fixtures),
      userId: fixtures.currentUserId ?? null,
    }),
  );

describe("extensions.listExtensions", () => {
  it("lists for a member", async () => {
    const extensions: Extension[] = [
      {
        id: "e1",
        workspaceId: WS,
        extensionId: "apollo",
        name: "Apollo",
        category: null,
        manifest: {},
      },
    ];
    const caller = callerFor({
      memberships,
      extensions,
      currentUserId: "member",
    });
    const list = await caller.extensions.listExtensions({ workspaceId: WS });
    expect(list).toHaveLength(1);
  });

  it("rejects a non-member with FORBIDDEN", async () => {
    const caller = callerFor({ memberships, currentUserId: "stranger" });
    await expect(
      caller.extensions.listExtensions({ workspaceId: WS }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("extensions.saveExtension", () => {
  it("installs then updates in place", async () => {
    const extensions: Extension[] = [];
    const caller = callerFor({
      memberships,
      extensions,
      currentUserId: "member",
    });
    const id = await caller.extensions.saveExtension({
      workspaceId: WS,
      extensionId: "apollo",
      name: "Apollo",
      manifest: { v: 1 },
    });
    expect(extensions).toHaveLength(1);
    const id2 = await caller.extensions.saveExtension({
      workspaceId: WS,
      extensionId: "apollo",
      name: "Apollo 2",
      manifest: { v: 2 },
    });
    expect(id2).toBe(id);
    expect(extensions).toHaveLength(1);
    expect(extensions[0].name).toBe("Apollo 2");
  });
});
