import { Identity, MembershipService } from "@gtmgrid/cloud";
import {
  PIPELINE_SCHEMA_VERSION,
  PipelineCompileError,
  PipelinePatchError,
  applyPipelineGraphPatches,
  chunkPipelineSelection,
  compilePipeline,
  PIPELINE_RESULT_OUTPUT_KEY,
  pipelineGraphSchema,
  pipelineConfigurationIssues,
  pipelineTerminalOutputs,
  type PipelineExecutionTarget,
  type PipelineGraph,
  type PipelineGraphPatch,
} from "@gtmgrid/pipelines";
import { Data, Effect, Option } from "effect";
import { ProjectRepo } from "../repositories/project-repo.js";
import {
  PipelineRepo,
  type PipelineBindingRecord,
  type PipelineVersionRecord,
} from "../repositories/pipeline-repo.js";
import { RealtimePublisher } from "./realtime-publisher.js";
import { reconstructPipelineNodeInputs } from "../pipeline-run-details.js";

export class PipelineNotFoundError extends Data.TaggedError("PipelineNotFoundError")<{
  readonly message: string;
}> {}

export class PipelineInvalidGraphError extends Data.TaggedError("PipelineInvalidGraphError")<{
  readonly message: string;
  readonly issues: readonly string[];
}> {}

export class PipelineBindingError extends Data.TaggedError("PipelineBindingError")<{
  readonly message: string;
}> {}

const snapshot = (compiled: ReturnType<typeof compilePipeline>) => ({
  graphHash: compiled.graphHash,
  topologicalNodeIds: compiled.topologicalNodeIds,
  capabilities: compiled.capabilities,
  actionEstimate: compiled.actionEstimate,
});

const compileOrFail = (graph: PipelineGraph) =>
  Effect.try({
    try: () => compilePipeline(graph),
    catch: (error) =>
      new PipelineInvalidGraphError({
        message: "The pipeline graph is invalid.",
        issues:
          error instanceof PipelineCompileError || error instanceof PipelinePatchError
            ? (error.issues.length > 0 ? error.issues : [{ message: error.message }]).map((issue) => issue.message)
            : [error instanceof Error ? error.message : String(error)],
      }),
  });

