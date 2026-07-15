export const DEFAULT_PIPELINE_BATCH_SIZE = 250;
export const MAX_PIPELINE_BATCH_SIZE = 1_000;

export interface PipelineBatchWindow {
  readonly ordinal: number;
  readonly offset: number;
  readonly limit: number;
}
/**
 * Produce bounded execution windows without allocating one item per record.
 * A million-row run therefore creates 4,000 descriptors at the default size,
 * while every worker still holds at most one batch in memory.
 */
export function planPipelineBatchWindows(
  totalRecords: number,
  requestedBatchSize = DEFAULT_PIPELINE_BATCH_SIZE,
): readonly PipelineBatchWindow[] {
  const total = Math.max(0, Math.floor(totalRecords));
  const batchSize = Math.min(
    MAX_PIPELINE_BATCH_SIZE,
    Math.max(1, Math.floor(requestedBatchSize)),
  );
  const count = Math.ceil(total / batchSize);
  return Array.from({ length: count }, (_, ordinal) => ({
    ordinal,
    offset: ordinal * batchSize,
    limit: Math.min(batchSize, total - ordinal * batchSize),
  }));
}
