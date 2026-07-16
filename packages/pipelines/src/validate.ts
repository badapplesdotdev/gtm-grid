import { pipelineGraphSchema } from "./schema.js";
import {
  MAX_PIPELINE_EDGES,
  MAX_PIPELINE_NODES,
  type PipelineEdge,
  type PipelineGraph,
} from "./types.js";

/** Public output ports are implicit: every reachable terminal node contributes
 * one result. Legacy Output nodes keep their configured key for compatibility. */
export const pipelineTerminalOutputs = (graph: PipelineGraph) => {
  const sources = new Set(graph.edges.map((edge) => edge.source));
  const occurrences = new Map<string, number>();
  return graph.nodes
    .filter((node) => !sources.has(node.id))
    .map((node) => {
      const base = node.type === "output" ? node.config.key : node.name.trim();
      const occurrence = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, occurrence);
      return {
        node,
        // Table output is user-facing structured data. Keep internal node ids
        // stable for graph references, but expose the readable node name in the
        // result cell. Repeated names remain collision-safe.
        key: occurrence === 1 ? base : `${base} ${occurrence}`,
      };
    });
};

/** User-facing keys for every step whose result can be written into the
 * structured pipeline output cell. Input/trigger nodes are routing only. */
export const pipelineExecutedNodeOutputs = (graph: PipelineGraph) => {
  const occurrences = new Map<string, number>();
  return graph.nodes.filter((node) => node.type !== "input").map((node) => {
    const base = node.type === "output" ? node.config.key : node.name.trim();
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return { node, key: occurrence === 1 ? base : `${base} ${occurrence}` };
  });
};

export interface PipelineValidationIssue {
  readonly code:
    | "invalid_schema"
    | "limit_exceeded"
    | "duplicate_id"
    | "missing_endpoint"
    | "self_edge"
    | "invalid_port"
    | "invalid_degree"
    | "duplicate_key"
    | "cycle"
    | "unreachable"
    | "dead_end";
  readonly message: string;
  readonly nodeId?: string;
  readonly edgeId?: string;
}

export interface PipelineValidationResult {
  readonly valid: boolean;
  readonly issues: readonly PipelineValidationIssue[];
}

/** Fields that may be empty while authoring a draft, but must be completed
 * before deployment. Keeping this separate from structural graph validation
 * lets the canvas save genuinely empty fields and render useful placeholders. */
export const pipelineConfigurationIssues = (graph: PipelineGraph): string[] =>
  graph.nodes.flatMap((node) => {
    if (node.type === "ai" && !node.config.prompt.trim()) return [`${node.name}: add a prompt.`];
    if (node.type === "formula" && !node.config.expression.trim()) return [`${node.name}: add an expression.`];
    if (node.type === "http" && !node.config.url.trim()) return [`${node.name}: add a URL.`];
    if (node.type === "code" && !node.config.source.trim()) return [`${node.name}: add code.`];
    if (node.type === "condition") {
      if (!node.config.expression.trim()) return [`${node.name}: add at least one complete condition.`];
      const incomplete = node.config.conditions?.some((condition) =>
        !condition.left.trim()
        || (!["is_empty", "is_not_empty"].includes(condition.operator) && !condition.right.trim()),
      );
      if (incomplete) return [`${node.name}: complete every condition.`];
    }
    return [];
  });

const duplicates = (ids: readonly string[]): string[] => {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) out.add(id);
    else seen.add(id);
  }
  return [...out];
};

const visitReachable = (
  starts: readonly string[],
  edges: readonly PipelineEdge[],
  reverse = false,
): Set<string> => {
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    const from = reverse ? edge.target : edge.source;
    const to = reverse ? edge.source : edge.target;
    next.set(from, [...(next.get(from) ?? []), to]);
  }
  const visited = new Set(starts);
  const pending = [...starts];
  while (pending.length > 0) {
    const id = pending.pop() as string;
    for (const target of next.get(id) ?? []) {
      if (!visited.has(target)) {
        visited.add(target);
        pending.push(target);
      }
    }
  }
  return visited;
};

export function topologicalSort(graph: PipelineGraph): readonly string[] | null {
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outbound = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue;
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outbound.set(edge.source, [...(outbound.get(edge.source) ?? []), edge.target]);
  }
  const queue = graph.nodes
    .filter((node) => indegree.get(node.id) === 0)
    .map((node) => node.id);
  const result: string[] = [];
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i] as string;
    result.push(id);
    for (const target of outbound.get(id) ?? []) {
      const next = (indegree.get(target) ?? 1) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }
  return result.length === graph.nodes.length ? result : null;
}

