import { identityLayer, memberRepoLayer, MembershipService } from "@gtmgrid/cloud";
import { PIPELINE_RESULT_OUTPUT_KEY, PIPELINE_SCHEMA_VERSION, compilePipeline, type PipelineGraph } from "@gtmgrid/pipelines";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { makeGridStore } from "../repositories/grid-store.js";
import { pipelineRepoLayer, type PipelineBindingRecord, type PipelineRecord, type PipelineVersionRecord } from "../repositories/pipeline-repo.js";
import { projectRepoLayer } from "../repositories/project-repo.js";
import { PipelineService } from "./pipeline-service.js";
import { recordingRealtimePublisherLayer, type RecordedGridEvent } from "./realtime-publisher.js";

const WS = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const USER = "user-1";

const baseGraph: PipelineGraph = {
  schemaVersion: PIPELINE_SCHEMA_VERSION,
  nodes: [
    { id: "input", type: "input", name: "Company", position: { x: 0, y: 0 }, config: { key: "company", required: true } },
    { id: "formula", type: "formula", name: "Normalize", position: { x: 200, y: 0 }, config: { expression: "company" } },
    { id: "output", type: "output", name: "Result", position: { x: 400, y: 0 }, config: { key: "result" } },
  ],
  edges: [
    { id: "one", source: "input", target: "formula" },
    { id: "two", source: "formula", target: "output" },
  ],
};

const makeLayer = (fixtures: { pipelines?: PipelineRecord[]; versions?: PipelineVersionRecord[]; bindings?: PipelineBindingRecord[]; quotas?: Map<string, { used: number; limit: number | null }>; receipts?: Set<string>; realtimeEvents?: RecordedGridEvent[] } = {}) => {
  const projects = projectRepoLayer(makeGridStore({ projects: [{ id: PROJECT, workspaceId: WS, name: "GTM", createdAt: 1 }] }));
  const repo = pipelineRepoLayer({ pipelines: fixtures.pipelines, versions: fixtures.versions, bindings: fixtures.bindings, cloudActions: fixtures.quotas, actionReceipts: fixtures.receipts });
  const membership = MembershipService.Default.pipe(
    Layer.provide(identityLayer(USER)),
    Layer.provide(memberRepoLayer([{ workspaceId: WS, userId: USER, role: "owner" }])),
  );
  return PipelineService.Default.pipe(Layer.provide(repo), Layer.provide(projects), Layer.provide(membership), Layer.provide(identityLayer(USER)), Layer.provide(recordingRealtimePublisherLayer(fixtures.realtimeEvents)));
};

