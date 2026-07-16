/** Reserved binding key for the one structured result written to a pipeline cell. */
export const PIPELINE_RESULT_OUTPUT_KEY = "__pipeline_result__";

/**
 * Convert named terminal outputs into table cell writes. New bindings always
 * write the complete result object to one pipeline output column. The fallback
 * keeps previously saved per-terminal mappings working until they are resaved.
 */
export function pipelineOutputCellValues(
  outputs: Readonly<Record<string, unknown>>,
  outputMapping: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const structuredOutputColumn = outputMapping[PIPELINE_RESULT_OUTPUT_KEY];
  if (structuredOutputColumn) return { [structuredOutputColumn]: outputs };
  return Object.fromEntries(
    Object.entries(outputMapping).flatMap(([key, columnId]) =>
      outputs[key] === undefined ? [] : [[columnId, outputs[key]]],
    ),
  );
}
