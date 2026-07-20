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
import { PIPELINE_SCHEMA_VERSION, compilePipeline, type PipelineGraph } from "@gtmgrid/pipelines";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import { TestLayer, type TestLayerFixtures } from "../layers.js";
import type {
  PipelineBindingRecord,
  PipelineRecord,
  PipelineRunRecord,
  PipelineVersionRecord,
} from "../repositories/pipeline-repo.js";
import type { Workspace } from "../repositories/workspace-repo.js";
import { WorkspaceService } from "./workspace-service.js";
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

describe("WorkspaceService.deleteWorkspace", () => {
  // Minimal valid graph (input -> output) for the compiled version fixture.
  const pipeGraph: PipelineGraph = {
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    nodes: [
      { id: "input", type: "input", name: "Company", position: { x: 0, y: 0 }, config: { key: "company", required: true } },
      { id: "output", type: "output", name: "Result", position: { x: 200, y: 0 }, config: { key: "result" } },
    ],
    edges: [{ id: "e", source: "input", target: "output" }],
  };

  /** Run deleteWorkspace then probe `me()` for the caller's remaining workspaces. */
  const runDelete = (fixtures: TestLayerFixtures, workspaceId = WS_ID) =>
    Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* WorkspaceService;
        yield* svc.deleteWorkspace(workspaceId);
        return yield* svc.me();
      }).pipe(Effect.provide(TestLayer(fixtures))),
    );

  it("owner deletes the workspace — it vanishes from me() and the Autumn customer is deleted first", async () => {
    const deleteCalls: { customerId: string }[] = [];
    const exit = await runDelete({
      workspaces,
      memberships,
      currentUserId: "user_owner",
      autumn: { deleteCalls },
    });
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.workspaces).toEqual([]);
    }
    expect(deleteCalls).toEqual([{ customerId: WS_ID }]);
  });

  it("rejects a plain member with InsufficientRoleError and deletes nothing", async () => {
    const deleteCalls: { customerId: string }[] = [];
    const exit = await runDelete({
      workspaces,
      memberships,
      currentUserId: "user_member",
      autumn: { deleteCalls },
    });
    expect(failureTag(exit)).toBe("InsufficientRoleError");
    expect(deleteCalls).toEqual([]);
  });

  it("rejects a non-member with NotAMemberError", async () => {
    const exit = await runDelete({
      workspaces,
      memberships,
      currentUserId: "user_stranger",
    });
    expect(failureTag(exit)).toBe("NotAMemberError");
  });

  it("skips the Autumn delete on self-host but still deletes the workspace", async () => {
    const deleteCalls: { customerId: string }[] = [];
    process.env.GTMGRID_SELF_HOST = "1";
    try {
      const exit = await runDelete({
        workspaces,
        memberships,
        currentUserId: "user_owner",
        autumn: { deleteCalls },
      });
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.workspaces).toEqual([]);
      }
      expect(deleteCalls).toEqual([]);
    } finally {
      delete process.env.GTMGRID_SELF_HOST;
    }
  });

  it("purges the RESTRICTed pipeline dependants before the workspace cascade", async () => {
    const compiled = compilePipeline(pipeGraph);
    const snapshot = {
      graphHash: compiled.graphHash,
      topologicalNodeIds: compiled.topologicalNodeIds,
      capabilities: compiled.capabilities,
      actionEstimate: compiled.actionEstimate,
    };
    const pipelines: PipelineRecord[] = [
      { id: "pipe1", workspaceId: WS_ID, projectId: "p1", name: "Pipe", description: null, archived: false, createdBy: "user_owner", createdAt: 1, updatedAt: 1 },
    ];
    const pipelineVersions: PipelineVersionRecord[] = [
      { id: "v1", workspaceId: WS_ID, pipelineId: "pipe1", version: 1, status: "deployed", graph: pipeGraph, compiledPlan: snapshot, graphHash: compiled.graphHash, createdBy: "user_owner", createdAt: 1, deployedAt: 2 },
    ];
    const pipelineBindings: PipelineBindingRecord[] = [
      { id: "b1", workspaceId: WS_ID, pipelineId: "pipe1", versionId: "v1", tableId: "t1", inputMapping: {}, outputMapping: {}, executionTarget: "cloud", autoRun: false, enabled: true, createdAt: 1, updatedAt: 1 },
    ];
    const pipelineRuns: PipelineRunRecord[] = [
      { id: "run1", workspaceId: WS_ID, pipelineId: "pipe1", versionId: "v1", bindingId: "b1", tableId: "t1", executionTarget: "cloud", status: "succeeded", trigger: "manual", selection: null, requestedBy: null, totalRecords: 0, estimatedActions: 0, consumedActions: 0, processedRecords: 0, succeededRecords: 0, failedRecords: 0, skippedRecords: 0, firstError: null, startedAt: null, finishedAt: null, createdAt: 1 },
    ];
    const exit = await runDelete({
      workspaces,
      memberships,
      currentUserId: "user_owner",
      pipelines,
      pipelineVersions,
      pipelineBindings,
      pipelineRuns,
    });
    expect(Exit.isSuccess(exit)).toBe(true);
    // The RESTRICT offenders (versions/bindings/runs) are purged by the
    // service; the `pipelines` row itself is dropped by the real Postgres
    // workspace cascade, which the in-memory TestLayer does not model.
    expect(pipelineVersions).toHaveLength(0);
    expect(pipelineBindings).toHaveLength(0);
    expect(pipelineRuns).toHaveLength(0);
  });
});
