import type { PipelineGraph } from "@gtmgrid/pipelines";

type NodeRunRecord = {
  readonly nodeId: string;
  readonly rowId: string;
  readonly status: string;
  readonly error?: string | null;
  readonly inputData?: unknown;
  readonly outputData?: unknown;
  readonly [key: string]: unknown;
};

/** Rebuild per-node inputs from the graph and the one stored output per upstream
 * node. Older records that already contain inputData remain unchanged. */
export function reconstructPipelineNodeInputs(
  graph: PipelineGraph,
  records: readonly NodeRunRecord[],
): readonly NodeRunRecord[] {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const recordByRowNode = new Map<string, NodeRunRecord>();
  for (const record of records) {
    const key = `${record.rowId}:${record.nodeId}`;
    if (!recordByRowNode.has(key)) recordByRowNode.set(key, record);
  }

  return records.map((record) => {
    if (record.inputData !== null && record.inputData !== undefined) return record;
    const node = nodeById.get(record.nodeId);
    if (node === undefined || node.type === "input" || record.status === "skipped") return record;
    const inputEntries: Array<[string, unknown]> = [];
    for (const edge of graph.edges.filter((candidate) => candidate.target === node.id)) {
      const source = recordByRowNode.get(`${record.rowId}:${edge.source}`);
      if (source === undefined || source.status === "skipped" || source.status === "running") continue;
      const sourceNode = nodeById.get(edge.source);
      if (sourceNode?.type === "condition" && edge.sourcePort !== undefined) {
        const branch = source.outputData ? "true" : "false";
        if (edge.sourcePort !== branch) continue;
      }
      const value = source.status === "failed"
        ? { error: source.error ?? "Upstream node failed." }
        : source.outputData;
      inputEntries.push([edge.targetPort ?? edge.source, value]);
    }
    return inputEntries.length === 0 ? record : { ...record, inputData: Object.fromEntries(inputEntries) };
  });
}