export class PipelineService extends Effect.Service<PipelineService>()(
  "PipelineService",
  {
    effect: Effect.gen(function* () {
      const repo = yield* PipelineRepo;
      const realtime = yield* RealtimePublisher;
      const projects = yield* ProjectRepo;
      const membership = yield* MembershipService;
      const identity = yield* Identity;

      const requirePipeline = (pipelineId: string) =>
        Effect.gen(function* () {
          const found = yield* repo.findPipeline(pipelineId);
          if (Option.isNone(found)) return yield* Effect.fail(new PipelineNotFoundError({ message: `Pipeline ${pipelineId} not found.` }));
          yield* membership.requireMember(found.value.workspaceId);
          return found.value;
        });

      const create = (input: {
        readonly projectId: string;
        readonly name: string;
        readonly description?: string | null;
        readonly graph?: PipelineGraph;
      }) => Effect.gen(function* () {
        const project = yield* projects.findById(input.projectId);
        if (Option.isNone(project)) return yield* Effect.fail(new PipelineNotFoundError({ message: `Project ${input.projectId} not found.` }));
        const member = yield* membership.requireMember(project.value.workspaceId);
        const graph = input.graph ?? {
          schemaVersion: PIPELINE_SCHEMA_VERSION,
          nodes: [
            { id: "input", type: "input", name: "Record", position: { x: 80, y: 180 }, config: { key: "record", required: true } },
          ],
          edges: [],
        } satisfies PipelineGraph;
        const compiled = yield* compileOrFail(graph);
        return yield* repo.createWithDraft({
          workspaceId: project.value.workspaceId,
          projectId: project.value.id,
          name: input.name.trim(),
          description: input.description ?? null,
          graph,
          compiledPlan: snapshot(compiled),
          graphHash: compiled.graphHash,
          createdBy: member.userId,
          now: Date.now(),
        });
      });

      const list = (projectId: string) => Effect.gen(function* () {
        const project = yield* projects.findById(projectId);
        if (Option.isNone(project)) return yield* Effect.fail(new PipelineNotFoundError({ message: `Project ${projectId} not found.` }));
        yield* membership.requireMember(project.value.workspaceId);
        return yield* repo.listByProject(projectId);
      });

      const get = (pipelineId: string) => Effect.gen(function* () {
        const pipeline = yield* requirePipeline(pipelineId);
        const [draft, deployed, bindings] = yield* Effect.all([
          repo.latestVersion(pipelineId, "draft"),
          repo.latestVersion(pipelineId, "deployed"),
          repo.listBindings(pipelineId),
        ]);
        return { pipeline, draft: Option.getOrNull(draft), deployed: Option.getOrNull(deployed), bindings };
      });

      const remove = (pipelineId: string) => Effect.gen(function* () {
        const pipeline = yield* requirePipeline(pipelineId);
        yield* repo.deletePipeline(pipelineId);
        return { id: pipeline.id, projectId: pipeline.projectId } as const;
      });

      const patchDraft = (pipelineId: string, patches: readonly PipelineGraphPatch[]) => Effect.gen(function* () {
        yield* requirePipeline(pipelineId);
        const memberId = Option.getOrNull(yield* identity.currentUserId);
        const existingDraft = yield* repo.latestVersion(pipelineId, "draft");
        let draft: PipelineVersionRecord;
        if (Option.isNone(existingDraft)) {
          const deployed = yield* repo.latestVersion(pipelineId, "deployed");
          if (Option.isNone(deployed)) return yield* Effect.fail(new PipelineNotFoundError({ message: "This pipeline has no draft or deployed version." }));
          draft = yield* repo.createDraftFrom({ source: deployed.value, createdBy: memberId, now: Date.now() });
        } else {
          draft = existingDraft.value;
        }
        const graph = yield* Effect.try({
          try: () => applyPipelineGraphPatches(draft.graph, patches),
          catch: (error) => new PipelineInvalidGraphError({
            message: "The graph patch would create an invalid pipeline.",
            issues: error instanceof PipelinePatchError ? (error.issues.length > 0 ? error.issues.map((issue) => issue.message) : [error.message]) : [String(error)],
          }),
        });
        const compiled = yield* compileOrFail(graph);
        return yield* repo.updateDraft({ versionId: draft.id, pipelineId, graph, compiledPlan: snapshot(compiled), graphHash: compiled.graphHash, now: Date.now() });
      });

      const deploy = (pipelineId: string) => Effect.gen(function* () {
        yield* requirePipeline(pipelineId);
        const draft = yield* repo.latestVersion(pipelineId, "draft");
        if (Option.isNone(draft)) return yield* Effect.fail(new PipelineNotFoundError({ message: "This pipeline has no draft to deploy." }));
        const incomplete = pipelineConfigurationIssues(draft.value.graph);
        if (incomplete.length > 0) return yield* Effect.fail(new PipelineInvalidGraphError({ message: "Finish configuring the pipeline before deploying it.", issues: incomplete }));
        yield* compileOrFail(draft.value.graph);
        return yield* repo.deployDraft(pipelineId, draft.value.id, Date.now());
      });

      const attach = (input: {
        readonly pipelineId: string;
        readonly versionId: string;
        readonly tableId: string;
        readonly inputMapping: Readonly<Record<string, string>>;
        readonly outputMapping: Readonly<Record<string, string>>;
        readonly executionTarget: PipelineExecutionTarget;
        readonly autoRun?: boolean;
      }): Effect.Effect<PipelineBindingRecord, unknown> => Effect.gen(function* () {
        const pipeline = yield* requirePipeline(input.pipelineId);
        const tableWorkspace = yield* repo.tableWorkspace(input.tableId);
        if (Option.isNone(tableWorkspace) || tableWorkspace.value !== pipeline.workspaceId) {
          return yield* Effect.fail(new PipelineBindingError({ message: "The table and pipeline must belong to the same workspace." }));
        }
        const version = yield* repo.findVersion(input.versionId);
        if (Option.isNone(version) || version.value.pipelineId !== input.pipelineId || version.value.status !== "deployed") {
          return yield* Effect.fail(new PipelineBindingError({ message: "Table bindings must reference a deployed version of this pipeline." }));
        }
        const parsed = pipelineGraphSchema.parse(version.value.graph);
        const compiled = yield* compileOrFail(parsed);
        if (input.executionTarget === "cloud" && !compiled.capabilities.cloud) {
          return yield* Effect.fail(new PipelineBindingError({ message: `This pipeline cannot run in the cloud: ${compiled.capabilities.reasons.join(" ")}` }));
        }
        const requiredInputs = parsed.nodes.flatMap((node) =>
          node.type === "input" && node.config.required ? [node.config.key] : [],
        );
        const outputKeys = pipelineTerminalOutputs(parsed).map(({ key }) => key);
        const missingInputs = requiredInputs.filter((key) => input.inputMapping[key] === undefined);
        // New bindings write one structured result object to the pipeline
        // column. Legacy per-terminal mappings remain valid for compatibility.
        const hasStructuredOutput = input.outputMapping[PIPELINE_RESULT_OUTPUT_KEY] !== undefined;
        const missingOutputs = hasStructuredOutput ? [] : outputKeys.filter((key) => input.outputMapping[key] === undefined);
        if (missingInputs.length > 0 || missingOutputs.length > 0) {
          return yield* Effect.fail(new PipelineBindingError({ message: `Complete the table mapping before attaching. Missing: ${[...missingInputs, ...missingOutputs].join(", ")}.` }));
        }
        const now = Date.now();
        return yield* repo.upsertBinding({ workspaceId: pipeline.workspaceId, pipelineId: input.pipelineId, versionId: input.versionId, tableId: input.tableId, inputMapping: input.inputMapping, outputMapping: input.outputMapping, executionTarget: input.executionTarget, autoRun: input.autoRun ?? false, enabled: true, createdAt: now, updatedAt: now });
      });

      const consumeAction = (input: {
        readonly workspaceId: string;
        readonly runId: string;
        readonly receiptKey: string;
        readonly rowId: string;
        readonly nodeId: string;
        readonly generation?: number;
      }) => repo.consumeAction({ ...input, generation: input.generation ?? 0, now: Date.now() });

      const estimateRun = (input: {
        readonly pipelineId: string;
        readonly versionId: string;
        readonly totalRecords: number;
      }) => Effect.gen(function* () {
        yield* requirePipeline(input.pipelineId);
        const found = yield* repo.findVersion(input.versionId);
        if (Option.isNone(found) || found.value.pipelineId !== input.pipelineId) {
          return yield* Effect.fail(new PipelineNotFoundError({ message: `Pipeline version ${input.versionId} not found.` }));
        }
        const compiled = yield* compileOrFail(found.value.graph);
        const records = Math.max(0, Math.floor(input.totalRecords));
        return {
          records,
          minimumActions: compiled.actionEstimate.minimumPerRecord * records,
          expectedActions: compiled.actionEstimate.expectedPerRecord * records,
          maximumActions: compiled.actionEstimate.maximumPerRecord * records,
          perRecord: compiled.actionEstimate,
        };
      });

      const createRun = (input: {
        readonly pipelineId: string;
        readonly versionId: string;
        readonly bindingId?: string | null;
        readonly tableId?: string | null;
        readonly executionTarget: PipelineExecutionTarget;
        readonly trigger: string;
        readonly selection: unknown;
        readonly totalRecords: number;
      }) => Effect.gen(function* () {
        const pipeline = yield* requirePipeline(input.pipelineId);
        const version = yield* repo.findVersion(input.versionId);
        const totalRecords = Math.max(0, Math.floor(input.totalRecords));
        const isDraftTest = Option.isSome(version)
          && version.value.status === "draft"
          && input.trigger === "manual"
          && totalRecords === 1
          && input.bindingId != null
          && input.tableId != null;
        const isImmutableVersion = Option.isSome(version)
          && (version.value.status === "deployed" || version.value.status === "superseded");
        if (Option.isNone(version) || version.value.pipelineId !== input.pipelineId || (!isImmutableVersion && !isDraftTest)) {
          return yield* Effect.fail(new PipelineBindingError({ message: "Only a one-record manual test may run a draft. Other runs require an immutable deployed version." }));
        }
        const compiled = yield* compileOrFail(version.value.graph);
        if (input.executionTarget === "cloud" && !compiled.capabilities.cloud) {
          return yield* Effect.fail(new PipelineBindingError({ message: `This pipeline cannot run in the cloud: ${compiled.capabilities.reasons.join(" ")}` }));
        }
        if (input.bindingId !== undefined && input.bindingId !== null) {
          const binding = yield* repo.findBinding(input.bindingId);
          if (Option.isNone(binding) || !binding.value.enabled || binding.value.workspaceId !== pipeline.workspaceId || binding.value.pipelineId !== input.pipelineId || (!isDraftTest && binding.value.versionId !== input.versionId) || binding.value.tableId !== input.tableId || binding.value.executionTarget !== input.executionTarget) {
            return yield* Effect.fail(new PipelineBindingError({ message: "The run must use an enabled binding that matches its pipeline version, table, workspace, and execution target." }));
          }
        } else if (input.tableId !== undefined && input.tableId !== null) {
          return yield* Effect.fail(new PipelineBindingError({ message: "Table runs require a deployed pipeline binding." }));
        }
        const requester = Option.getOrNull(yield* identity.currentUserId);
        return yield* repo.createRun({
          workspaceId: pipeline.workspaceId,
          pipelineId: input.pipelineId,
          versionId: input.versionId,
          bindingId: input.bindingId ?? null,
          tableId: input.tableId ?? null,
          executionTarget: input.executionTarget,
          status: "queued",
          trigger: input.trigger,
          selection: input.selection,
          requestedBy: requester,
          totalRecords,
          estimatedActions: input.executionTarget === "cloud" ? compiled.actionEstimate.maximumPerRecord * totalRecords : 0,
          createdAt: Date.now(),
        });
      });

      /**
       * Start the deployed cloud workflows attached to newly populated rows.
       * An enabled table attachment is the trigger; `autoRun` is retained in
       * storage for backwards compatibility but no longer asks the user to make
       * a second, confusing enablement decision.
       */
      const createTriggeredRuns = (input: {
        readonly tableId?: string;
        readonly columnId?: string;
        readonly rowIds: readonly string[];
        readonly trigger: "row_created" | "row_updated";
      }) => Effect.gen(function* () {
        if (input.rowIds.length === 0) return [] as const;
        const bindings = input.columnId !== undefined
          ? yield* repo.listBindingsForColumn(input.columnId)
          : yield* repo.listBindingsForTable(input.tableId as string);
        const runnable = bindings.filter((binding) =>
          binding.enabled
          && binding.executionTarget === "cloud"
          && (input.columnId === undefined || Object.values(binding.inputMapping).includes(input.columnId)),
        );
        const triggered = yield* Effect.forEach(runnable, (binding) => Effect.gen(function* () {
          // Bindings retain their table mappings, while execution follows the
          // current deployed graph. This self-heals attachments created before
          // deployments automatically advanced their saved version id.
          const latestDeployed = yield* repo.latestVersion(binding.pipelineId, "deployed");
          const versionId = Option.isSome(latestDeployed) ? latestDeployed.value.id : binding.versionId;
          const activeBinding = versionId === binding.versionId ? binding : yield* repo.upsertBinding({
            workspaceId: binding.workspaceId,
            pipelineId: binding.pipelineId,
            versionId,
            tableId: binding.tableId,
            inputMapping: binding.inputMapping,
            outputMapping: binding.outputMapping,
            executionTarget: binding.executionTarget,
            autoRun: binding.autoRun,
            enabled: binding.enabled,
            createdAt: binding.createdAt,
            updatedAt: Date.now(),
          });
          // Split a large trigger batch across several runs so no single
          // `pipeline_runs.selection` jsonb column holds an unbounded row-id
          // array. Each chunk covers a distinct slice; together they cover
          // every triggered row exactly once.
          const runs = yield* Effect.forEach(
            chunkPipelineSelection(input.rowIds),
            (chunk) => createRun({
              pipelineId: binding.pipelineId,
              versionId,
              bindingId: activeBinding.id,
              tableId: binding.tableId,
              executionTarget: binding.executionTarget,
              trigger: input.trigger,
              selection: { rowIds: [...chunk] },
              totalRecords: chunk.length,
            }),
            { concurrency: 1 },
          );
          const cells = yield* repo.setOutputStatus({ workspaceId: binding.workspaceId, tableId: binding.tableId, rowIds: input.rowIds, columnIds: [...new Set(Object.values(binding.outputMapping))], status: "pending", now: Date.now() });
          yield* Effect.forEach(cells, (cell) => realtime.publish({ workspaceId: binding.workspaceId, tableId: binding.tableId, event: { type: "cell.upsert", cell } }).pipe(Effect.catchTag("RealtimePublisherError", () => Effect.void)), { concurrency: 20, discard: true });
          return runs;
        }), { concurrency: 10 });
        return triggered.flat();
      });

      const listTableBindings = (tableId: string) => Effect.gen(function* () {
        const workspace = yield* repo.tableWorkspace(tableId);
        if (Option.isNone(workspace)) return yield* Effect.fail(new PipelineBindingError({ message: "The attached table no longer exists." }));
        yield* membership.requireMember(workspace.value);
        return yield* repo.listBindingsForTable(tableId);
      });

      const createManualRunsForOutputCell = (input: { readonly rowId: string; readonly columnId: string }) => Effect.gen(function* () {
        const bindings = yield* repo.listBindingsForColumn(input.columnId);
        const runnable = bindings.filter((binding) =>
          binding.enabled
          && binding.executionTarget === "cloud"
          && Object.values(binding.outputMapping).includes(input.columnId),
        );
        if (runnable.length === 0) return yield* Effect.fail(new PipelineBindingError({ message: "No enabled pipeline is attached to this output cell." }));
        return yield* Effect.forEach(runnable, (binding) => Effect.gen(function* () {
          const latestDeployed = yield* repo.latestVersion(binding.pipelineId, "deployed");
          const versionId = Option.isSome(latestDeployed) ? latestDeployed.value.id : binding.versionId;
          const activeBinding = versionId === binding.versionId ? binding : yield* repo.upsertBinding({
            workspaceId: binding.workspaceId,
            pipelineId: binding.pipelineId,
            versionId,
            tableId: binding.tableId,
            inputMapping: binding.inputMapping,
            outputMapping: binding.outputMapping,
            executionTarget: binding.executionTarget,
            autoRun: binding.autoRun,
            enabled: binding.enabled,
            createdAt: binding.createdAt,
            updatedAt: Date.now(),
          });
          const run = yield* createRun({
            pipelineId: binding.pipelineId,
            versionId,
            bindingId: activeBinding.id,
            tableId: binding.tableId,
            executionTarget: binding.executionTarget,
            trigger: "manual",
            selection: { rowIds: [input.rowId] },
            totalRecords: 1,
          });
          const cells = yield* repo.setOutputStatus({ workspaceId: binding.workspaceId, tableId: binding.tableId, rowIds: [input.rowId], columnIds: [input.columnId], status: "pending", now: Date.now() });
          yield* Effect.forEach(cells, (cell) => realtime.publish({ workspaceId: binding.workspaceId, tableId: binding.tableId, event: { type: "cell.upsert", cell } }).pipe(Effect.catchTag("RealtimePublisherError", () => Effect.void)), { concurrency: 20, discard: true });
          return run;
        }), { concurrency: 10 });
      });

      const listRuns = (pipelineId: string, limit = 50) => Effect.gen(function* () {
        yield* requirePipeline(pipelineId);
        return yield* repo.listRuns(pipelineId, limit);
      });

      const getRun = (runId: string) => Effect.gen(function* () {
        const found = yield* repo.findRun(runId);
        if (Option.isNone(found)) return yield* Effect.fail(new PipelineNotFoundError({ message: `Pipeline run ${runId} not found.` }));
        yield* membership.requireMember(found.value.workspaceId);
        const [details, version] = yield* Effect.all([repo.runDetails(runId, 100), repo.findVersion(found.value.versionId)]);
        const graph = Option.isSome(version) ? version.value.graph : null;
        return { run: found.value, graph, ...details, nodes: graph === null ? details.nodes : reconstructPipelineNodeInputs(graph, details.nodes as Parameters<typeof reconstructPipelineNodeInputs>[1]) };
      });

      return { create, list, get, remove, patchDraft, deploy, attach, estimateRun, createRun, createTriggeredRuns, listTableBindings, createManualRunsForOutputCell, listRuns, getRun, consumeAction } as const;
    }),
    dependencies: [],
  },
) {}
