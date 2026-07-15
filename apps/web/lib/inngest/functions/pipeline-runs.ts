import { Engine, runFunction, type AiConfig, type EngineConfig, type Registry } from "@gtmgrid/engine";
import {
  compilePipeline,
  DEFAULT_PIPELINE_BATCH_SIZE,
  pipelineOutputCellValues,
  pipelineColumnVariables,
  runPipelineRecord,
  type PipelineNodeExecutionContext,
  type PipelineNodeExecutor,
} from "@gtmgrid/pipelines";
import { pipelineTemplateText } from "@gtmgrid/pipelines/template-text";
import { PipelineRepo, RealtimePublisher } from "@gtmgrid/services";
import { Effect, Option } from "effect";
import { inngest } from "../client";
import { onFailure } from "../on-failure";
import { workerRuntime } from "../../../app/api/worker/_lib";
import { workerClient, WORKER_REFS } from "../worker-client";
import { buildWorkerStore, engineConfig, workspaceRegistry } from "./process-webhook-record";

interface RowCursor { readonly position: number; readonly createdAt: number; readonly id: string }
interface GridPage {
  readonly columns: readonly { readonly _id: string; readonly name: string }[];
  readonly rows: readonly { readonly _id: string }[];
  readonly cells: readonly { readonly rowId: string; readonly columnId: string; readonly value: unknown }[];
  readonly nextCursor: RowCursor | null;
}

interface RunEvent { readonly runId: string; readonly workspaceId: string }
interface PageEvent extends RunEvent { readonly cursor: RowCursor | null; readonly ordinal: number; readonly seen: number }
interface BatchEvent extends RunEvent { readonly batchId: string; readonly rowIds: readonly string[] }

const execute = async <A>(effect: Effect.Effect<A, unknown, PipelineRepo | RealtimePublisher>): Promise<A> => {
  const runtime = await workerRuntime();
  return runtime.runPromise(effect);
};

function pathValue(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined, source);
}

function resolveTemplates(value: unknown, scope: Readonly<Record<string, unknown>>): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
    if (exact?.[1] !== undefined) return pathValue(scope, exact[1]);
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path: string) => String(pathValue(scope, path) ?? ""));
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplates(item, scope));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTemplates(item, scope)]));
  return value;
}

function resolveExpressionTemplates(expression: string, scope: Readonly<Record<string, unknown>>): string {
  return expression.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path: string) =>
    JSON.stringify(pathValue(scope, path)) ?? "undefined",
  );
}

function makeExecutor(engine: Engine, registry: Registry): PipelineNodeExecutor {
  return {
    execute: async (context: PipelineNodeExecutionContext) => {
      const scope = { ...context.rootInput, inputs: context.rootInput, input: context.rootInput, upstream: context.upstream, nodes: context.previousOutputs };
      const inputs = { ...context.rootInput, ...context.upstream, nodes: context.previousOutputs };
      const node = context.node;
      if (node.type === "tool") return { output: await engine.dispatch(node.config.provider, node.config.method, resolveTemplates(node.config.params, scope) as Record<string, unknown>) };
      if (node.type === "ai") {
        const resolved = resolveTemplates({ provider: node.config.provider, model: node.config.model, prompt: node.config.prompt, system: node.config.system }, scope) as Record<string, unknown>;
        const prompt = pipelineTemplateText(resolved.prompt);
        if (!prompt.trim()) throw new Error(`AI node ${node.name} prompt resolved to an empty value. Choose a populated source column or earlier node output.`);
        const output = await engine.dispatch("ai", "generate", { ...resolved, prompt, ...(resolved.system === undefined ? {} : { system: pipelineTemplateText(resolved.system) }) });
        return { output: node.config.responseFormat !== "json" && typeof output === "object" && output !== null && "text" in output ? (output as { text: unknown }).text : output };
      }
      if (node.type === "http") return { output: await engine.dispatch("http", "request", resolveTemplates(node.config, scope) as Record<string, unknown>) };
      if (node.type === "formula" || node.type === "condition") {
        const expression = resolveExpressionTemplates(node.config.expression, scope);
        const output = await runFunction({ code: `function(inputs) { with (inputs) { return (${expression}); } }`, inputs, providers: registry.providerMap(), dispatch: engine.dispatch });
        return node.type === "condition" ? { output, branch: output ? "true" : "false" } : { output };
      }
      if (node.type === "code") return { output: await runFunction({ code: node.config.source, inputs, providers: registry.providerMap(), dispatch: engine.dispatch }) };
      throw new Error(`Pipeline node type ${node.type} is not executable in this worker.`);
    },
  };
}

