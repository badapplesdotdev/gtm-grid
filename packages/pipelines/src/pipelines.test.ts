import { describe, expect, it } from "vitest";
import {
  PIPELINE_SCHEMA_VERSION,
  PIPELINE_RESULT_OUTPUT_KEY,
  PipelineCompileError,
  applyPipelineGraphPatches,
  chunkPipelineSelection,
  compilePipeline,
  planPipelineBatchWindows,
  pipelineColumnVariables,
  pipelineOutputCellValues,
  pipelineConfigurationIssues,
  pipelineTemplateText,
  runPipelineRecord,
  validatePipelineGraph,
  type PipelineActionReceipt,
  type PipelineGraph,
  type PipelineNodeExecutor,
} from "./index.js";

const graph = (): PipelineGraph => ({
  schemaVersion: PIPELINE_SCHEMA_VERSION,
  nodes: [
    { id: "input", type: "input", name: "Company", position: { x: 0, y: 0 }, config: { key: "company", required: true } },
    { id: "enrich", type: "tool", name: "Enrich", position: { x: 200, y: 0 }, config: { provider: "test", method: "enrich", params: {} } },
    { id: "condition", type: "condition", name: "Qualified?", position: { x: 400, y: 0 }, config: { expression: "score > 50" } },
    { id: "good", type: "formula", name: "Qualified label", position: { x: 600, y: -80 }, config: { expression: "'yes'" } },
    { id: "bad", type: "formula", name: "Unqualified label", position: { x: 600, y: 80 }, config: { expression: "'no'" } },
    { id: "output-good", type: "output", name: "Qualified output", position: { x: 800, y: -80 }, config: { key: "qualified" } },
    { id: "output-bad", type: "output", name: "Unqualified output", position: { x: 800, y: 80 }, config: { key: "unqualified" } },
  ],
  edges: [
    { id: "e1", source: "input", target: "enrich" },
    { id: "e2", source: "enrich", target: "condition" },
    { id: "e3", source: "condition", target: "good", sourcePort: "true" },
    { id: "e4", source: "condition", target: "bad", sourcePort: "false" },
    { id: "e5", source: "good", target: "output-good" },
    { id: "e6", source: "bad", target: "output-bad" },
  ],
});

describe("pipeline graph contract", () => {
  it("creates readable and collision-safe variables for attached table columns", () => {
    expect(pipelineColumnVariables([
      { id: "col-company", name: "Company Name" },
      { id: "col-domain", name: "Domain" },
      { id: "col-company-2", name: "Company Name" },
    ])).toEqual([
      { columnId: "col-company", name: "Company Name", key: "company_name" },
      { columnId: "col-domain", name: "Domain", key: "domain" },
      { columnId: "col-company-2", name: "Company Name", key: "company_name_2" },
    ]);
  });

  it("validates and compiles a branched DAG", () => {
    expect(validatePipelineGraph(graph())).toEqual({ valid: true, issues: [] });
    const compiled = compilePipeline(graph());
    expect(compiled.topologicalNodeIds[0]).toBe("input");
    expect(compiled.actionEstimate).toMatchObject({ minimumPerRecord: 2, maximumPerRecord: 4 });
    expect(compiled.graphHash).toHaveLength(64);
  });

  it("allows an IF to have only the branch the user connected", () => {
    const complete = graph();
    const oneBranch: PipelineGraph = {
      ...complete,
      edges: complete.edges.filter((edge) => edge.sourcePort !== "false" && edge.source !== "bad"),
      nodes: complete.nodes.filter((node) => node.id !== "bad" && node.id !== "output-bad"),
    };
    expect(validatePipelineGraph(oneBranch)).toEqual({ valid: true, issues: [] });
    expect(oneBranch.edges.filter((edge) => edge.source === "condition")).toEqual([
      expect.objectContaining({ target: "good", sourcePort: "true" }),
    ]);
  });

  it("rejects cycles and malformed condition ports", () => {
    const invalid: PipelineGraph = {
      ...graph(),
      edges: [
        ...graph().edges,
        { id: "cycle", source: "good", target: "condition" },
      ],
    };
    const result = validatePipelineGraph(invalid);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "cycle")).toBe(true);
    expect(() => compilePipeline(invalid)).toThrow(PipelineCompileError);
  });

  it("applies graph patches atomically and allows a path to end at its last action", () => {
    const renamed = applyPipelineGraphPatches(graph(), [
      { op: "update_node", nodeId: "enrich", patch: { name: "Research company" } },
    ]);
    expect(renamed.nodes.find((node) => node.id === "enrich")?.name).toBe("Research company");
    const withoutOutput = applyPipelineGraphPatches(graph(), [{ op: "remove_node", nodeId: "output-good" }]);
    expect(validatePipelineGraph(withoutOutput).valid).toBe(true);
    expect(withoutOutput.nodes.some((node) => node.id === "output-good")).toBe(false);
  });

  it("allows empty draft fields but reports them as incomplete for deployment", () => {
    const draft = applyPipelineGraphPatches(graph(), [
      { op: "update_node", nodeId: "good", patch: { config: { expression: "" } } },
    ]);
    expect(validatePipelineGraph(draft).valid).toBe(true);
    expect(pipelineConfigurationIssues(draft)).toContain("Qualified label: add an expression.");
  });
});

