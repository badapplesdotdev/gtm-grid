import { PIPELINE_SCHEMA_VERSION, type PipelineGraph } from "@gtmgrid/pipelines";
import { describe, expect, it } from "vitest";
import { reconstructPipelineNodeInputs } from "./pipeline-run-details.js";

const graph: PipelineGraph = {
  schemaVersion: PIPELINE_SCHEMA_VERSION,
  nodes: [
    { id: "input", type: "input", name: "Record", position: { x: 0, y: 0 }, config: { key: "record", required: true } },
    { id: "ai", type: "ai", name: "AI 1", position: { x: 1, y: 0 }, config: { provider: "anthropic", model: "m", prompt: "p", responseFormat: "text" } },
    { id: "if", type: "condition", name: "IF", position: { x: 2, y: 0 }, config: { expression: "true" } },
    { id: "yes", type: "formula", name: "Yes", position: { x: 3, y: 0 }, config: { expression: "1" } },
    { id: "no", type: "formula", name: "No", position: { x: 3, y: 1 }, config: { expression: "0" } },
  ],
  edges: [
    { id: "a", source: "input", target: "ai" },
    { id: "b", source: "ai", target: "if" },
    { id: "c", source: "if", target: "yes", sourcePort: "true" },
    { id: "d", source: "if", target: "no", sourcePort: "false" },
  ],
};

describe("reconstructPipelineNodeInputs", () => {
  it("uses one root input and upstream outputs while respecting the active IF branch", () => {
    const records = reconstructPipelineNodeInputs(graph, [
      { nodeId: "input", rowId: "row", status: "succeeded", inputData: { record: "hello" }, outputData: "hello" },
      { nodeId: "ai", rowId: "row", status: "succeeded", inputData: null, outputData: "bonjour" },
      { nodeId: "if", rowId: "row", status: "succeeded", inputData: null, outputData: true },
      { nodeId: "yes", rowId: "row", status: "succeeded", inputData: null, outputData: "ok" },
      { nodeId: "no", rowId: "row", status: "skipped", inputData: null, outputData: null },
    ]);
    expect(records.find((record) => record.nodeId === "ai")?.inputData).toEqual({ input: "hello" });
    expect(records.find((record) => record.nodeId === "if")?.inputData).toEqual({ ai: "bonjour" });
    expect(records.find((record) => record.nodeId === "yes")?.inputData).toEqual({ if: true });
    expect(records.find((record) => record.nodeId === "no")?.inputData).toBeNull();
  });
});
