import type { PipelineEdge, PipelineGraph, PipelineNode } from "./types.js";
import { validatePipelineGraph } from "./validate.js";

export type PipelineGraphPatch =
  | { readonly op: "add_node"; readonly node: PipelineNode }
  | { readonly op: "update_node"; readonly nodeId: string; readonly patch: Partial<PipelineNode> }
  | { readonly op: "remove_node"; readonly nodeId: string }
  | { readonly op: "add_edge"; readonly edge: PipelineEdge }
  | { readonly op: "remove_edge"; readonly edgeId: string }
  | { readonly op: "replace_node_edges"; readonly nodeId: string; readonly edges: readonly PipelineEdge[] };

export class PipelinePatchError extends Error {
  constructor(message: string, readonly issues: readonly { readonly message: string }[] = []) {
    super(message);
    this.name = "PipelinePatchError";
  }
}

function mergeNode(node: PipelineNode, patch: Partial<PipelineNode>): PipelineNode {
  const config = "config" in patch && patch.config !== undefined
    ? { ...node.config, ...(patch.config as Record<string, unknown>) }
    : node.config;
  return { ...node, ...patch, config } as PipelineNode;
}

export function applyPipelineGraphPatches(
  graph: PipelineGraph,
  patches: readonly PipelineGraphPatch[],
): PipelineGraph {
  let nodes = [...graph.nodes];
  let edges = [...graph.edges];
  for (const patch of patches) {
    switch (patch.op) {
      case "add_node":
        if (nodes.some((node) => node.id === patch.node.id)) throw new PipelinePatchError(`Node ${patch.node.id} already exists.`);
        nodes.push(patch.node);
        break;
      case "update_node": {
        const index = nodes.findIndex((node) => node.id === patch.nodeId);
        if (index < 0) throw new PipelinePatchError(`Node ${patch.nodeId} does not exist.`);
        nodes[index] = mergeNode(nodes[index] as PipelineNode, patch.patch);
        break;
      }
      case "remove_node":
        if (!nodes.some((node) => node.id === patch.nodeId)) throw new PipelinePatchError(`Node ${patch.nodeId} does not exist.`);
        nodes = nodes.filter((node) => node.id !== patch.nodeId);
        edges = edges.filter((edge) => edge.source !== patch.nodeId && edge.target !== patch.nodeId);
        break;
      case "add_edge":
        if (edges.some((edge) => edge.id === patch.edge.id)) throw new PipelinePatchError(`Edge ${patch.edge.id} already exists.`);
        edges.push(patch.edge);
        break;
      case "remove_edge":
        if (!edges.some((edge) => edge.id === patch.edgeId)) throw new PipelinePatchError(`Edge ${patch.edgeId} does not exist.`);
        edges = edges.filter((edge) => edge.id !== patch.edgeId);
        break;
      case "replace_node_edges":
        if (!nodes.some((node) => node.id === patch.nodeId)) throw new PipelinePatchError(`Node ${patch.nodeId} does not exist.`);
        edges = edges.filter((edge) => edge.source !== patch.nodeId);
        edges.push(...patch.edges);
        break;
    }
  }
  const next: PipelineGraph = { ...graph, nodes, edges };
  const validation = validatePipelineGraph(next);
  if (!validation.valid) throw new PipelinePatchError("The graph patch would create an invalid pipeline.", validation.issues);
  return next;
}