describe("pipeline batch planning", () => {
  it("keeps a million-record run bounded and covers every record once", () => {
    const windows = planPipelineBatchWindows(1_000_000, 250);
    expect(windows).toHaveLength(4_000);
    expect(windows[0]).toEqual({ ordinal: 0, offset: 0, limit: 250 });
    expect(windows.at(-1)).toEqual({ ordinal: 3_999, offset: 999_750, limit: 250 });
    expect(windows.reduce((sum, window) => sum + window.limit, 0)).toBe(1_000_000);
  });

  it("clamps invalid and oversized batch sizes", () => {
    expect(planPipelineBatchWindows(3, 0)).toHaveLength(3);
    expect(planPipelineBatchWindows(1_001, 50_000)).toHaveLength(2);
  });

  it("caps an explicit selection into bounded, exhaustive, non-overlapping windows", () => {
    expect(chunkPipelineSelection([], 3)).toEqual([]);
    expect(chunkPipelineSelection(["a", "b"], 5)).toEqual([["a", "b"]]);
    const ids = Array.from({ length: 12_000 }, (_, i) => `row-${i}`);
    const chunks = chunkPipelineSelection(ids); // default 5_000
    expect(chunks.map((c) => c.length)).toEqual([5_000, 5_000, 2_000]);
    expect(chunks.flat()).toEqual(ids); // covers every row exactly once, in order
    expect(chunks.every((c) => c.length <= 5_000)).toBe(true);
  });
});

describe("pipeline table output", () => {
  it("uses readable terminal node names for structured output keys", async () => {
    const withoutExplicitOutputs: PipelineGraph = {
      ...graph(),
      nodes: graph().nodes.filter((node) => node.type !== "output"),
      edges: graph().edges.filter((edge) => !edge.target.startsWith("output-")),
    };
    const result = await runPipelineRecord(compilePipeline(withoutExplicitOutputs), {
      runId: "run",
      rowId: "row",
      target: "local",
      input: { company: "Acme" },
      executor: {
        execute: async ({ node }) => ({
          output: node.type === "condition" ? true : node.name,
          ...(node.type === "condition" ? { branch: "true" as const } : {}),
        }),
      },
    });
    expect(result.outputs).toEqual({
      "Enrich": "Enrich",
      "Qualified?": true,
      "Qualified label": "Qualified label",
    });
  });

  it("stores every named result together in one structured pipeline cell", () => {
    expect(pipelineOutputCellValues(
      { french: "bonjour", confidence: 0.98 },
      { [PIPELINE_RESULT_OUTPUT_KEY]: "pipeline-column" },
    )).toEqual({
      "pipeline-column": { french: "bonjour", confidence: 0.98 },
    });
  });

  it("keeps legacy per-output bindings readable", () => {
    expect(pipelineOutputCellValues(
      { french: "bonjour", confidence: 0.98 },
      { french: "translation-column" },
    )).toEqual({ "translation-column": "bonjour" });
  });
});

describe("pipeline AI template text", () => {
  it("keeps variable-only prompts string-safe", () => {
    expect(pipelineTemplateText("hello")).toBe("hello");
    expect(pipelineTemplateText(42)).toBe("42");
    expect(pipelineTemplateText(false)).toBe("false");
    expect(pipelineTemplateText({ company: "Acme" })).toBe('{"company":"Acme"}');
    expect(pipelineTemplateText(undefined)).toBe("");
  });
});