export function validatePipelineGraph(raw: unknown): PipelineValidationResult {
  const parsed = pipelineGraphSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) => ({
        code: "invalid_schema" as const,
        message: `${issue.path.join(".") || "graph"}: ${issue.message}`,
      })),
    };
  }
  const graph = parsed.data as PipelineGraph;
  const issues: PipelineValidationIssue[] = [];
  if (graph.nodes.length > MAX_PIPELINE_NODES) {
    issues.push({ code: "limit_exceeded", message: `A pipeline may contain at most ${MAX_PIPELINE_NODES} nodes.` });
  }
  if (graph.edges.length > MAX_PIPELINE_EDGES) {
    issues.push({ code: "limit_exceeded", message: `A pipeline may contain at most ${MAX_PIPELINE_EDGES} edges.` });
  }
  for (const id of duplicates(graph.nodes.map((node) => node.id))) {
    issues.push({ code: "duplicate_id", nodeId: id, message: `Duplicate node id: ${id}` });
  }
  for (const id of duplicates(graph.edges.map((edge) => edge.id))) {
    issues.push({ code: "duplicate_id", edgeId: id, message: `Duplicate edge id: ${id}` });
  }
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const inbound = new Map<string, PipelineEdge[]>();
  const outbound = new Map<string, PipelineEdge[]>();
  for (const edge of graph.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) {
      issues.push({ code: "missing_endpoint", edgeId: edge.id, message: `Edge ${edge.id} references a missing node.` });
      continue;
    }
    if (edge.source === edge.target) {
      issues.push({ code: "self_edge", edgeId: edge.id, message: `Edge ${edge.id} cannot connect a node to itself.` });
    }
    inbound.set(edge.target, [...(inbound.get(edge.target) ?? []), edge]);
    outbound.set(edge.source, [...(outbound.get(edge.source) ?? []), edge]);
    const source = byId.get(edge.source);
    if (source?.type === "condition") {
      if (edge.sourcePort !== "true" && edge.sourcePort !== "false") {
        issues.push({ code: "invalid_port", edgeId: edge.id, nodeId: source.id, message: "Condition edges must use sourcePort true or false." });
      }
    } else if (edge.sourcePort === "true" || edge.sourcePort === "false") {
      issues.push({ code: "invalid_port", edgeId: edge.id, message: "Only condition nodes may use true/false ports." });
    }
  }

  const inputs = graph.nodes.filter((node) => node.type === "input");
  const outputs = graph.nodes.filter((node) => node.type === "output");
  const terminals = pipelineTerminalOutputs(graph);
  if (inputs.length === 0) issues.push({ code: "invalid_degree", message: "A pipeline requires at least one Input node." });

  for (const node of graph.nodes) {
    const ins = inbound.get(node.id) ?? [];
    const outs = outbound.get(node.id) ?? [];
    if (node.type === "input" && ins.length > 0) {
      issues.push({ code: "invalid_degree", nodeId: node.id, message: "Input nodes cannot have incoming edges." });
    }
    if (node.type === "output" && outs.length > 0) {
      issues.push({ code: "invalid_degree", nodeId: node.id, message: "Output nodes cannot have outgoing edges." });
    }
    if (node.type !== "input" && ins.length === 0) {
      issues.push({ code: "unreachable", nodeId: node.id, message: `${node.name} has no incoming edge.` });
    }
    if (node.type === "condition") {
      for (const port of ["true", "false"] as const) {
        if (outs.filter((edge) => edge.sourcePort === port).length > 1) {
          issues.push({ code: "invalid_degree", nodeId: node.id, message: `A condition may have only one ${port} path.` });
        }
      }
    }
  }

  for (const key of duplicates(inputs.map((node) => node.config.key))) {
    issues.push({ code: "duplicate_key", message: `Duplicate pipeline input key: ${key}` });
  }
  for (const key of duplicates(outputs.map((node) => node.config.key))) {
    issues.push({ code: "duplicate_key", message: `Duplicate pipeline output key: ${key}` });
  }

  const topological = topologicalSort(graph);
  if (topological === null) issues.push({ code: "cycle", message: "Pipeline graphs cannot contain cycles in schema version 1." });

  const fromInputs = visitReachable(inputs.map((node) => node.id), graph.edges);
  const toOutputs = visitReachable(terminals.map(({ node }) => node.id), graph.edges, true);
  for (const node of graph.nodes) {
    if (!fromInputs.has(node.id)) {
      issues.push({ code: "unreachable", nodeId: node.id, message: `${node.name} is not reachable from an Input node.` });
    }
    if (!toOutputs.has(node.id)) {
      issues.push({ code: "dead_end", nodeId: node.id, message: `${node.name} cannot reach the end of a path.` });
    }
  }
  return { valid: issues.length === 0, issues };
}
