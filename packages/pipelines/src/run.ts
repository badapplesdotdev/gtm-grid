import { isBillableNode } from "./compile.js";
import { pipelineExecutedNodeOutputs } from "./validate.js";
import type {
  CompiledPipeline,
  PipelineEdge,
  PipelineNode,
  PipelineNodeTrace,
  PipelineRunOptions,
  PipelineRunResult,
} from "./types.js";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const receiptKey = (runId: string, rowId: string, nodeId: string): string =>
  `${runId}:${rowId}:${nodeId}:0`;

function structuralOutput(
  node: PipelineNode,
  input: Readonly<Record<string, unknown>>,
  upstream: Readonly<Record<string, unknown>>,
): unknown {
  if (node.type === "input") return input[node.config.key];
  const values = Object.values(upstream);
  return values.length <= 1 ? values[0] : upstream;
}

function edgeIsActive(edge: PipelineEdge, branchByNode: ReadonlyMap<string, string>): boolean {
  const branch = branchByNode.get(edge.source);
  return branch === undefined || edge.sourcePort === branch;
}

export async function runPipelineRecord(
  compiled: CompiledPipeline,
  options: PipelineRunOptions,
): Promise<PipelineRunResult> {
  if (options.target === "cloud" && !compiled.capabilities.cloud) {
    throw new Error(`Pipeline is not cloud compatible: ${compiled.capabilities.reasons.join(" ")}`);
  }
  const now = options.now ?? Date.now;
  const nodes = new Map(compiled.graph.nodes.map((node) => [node.id, node]));
  const outputs = new Map<string, unknown>();
  const branches = new Map<string, string>();
  const completed = new Set<string>();
  const traces: PipelineNodeTrace[] = [];
  const namedOutputs: Record<string, unknown> = {};
  const outputKeyByNode = new Map(pipelineExecutedNodeOutputs(compiled.graph).map(({ node, key }) => [node.id, key]));
  let actionsConsumed = 0;
  let firstError: string | undefined;
  const record = async (trace: PipelineNodeTrace) => {
    traces.push(trace);
    await options.onNodeProgress?.(trace);
  };

  for (const nodeId of compiled.topologicalNodeIds) {
    if (options.signal?.aborted) throw new Error("Pipeline run cancelled.");
    const node = nodes.get(nodeId) as PipelineNode;
    const inbound = compiled.inbound.get(nodeId) ?? [];
    const activeInbound = inbound.filter(
      (edge) => completed.has(edge.source) && edgeIsActive(edge, branches),
    );
    if (node.type !== "input" && activeInbound.length === 0) {
      await record({ nodeId, status: "skipped", startedAt: null, finishedAt: null, actionConsumed: false });
      continue;
    }
    const upstream = Object.fromEntries(
      activeInbound.map((edge) => [edge.targetPort ?? edge.source, outputs.get(edge.source)]),
    );
    const nodeInput = node.type === "input" ? options.input : upstream;
    const startedAt = now();
    let actionConsumed = false;
    try {
      await options.onNodeProgress?.({ nodeId, status: "running", startedAt, finishedAt: null, input: nodeInput, actionConsumed: false });
      if (isBillableNode(node) && options.target === "cloud") {
        const receipt = { key: receiptKey(options.runId, options.rowId, node.id), runId: options.runId, rowId: options.rowId, nodeId: node.id };
        actionConsumed = options.actionSink === undefined ? true : await options.actionSink.consume(receipt);
        if (actionConsumed) actionsConsumed += 1;
      }
      const result = node.type === "input" || node.type === "output"
        ? { output: structuralOutput(node, options.input, upstream) }
        : await options.executor.execute({
            runId: options.runId,
            rowId: options.rowId,
            target: options.target,
            node,
            rootInput: options.input,
            upstream,
            previousOutputs: Object.fromEntries(outputs),
            signal: options.signal,
          });
      if (node.type === "condition") {
        if (result.branch !== "true" && result.branch !== "false") {
          throw new Error(`Condition node ${node.name} did not return a true/false branch.`);
        }
        branches.set(node.id, result.branch);
      }
      outputs.set(node.id, result.output);
      completed.add(node.id);
      const outputKey = outputKeyByNode.get(node.id);
      if (outputKey !== undefined) namedOutputs[outputKey] = result.output;
      await record({ nodeId, status: "succeeded", startedAt, finishedAt: now(), input: nodeInput, output: result.output, actionConsumed });
    } catch (error) {
      const message = errorMessage(error);
      firstError ??= message;
      const outputKey = outputKeyByNode.get(node.id);
      if (outputKey !== undefined) namedOutputs[outputKey] = { error: message };
      await record({ nodeId, status: "failed", startedAt, finishedAt: now(), input: nodeInput, error: message, actionConsumed });
      if (node.onError !== "continue") {
        for (const remainingId of compiled.topologicalNodeIds.slice(traces.length)) {
          await record({ nodeId: remainingId, status: "skipped", startedAt: null, finishedAt: null, actionConsumed: false });
        }
        return { status: "failed", outputs: namedOutputs, traces, actionsConsumed, firstError };
      }
      outputs.set(node.id, { error: message });
      completed.add(node.id);
    }
  }
  return {
    status: firstError === undefined ? "succeeded" : "failed",
    outputs: namedOutputs,
    traces,
    actionsConsumed,
    ...(firstError === undefined ? {} : { firstError }),
  };
}
