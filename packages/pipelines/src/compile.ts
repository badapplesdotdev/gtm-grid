import { createHash } from "node:crypto";
import type {
  CompiledPipeline,
  PipelineActionEstimate,
  PipelineCapabilities,
  PipelineEdge,
  PipelineGraph,
  PipelineNode,
} from "./types.js";
import { topologicalSort, validatePipelineGraph } from "./validate.js";

export class PipelineCompileError extends Error {
  constructor(readonly issues: readonly { readonly message: string }[]) {
    super(issues.map((issue) => issue.message).join("\n"));
    this.name = "PipelineCompileError";
  }
}

export const isBillableNode = (node: PipelineNode): boolean =>
  node.type !== "input" && node.type !== "output";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

export function pipelineGraphHash(graph: PipelineGraph): string {
  return createHash("sha256").update(JSON.stringify(stable(graph))).digest("hex");
}

function capabilities(graph: PipelineGraph): PipelineCapabilities {
  const reasons: string[] = [];
  for (const node of graph.nodes) {
    if (node.type === "http") {
      try {
        const url = new URL(node.config.url);
        const host = url.hostname.toLowerCase();
        if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local")) {
          reasons.push(`${node.name} targets a local/private host.`);
        }
      } catch {
        // Templates such as {{Base URL}} are validated at binding/deploy time.
      }
    }
  }
  return { local: true, cloud: reasons.length === 0, reasons };
}

function actionEstimate(graph: PipelineGraph): PipelineActionEstimate {
  const billable = graph.nodes.filter(isBillableNode).map((node) => node.id);
  const conditionalDescendants = new Set<string>();
  const outbound = new Map<string, string[]>();
  for (const edge of graph.edges) outbound.set(edge.source, [...(outbound.get(edge.source) ?? []), edge.target]);
  for (const condition of graph.nodes.filter((node) => node.type === "condition")) {
    const pending = [...(outbound.get(condition.id) ?? [])];
    while (pending.length > 0) {
      const id = pending.pop() as string;
      if (conditionalDescendants.has(id)) continue;
      conditionalDescendants.add(id);
      pending.push(...(outbound.get(id) ?? []));
    }
  }
  const minimum = graph.nodes.filter(
    (node) => isBillableNode(node) && !conditionalDescendants.has(node.id),
  ).length;
  const maximum = billable.length;
  return {
    minimumPerRecord: minimum,
    expectedPerRecord: Math.ceil((minimum + maximum) / 2),
    maximumPerRecord: maximum,
    billableNodeIds: billable,
  };
}

function edgeMap(
  nodeIds: readonly string[],
  edges: readonly PipelineEdge[],
  direction: "inbound" | "outbound",
): ReadonlyMap<string, readonly PipelineEdge[]> {
  const out = new Map<string, PipelineEdge[]>(nodeIds.map((id) => [id, []]));
  for (const edge of edges) {
    const key = direction === "inbound" ? edge.target : edge.source;
    out.set(key, [...(out.get(key) ?? []), edge]);
  }
  return out;
}

export function compilePipeline(graph: PipelineGraph): CompiledPipeline {
  const validation = validatePipelineGraph(graph);
  if (!validation.valid) throw new PipelineCompileError(validation.issues);
  const topologicalNodeIds = topologicalSort(graph);
  if (topologicalNodeIds === null) throw new PipelineCompileError([{ message: "Pipeline contains a cycle." }]);
  const ids = graph.nodes.map((node) => node.id);
  return {
    graph,
    graphHash: pipelineGraphHash(graph),
    topologicalNodeIds,
    inbound: edgeMap(ids, graph.edges, "inbound"),
    outbound: edgeMap(ids, graph.edges, "outbound"),
    capabilities: capabilities(graph),
    actionEstimate: actionEstimate(graph),
  };
}