describe("pipeline runner", () => {
  const executor: PipelineNodeExecutor = {
    execute: async ({ node }) => {
      if (node.id === "enrich") return { output: { score: 90 } };
      if (node.id === "condition") return { output: true, branch: "true" };
      if (node.id === "good") return { output: "yes" };
      if (node.id === "bad") return { output: "no" };
      throw new Error(`Unexpected node ${node.id}`);
    },
  };

  it("runs only the active branch and charges each cloud executable node once", async () => {
    const receipts: PipelineActionReceipt[] = [];
    const seen = new Set<string>();
    const result = await runPipelineRecord(compilePipeline(graph()), {
      runId: "run-1",
      rowId: "row-1",
      target: "cloud",
      input: { company: "Acme" },
      executor,
      actionSink: {
        consume: async (receipt) => {
          receipts.push(receipt);
          const fresh = !seen.has(receipt.key);
          seen.add(receipt.key);
          return fresh;
        },
      },
      now: (() => { let n = 0; return () => ++n; })(),
    });
    expect(result.status).toBe("succeeded");
    expect(result.outputs).toEqual({
      Enrich: { score: 90 },
      "Qualified?": true,
      "Qualified label": "yes",
      qualified: "yes",
    });
    expect(result.outputs).not.toHaveProperty("Unqualified label");
    expect(result.outputs).not.toHaveProperty("unqualified");
    expect(result.actionsConsumed).toBe(3);
    expect(result.traces.find((trace) => trace.nodeId === "bad")?.status).toBe("skipped");
    expect(result.traces.find((trace) => trace.nodeId === "output-bad")?.status).toBe("skipped");
    expect(receipts.map((receipt) => receipt.nodeId)).toEqual(["enrich", "condition", "good"]);
  });

  it("does not consume cloud actions for a local run", async () => {
    let calls = 0;
    const result = await runPipelineRecord(compilePipeline(graph()), {
      runId: "run-local",
      rowId: "row-1",
      target: "local",
      input: { company: "Acme" },
      executor,
      actionSink: { consume: async () => { calls += 1; return true; } },
    });
    expect(result.actionsConsumed).toBe(0);
    expect(calls).toBe(0);
  });

  it("streams running and terminal node events with inspectable input and output", async () => {
    const progress: Array<{ nodeId: string; status: string; input?: unknown; output?: unknown }> = [];
    await runPipelineRecord(compilePipeline(graph()), {
      runId: "live-run",
      rowId: "row-1",
      target: "cloud",
      input: { company: "Acme" },
      executor,
      onNodeProgress: async (event) => { progress.push(event); },
    });
    expect(progress.slice(0, 4).map(({ nodeId, status }) => `${nodeId}:${status}`)).toEqual([
      "input:running",
      "input:succeeded",
      "enrich:running",
      "enrich:succeeded",
    ]);
    expect(progress[0]?.input).toEqual({ company: "Acme" });
    expect(progress.find((event) => event.nodeId === "enrich" && event.status === "succeeded")).toMatchObject({
      input: { input: "Acme" },
      output: { score: 90 },
    });
  });

  it("fans one node out to multiple paths and executes a shared downstream node only once", async () => {
    const forked: PipelineGraph = {
      schemaVersion: PIPELINE_SCHEMA_VERSION,
      nodes: [
        { id: "input", type: "input", name: "Record", position: { x: 0, y: 0 }, config: { key: "record", required: true } },
        { id: "source", type: "formula", name: "Source", position: { x: 200, y: 0 }, config: { expression: "record" } },
        { id: "left", type: "formula", name: "Left", position: { x: 400, y: -80 }, config: { expression: "'left'" } },
        { id: "right", type: "formula", name: "Right", position: { x: 400, y: 80 }, config: { expression: "'right'" } },
        { id: "merge", type: "formula", name: "Merge", position: { x: 600, y: 0 }, config: { expression: "'done'" } },
      ],
      edges: [
        { id: "in", source: "input", target: "source" },
        { id: "fork-left", source: "source", target: "left" },
        { id: "fork-right", source: "source", target: "right" },
        { id: "merge-left", source: "left", target: "merge" },
        { id: "merge-right", source: "right", target: "merge" },
      ],
    };
    const calls: string[] = [];
    const result = await runPipelineRecord(compilePipeline(forked), {
      runId: "forked",
      rowId: "row",
      target: "cloud",
      input: { record: "Acme" },
      executor: { execute: async ({ node }) => { calls.push(node.id); return { output: node.id }; } },
    });
    expect(validatePipelineGraph(forked)).toEqual({ valid: true, issues: [] });
    expect(calls).toEqual(["source", "left", "right", "merge"]);
    expect(result.actionsConsumed).toBe(4);
    expect(result.outputs).toEqual({ Source: "source", Left: "left", Right: "right", Merge: "merge" });
  });

  it("does not double-consume an idempotent receipt on retry", async () => {
    const seen = new Set<string>();
    const sink = {
      consume: async (receipt: PipelineActionReceipt) => {
        const fresh = !seen.has(receipt.key);
        seen.add(receipt.key);
        return fresh;
      },
    };
    const options = { runId: "retry", rowId: "row", target: "cloud" as const, input: { company: "Acme" }, executor, actionSink: sink };
    expect((await runPipelineRecord(compilePipeline(graph()), options)).actionsConsumed).toBe(3);
    expect((await runPipelineRecord(compilePipeline(graph()), options)).actionsConsumed).toBe(0);
  });
});
