import { z } from "zod";
import { PIPELINE_SCHEMA_VERSION } from "./types.js";

const position = z.object({ x: z.number().finite(), y: z.number().finite() });
const base = {
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(160),
  description: z.string().max(2_000).optional(),
  position,
  onError: z.enum(["abort", "continue"]).optional(),
};
const valueType = z
  .enum(["any", "string", "number", "boolean", "object", "array"])
  .optional();
const binding = z.string().min(1).max(160).optional();

export const pipelineNodeSchema = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("input"),
    config: z.object({
      key: z.string().min(1).max(160),
      valueType,
      required: z.boolean().optional(),
      sample: z.unknown().optional(),
    }),
  }),
  z.object({
    ...base,
    type: z.literal("tool"),
    config: z.object({
      provider: z.string().min(1).max(160),
      method: z.string().min(1).max(160),
      params: z.record(z.unknown()),
      credentialBinding: binding,
    }),
  }),
  z.object({
    ...base,
    type: z.literal("ai"),
    config: z.object({
      provider: z.string().min(1).max(160).optional(),
      model: z.string().min(1).max(160).optional(),
      prompt: z.string(),
      system: z.string().optional(),
      responseFormat: z.enum(["text", "json"]).optional(),
      credentialBinding: binding,
    }),
  }),
  z.object({
    ...base,
    type: z.literal("formula"),
    config: z.object({ expression: z.string() }),
  }),
  z.object({
    ...base,
    type: z.literal("http"),
    config: z.object({
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      url: z.string(),
      headers: z.record(z.string()).optional(),
      body: z.unknown().optional(),
      credentialBinding: binding,
    }),
  }),
  z.object({
    ...base,
    type: z.literal("code"),
    config: z.object({ source: z.string() }),
  }),
  z.object({
    ...base,
    type: z.literal("condition"),
    config: z.object({
      expression: z.string(),
      match: z.enum(["all", "any"]).optional(),
      conditions: z.array(z.object({
        id: z.string().min(1).max(128),
        left: z.string(),
        operator: z.enum(["equals", "not_equals", "contains", "not_contains", "starts_with", "ends_with", "greater_than", "less_than", "is_empty", "is_not_empty"]),
        right: z.string(),
        valueType: z.enum(["string", "number", "boolean", "date"]),
      })).optional(),
    }),
  }),
  z.object({
    ...base,
    type: z.literal("output"),
    config: z.object({ key: z.string().min(1).max(160), valueType }),
  }),
  z.object({
    ...base,
    type: z.literal("pipeline"),
    config: z.object({
      pipelineId: z.string().min(1),
      versionId: z.string().min(1),
      inputMapping: z.record(z.unknown()),
    }),
  }),
]);

export const pipelineEdgeSchema = z.object({
  id: z.string().min(1).max(128),
  source: z.string().min(1).max(128),
  target: z.string().min(1).max(128),
  sourcePort: z.string().min(1).max(128).optional(),
  targetPort: z.string().min(1).max(128).optional(),
});

export const pipelineGraphSchema = z.object({
  schemaVersion: z.literal(PIPELINE_SCHEMA_VERSION),
  nodes: z.array(pipelineNodeSchema),
  edges: z.array(pipelineEdgeSchema),
});

/** Runtime schema for the small, atomic graph edits accepted by APIs and AI. */
export const pipelineGraphPatchSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_node"), node: pipelineNodeSchema }),
  z.object({
    op: z.literal("update_node"),
    nodeId: z.string().min(1).max(128),
    /** The final node is revalidated after the deep merge. */
    patch: z.record(z.unknown()),
  }),
  z.object({ op: z.literal("remove_node"), nodeId: z.string().min(1).max(128) }),
  z.object({ op: z.literal("add_edge"), edge: pipelineEdgeSchema }),
  z.object({ op: z.literal("remove_edge"), edgeId: z.string().min(1).max(128) }),
  z.object({
    op: z.literal("replace_node_edges"),
    nodeId: z.string().min(1).max(128),
    edges: z.array(pipelineEdgeSchema),
  }),
]);