describe("PipelineService", () => {
  it("deletes a pipeline and removes it from the project", async () => {
    const program = Effect.gen(function* () {
      const service = yield* PipelineService;
      const created = yield* service.create({ projectId: PROJECT, name: "Temporary automation", graph: baseGraph });
      const removed = yield* service.remove(created.pipeline.id);
      const list = yield* service.list(PROJECT);
      const detail = yield* Effect.either(service.get(created.pipeline.id));
      return { created, removed, list, detail };
    });
    const result = await Effect.runPromise(program.pipe(Effect.provide(makeLayer())));
    expect(result.removed).toEqual({ id: result.created.pipeline.id, projectId: PROJECT });
    expect(result.list).toEqual([]);
    expect(result.detail._tag).toBe("Left");
  });

  it("creates, patches and deploys an immutable version", async () => {
    const program = Effect.gen(function* () {
      const service = yield* PipelineService;
      const created = yield* service.create({ projectId: PROJECT, name: "Research companies", graph: baseGraph });
      const patched = yield* service.patchDraft(created.pipeline.id, [{ op: "update_node", nodeId: "formula", patch: { name: "Normalize company" } }]);
      const deployed = yield* service.deploy(created.pipeline.id);
      const detail = yield* service.get(created.pipeline.id);
      return { created, patched, deployed, detail };
    });
    const result = await Effect.runPromise(program.pipe(Effect.provide(makeLayer())));
    expect(result.created.version.status).toBe("draft");
    expect(result.patched.graph.nodes.find((node) => node.id === "formula")?.name).toBe("Normalize company");
    expect(result.deployed.status).toBe("deployed");
    expect(result.detail.draft).toBeNull();
    expect(result.detail.deployed?.graphHash).toBe(result.patched.graphHash);
  });

  it("advances existing table attachments to the newly deployed version", async () => {
    const compiled = compilePipeline(baseGraph);
    const snapshot = { graphHash: compiled.graphHash, topologicalNodeIds: compiled.topologicalNodeIds, capabilities: compiled.capabilities, actionEstimate: compiled.actionEstimate };
    const pipeline: PipelineRecord = { id: "p", workspaceId: WS, projectId: PROJECT, name: "P", description: null, archived: false, createdBy: USER, createdAt: 1, updatedAt: 1 };
    const versions: PipelineVersionRecord[] = [
      { id: "v1", workspaceId: WS, pipelineId: "p", version: 1, status: "deployed", graph: baseGraph, compiledPlan: snapshot, graphHash: compiled.graphHash, createdBy: USER, createdAt: 1, deployedAt: 2 },
      { id: "v2", workspaceId: WS, pipelineId: "p", version: 2, status: "draft", graph: baseGraph, compiledPlan: snapshot, graphHash: compiled.graphHash, createdBy: USER, createdAt: 3, deployedAt: null },
    ];
    const binding: PipelineBindingRecord = { id: "binding", workspaceId: WS, pipelineId: "p", versionId: "v1", tableId: "table", inputMapping: { company: "company-column" }, outputMapping: { [PIPELINE_RESULT_OUTPUT_KEY]: "pipeline-column" }, executionTarget: "cloud", autoRun: true, enabled: true, createdAt: 2, updatedAt: 2 };
    const program = Effect.gen(function* () {
      const service = yield* PipelineService;
      const deployed = yield* service.deploy("p");
      const detail = yield* service.get("p");
      return { deployed, detail };
    });
    const result = await Effect.runPromise(program.pipe(Effect.provide(makeLayer({ pipelines: [pipeline], versions, bindings: [binding] }))));
    expect(result.deployed.id).toBe("v2");
    expect(result.detail.bindings).toHaveLength(1);
    expect(result.detail.bindings[0]?.versionId).toBe("v2");
  });

  it("uses the latest deployed version when an older attachment triggers", async () => {
    const compiled = compilePipeline(baseGraph);
    const snapshot = { graphHash: compiled.graphHash, topologicalNodeIds: compiled.topologicalNodeIds, capabilities: compiled.capabilities, actionEstimate: compiled.actionEstimate };
    const pipeline: PipelineRecord = { id: "p", workspaceId: WS, projectId: PROJECT, name: "P", description: null, archived: false, createdBy: USER, createdAt: 1, updatedAt: 1 };
    const versions: PipelineVersionRecord[] = [
      { id: "old", workspaceId: WS, pipelineId: "p", version: 1, status: "superseded", graph: baseGraph, compiledPlan: snapshot, graphHash: compiled.graphHash, createdBy: USER, createdAt: 1, deployedAt: 2 },
      { id: "current", workspaceId: WS, pipelineId: "p", version: 2, status: "deployed", graph: baseGraph, compiledPlan: snapshot, graphHash: compiled.graphHash, createdBy: USER, createdAt: 3, deployedAt: 4 },
    ];
    const binding: PipelineBindingRecord = { id: "binding", workspaceId: WS, pipelineId: "p", versionId: "old", tableId: "table", inputMapping: { company: "company-column" }, outputMapping: { [PIPELINE_RESULT_OUTPUT_KEY]: "pipeline-column" }, executionTarget: "cloud", autoRun: true, enabled: true, createdAt: 2, updatedAt: 2 };
    const program = Effect.gen(function* () {
      const service = yield* PipelineService;
      return yield* service.createTriggeredRuns({ columnId: "company-column", rowIds: ["row"], trigger: "row_updated" });
    });
    const result = await Effect.runPromise(program.pipe(Effect.provide(makeLayer({ pipelines: [pipeline], versions, bindings: [binding] }))));
    expect(result).toHaveLength(1);
    expect(result[0]?.versionId).toBe("current");
  });

  it("saves incomplete draft fields but blocks deployment", async () => {
    const program = Effect.gen(function* () {
      const service = yield* PipelineService;
      const created = yield* service.create({ projectId: PROJECT, name: "Draft placeholders", graph: baseGraph });
      const patched = yield* service.patchDraft(created.pipeline.id, [{ op: "update_node", nodeId: "formula", patch: { config: { expression: "" } } }]);
      const deployed = yield* Effect.either(service.deploy(created.pipeline.id));
      return { patched, deployed };
    });
    const result = await Effect.runPromise(program.pipe(Effect.provide(makeLayer())));
    expect(result.patched.graph.nodes.find((node) => node.id === "formula")).toMatchObject({ config: { expression: "" } });
    expect(result.deployed._tag).toBe("Left");
  });

  it("consumes a cloud action exactly once and enforces quota", async () => {
    const quotas = new Map([[WS, { used: 0, limit: 1 }]]);
    const receipts = new Set<string>();
    const pipelines: PipelineRecord[] = [{ id: "p", workspaceId: WS, projectId: PROJECT, name: "P", description: null, archived: false, createdBy: USER, createdAt: 1, updatedAt: 1 }];
    const program = Effect.gen(function* () {
      const service = yield* PipelineService;
      const one = yield* service.consumeAction({ workspaceId: WS, runId: "run", receiptKey: "receipt", rowId: "33333333-3333-4333-8333-333333333333", nodeId: "node" });
      const duplicate = yield* service.consumeAction({ workspaceId: WS, runId: "run", receiptKey: "receipt", rowId: "33333333-3333-4333-8333-333333333333", nodeId: "node" });
      const over = yield* Effect.either(service.consumeAction({ workspaceId: WS, runId: "run", receiptKey: "second", rowId: "44444444-4444-4444-8444-444444444444", nodeId: "node" }));
      return { one, duplicate, over };
    });
    const result = await Effect.runPromise(program.pipe(Effect.provide(makeLayer({ pipelines, quotas, receipts }))));
    expect(result.one).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.over._tag).toBe("Left");
    expect(quotas.get(WS)?.used).toBe(1);
    expect(receipts.size).toBe(1);
  });

  it("runs one attached draft record for testing without deploying it", async () => {
    const pipeline: PipelineRecord = { id: "p", workspaceId: WS, projectId: PROJECT, name: "P", description: null, archived: false, createdBy: USER, createdAt: 1, updatedAt: 1 };
    const compiled = compilePipeline(baseGraph);
    const snapshot = { graphHash: compiled.graphHash, topologicalNodeIds: compiled.topologicalNodeIds, capabilities: compiled.capabilities, actionEstimate: compiled.actionEstimate };
    const versions: PipelineVersionRecord[] = [
      { id: "deployed", workspaceId: WS, pipelineId: "p", version: 1, status: "superseded", graph: baseGraph, compiledPlan: snapshot, graphHash: compiled.graphHash, createdBy: USER, createdAt: 1, deployedAt: 2 },
      { id: "draft", workspaceId: WS, pipelineId: "p", version: 2, status: "draft", graph: baseGraph, compiledPlan: snapshot, graphHash: compiled.graphHash, createdBy: USER, createdAt: 3, deployedAt: null },
    ];
    const binding: PipelineBindingRecord = { id: "binding", workspaceId: WS, pipelineId: "p", versionId: "deployed", tableId: "table", inputMapping: { company: "company-column" }, outputMapping: { [PIPELINE_RESULT_OUTPUT_KEY]: "pipeline-column" }, executionTarget: "cloud", autoRun: false, enabled: true, createdAt: 2, updatedAt: 2 };
    const realtimeEvents: RecordedGridEvent[] = [];
    const program = Effect.gen(function* () {
      const service = yield* PipelineService;
      const testRun = yield* service.createRun({ pipelineId: "p", versionId: "draft", bindingId: "binding", tableId: "table", executionTarget: "cloud", trigger: "manual", selection: { rowIds: ["row"] }, totalRecords: 1 });
      const bulkDraft = yield* Effect.either(service.createRun({ pipelineId: "p", versionId: "draft", bindingId: "binding", tableId: "table", executionTarget: "cloud", trigger: "manual", selection: {}, totalRecords: 2 }));
      const triggered = yield* service.createTriggeredRuns({ columnId: "company-column", rowIds: ["new-row"], trigger: "row_updated" });
      const unrelated = yield* service.createTriggeredRuns({ columnId: "other-column", rowIds: ["new-row"], trigger: "row_updated" });
      return { testRun, bulkDraft, triggered, unrelated };
    });
    const result = await Effect.runPromise(program.pipe(Effect.provide(makeLayer({ pipelines: [pipeline], versions, bindings: [binding], realtimeEvents }))));
    expect(result.testRun.versionId).toBe("draft");
    expect(result.testRun.totalRecords).toBe(1);
    expect(result.bulkDraft._tag).toBe("Left");
    expect(result.triggered).toHaveLength(1);
    expect(result.triggered[0]).toMatchObject({ versionId: "deployed", trigger: "row_updated", selection: { rowIds: ["new-row"] } });
    expect(result.unrelated).toEqual([]);
    expect(realtimeEvents).toContainEqual(expect.objectContaining({ tableId: "table", event: expect.objectContaining({ type: "cell.upsert", cell: expect.objectContaining({ rowId: "new-row", columnId: "pipeline-column", status: "pending" }) }) }));
  });
});