const AI_DEFAULTS: Readonly<Record<AiConfig["provider"], string>> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o",
  openrouter: "openai/gpt-4o",
  hermes: "hermes-4",
};

async function pipelineEngineConfig(workspaceId: string): Promise<EngineConfig> {
  const base = engineConfig();
  const providers: AiConfig[] = [...(base.aiProviders ?? [])];
  for (const provider of Object.keys(AI_DEFAULTS) as AiConfig["provider"][]) {
    if (providers.some((item) => item.provider === provider)) continue;
    const credential = await workerClient.query(WORKER_REFS.getCredential, { workspaceId, extensionId: `ai:${provider}` }) as { secrets?: Record<string, string> } | null;
    const apiKey = credential?.secrets?.apiKey;
    if (!apiKey) continue;
    const baseURL = credential?.secrets?.baseUrl;
    providers.push({ provider, apiKey, model: AI_DEFAULTS[provider], ...(baseURL ? { baseURL } : {}) });
  }
  return { ...base, ai: base.ai ?? providers[0], aiProviders: providers };
}

const loadRun = (runId: string) => Effect.gen(function* () {
  const repo = yield* PipelineRepo;
  const found = yield* repo.findRun(runId);
  if (Option.isNone(found)) throw new Error(`Pipeline run ${runId} not found.`);
  return found.value;
});

export const planPipelineRun = inngest.createFunction(
  { id: "plan-pipeline-run", retries: 3, onFailure, concurrency: [{ scope: "account", key: '"pipeline-plan"', limit: 25 }, { key: "event.data.workspaceId", limit: 2 }], triggers: [{ event: "pipeline/run.requested" }] },
  async ({ event, step }) => {
    const data = event.data as unknown as RunEvent;
    const run = await step.run(`start:${data.runId}`, async () => execute(Effect.gen(function* () {
      const repo = yield* PipelineRepo;
      const current = yield* loadRun(data.runId);
      yield* repo.markRunStarted(data.runId, event.id ?? data.runId, Date.now());
      return current;
    })));
    const selection = typeof run.selection === "object" && run.selection !== null ? run.selection as { rowIds?: unknown } : {};
    const selected = Array.isArray(selection.rowIds) ? selection.rowIds.filter((id): id is string => typeof id === "string") : null;
    if (selected !== null) {
      for (let offset = 0, ordinal = 0; offset < selected.length; offset += DEFAULT_PIPELINE_BATCH_SIZE, ordinal += 1) {
        const rowIds = selected.slice(offset, offset + DEFAULT_PIPELINE_BATCH_SIZE);
        const batch = await step.run(`batch:${data.runId}:${ordinal}`, () => execute(Effect.gen(function* () {
          const repo = yield* PipelineRepo;
          return yield* repo.createBatch({ workspaceId: data.workspaceId, runId: data.runId, ordinal, selector: { rowIds }, status: "queued", totalRecords: rowIds.length, createdAt: Date.now() });
        })));
        await step.sendEvent(`dispatch:${data.runId}:${ordinal}`, { name: "pipeline/batch.ready", data: { ...data, batchId: batch.id, rowIds } });
      }
      await step.run(`finalize-plan:${data.runId}`, () => execute(Effect.gen(function* () { const repo = yield* PipelineRepo; yield* repo.finalizeRunPlan(data.runId, selected.length, Date.now()); })));
      return { batches: Math.ceil(selected.length / DEFAULT_PIPELINE_BATCH_SIZE), records: selected.length };
    }
    await step.sendEvent(`page:${data.runId}:0`, { name: "pipeline/run.page", data: { ...data, cursor: null, ordinal: 0, seen: 0 } });
    return { paged: true };
  },
);

export const planPipelinePage = inngest.createFunction(
  { id: "plan-pipeline-page", retries: 3, onFailure, concurrency: [{ scope: "account", key: '"pipeline-page"', limit: 50 }, { key: "event.data.workspaceId", limit: 3 }], triggers: [{ event: "pipeline/run.page" }] },
  async ({ event, step }) => {
    const data = event.data as unknown as PageEvent;
    const run = await step.run(`run:${data.runId}:${data.ordinal}`, () => execute(loadRun(data.runId)));
    if (run.tableId === null) throw new Error("A paged pipeline run requires a table.");
    const page = await step.run(`rows:${data.runId}:${data.ordinal}`, () => workerClient.query(WORKER_REFS.getTablePage, { tableId: run.tableId, cursor: data.cursor, limit: DEFAULT_PIPELINE_BATCH_SIZE }) as Promise<GridPage>);
    const rowIds = page.rows.map((row) => row._id);
    if (rowIds.length > 0) {
      const batch = await step.run(`batch:${data.runId}:${data.ordinal}`, () => execute(Effect.gen(function* () { const repo = yield* PipelineRepo; return yield* repo.createBatch({ workspaceId: data.workspaceId, runId: data.runId, ordinal: data.ordinal, selector: { rowIds }, status: "queued", totalRecords: rowIds.length, createdAt: Date.now() }); })));
      await step.sendEvent(`dispatch:${data.runId}:${data.ordinal}`, { name: "pipeline/batch.ready", data: { runId: data.runId, workspaceId: data.workspaceId, batchId: batch.id, rowIds } });
    }
    const seen = data.seen + rowIds.length;
    if (page.nextCursor !== null) await step.sendEvent(`next:${data.runId}:${data.ordinal + 1}`, { name: "pipeline/run.page", data: { runId: data.runId, workspaceId: data.workspaceId, cursor: page.nextCursor, ordinal: data.ordinal + 1, seen } });
    else await step.run(`finalize-plan:${data.runId}`, () => execute(Effect.gen(function* () { const repo = yield* PipelineRepo; yield* repo.finalizeRunPlan(data.runId, seen, Date.now()); })));
    return { rows: rowIds.length, next: page.nextCursor !== null };
  },
);

export const executePipelineBatch = inngest.createFunction(
  { id: "execute-pipeline-batch", retries: 3, onFailure, concurrency: [{ scope: "account", key: '"pipeline-execute"', limit: 100 }, { key: "event.data.workspaceId", limit: 5 }], triggers: [{ event: "pipeline/batch.ready" }] },
  async ({ event, step }) => {
    const data = event.data as unknown as BatchEvent;
    const context = await step.run(`context:${data.batchId}`, () => execute(Effect.gen(function* () {
      const repo = yield* PipelineRepo;
      const run = yield* loadRun(data.runId);
      const version = yield* repo.findVersion(run.versionId);
      if (Option.isNone(version)) throw new Error("Pipeline version is missing.");
      if (run.bindingId === null || run.tableId === null) throw new Error("Cloud table runs require a binding and table.");
      const binding = yield* repo.findBinding(run.bindingId);
      if (Option.isNone(binding) || binding.value.tableId !== run.tableId) throw new Error("Pipeline binding is missing or does not match the run table.");
      yield* repo.markBatchStarted(data.batchId);
      return { run, version: version.value, binding: binding.value };
    })));
    const grid = await step.run(`grid:${data.batchId}`, () => workerClient.query(WORKER_REFS.getTableForRows, { tableId: context.run.tableId, rowIds: data.rowIds }) as Promise<GridPage>);
    const [store, registry] = await Promise.all([buildWorkerStore(context.run.tableId as string, data.workspaceId), workspaceRegistry(data.workspaceId)]);
    const engine = new Engine(await pipelineEngineConfig(data.workspaceId), registry, { store, creds: store });
    const compiled = compilePipeline(context.version.graph);
    const inputNodeIds = new Set(compiled.graph.nodes.filter((node) => node.type === "input").map((node) => node.id));
    let failed = 0;
    for (const rowId of data.rowIds) {
      const result = await step.run(`row:${data.runId}:${rowId}`, async () => {
        const cells = new Map(grid.cells.filter((cell) => cell.rowId === rowId).map((cell) => [cell.columnId, cell.value]));
        const columns = Object.fromEntries(
          pipelineColumnVariables(grid.columns.map((column) => ({ id: column._id, name: column.name })))
            .map((variable) => [variable.key, cells.get(variable.columnId)]),
        );
        const input = {
          ...Object.fromEntries(Object.entries(context.binding.inputMapping).map(([key, columnId]) => [key, cells.get(columnId)])),
          columns,
        };
        const selection = typeof context.run.selection === "object" && context.run.selection !== null ? context.run.selection as { writeOutputs?: unknown } : {};
        const writesOutputs = selection.writeOutputs !== false;
        const outputColumnIds = [...new Set(Object.values(context.binding.outputMapping))];
        if (writesOutputs) await execute(Effect.gen(function* () {
          const repo = yield* PipelineRepo;
          const realtime = yield* RealtimePublisher;
          const cells = yield* repo.setOutputStatus({ workspaceId: data.workspaceId, tableId: context.run.tableId as string, rowIds: [rowId], columnIds: outputColumnIds, status: "running", now: Date.now() });
          yield* Effect.forEach(cells, (cell) => realtime.publish({ workspaceId: data.workspaceId, tableId: context.run.tableId as string, event: { type: "cell.upsert", cell } }).pipe(Effect.catchTag("RealtimePublisherError", () => Effect.void)), { concurrency: 20, discard: true });
        }));
        const startedAt = Date.now();
        const rowRunId = await execute(Effect.gen(function* () {
          const repo = yield* PipelineRepo;
          return yield* repo.startRowRun({ workspaceId: data.workspaceId, runId: data.runId, batchId: data.batchId, rowId, startedAt });
        }));
        const output = await runPipelineRecord(compiled, {
          runId: data.runId, rowId, target: "cloud", input, executor: makeExecutor(engine, registry),
          actionSink: { consume: (receipt) => execute(Effect.gen(function* () { const repo = yield* PipelineRepo; return yield* repo.consumeAction({ workspaceId: data.workspaceId, runId: data.runId, receiptKey: receipt.key, rowId, nodeId: receipt.nodeId, generation: 0, now: Date.now() }); })) },
          onNodeProgress: (progress) => execute(Effect.gen(function* () {
            const repo = yield* PipelineRepo;
            yield* repo.recordNodeRun({ workspaceId: data.workspaceId, runId: data.runId, rowRunId, rowId, ...progress, input: inputNodeIds.has(progress.nodeId) ? progress.input : undefined });
          })),
        });
        const values = pipelineOutputCellValues(output.outputs, context.binding.outputMapping);
        const finishedAt = Date.now();
        await execute(Effect.gen(function* () {
          const repo = yield* PipelineRepo;
          const realtime = yield* RealtimePublisher;
          if (output.status === "succeeded" && writesOutputs) {
            yield* repo.commitOutputs({ workspaceId: data.workspaceId, tableId: context.run.tableId as string, rowId, values, now: finishedAt });
            yield* Effect.forEach(Object.entries(values), ([columnId, value]) => realtime.publish({ workspaceId: data.workspaceId, tableId: context.run.tableId as string, event: { type: "cell.upsert", cell: { rowId, columnId, value, status: "done", error: null } } }).pipe(Effect.catchTag("RealtimePublisherError", () => Effect.void)), { concurrency: 20, discard: true });
          } else if (output.status === "failed" && writesOutputs) {
            const cells = yield* repo.setOutputStatus({ workspaceId: data.workspaceId, tableId: context.run.tableId as string, rowIds: [rowId], columnIds: outputColumnIds, status: "error", error: output.firstError ?? "Pipeline run failed.", now: finishedAt });
            yield* Effect.forEach(cells, (cell) => realtime.publish({ workspaceId: data.workspaceId, tableId: context.run.tableId as string, event: { type: "cell.upsert", cell } }).pipe(Effect.catchTag("RealtimePublisherError", () => Effect.void)), { concurrency: 20, discard: true });
          }
          yield* repo.recordRowResult({ workspaceId: data.workspaceId, runId: data.runId, batchId: data.batchId, rowId, status: output.status, firstError: output.firstError, actionsConsumed: output.actionsConsumed, startedAt, finishedAt, traces: output.traces.map((trace) => ({ ...trace, input: inputNodeIds.has(trace.nodeId) ? trace.input : undefined })) });
        }));
        return { status: output.status };
      });
      if (result.status === "failed") failed += 1;
    }
    await step.run(`complete:${data.batchId}`, () => execute(Effect.gen(function* () { const repo = yield* PipelineRepo; yield* repo.completeBatch(data.batchId, Date.now()); })));
    return { records: data.rowIds.length, failed };
  },
);
