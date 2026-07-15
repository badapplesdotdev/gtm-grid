export const DEFAULT_PIPELINE_BATCH_SIZE = 250;
export const MAX_PIPELINE_BATCH_SIZE = 1_000;

/**
 * An explicit run selection stores its row ids inline in a single jsonb column
 * (`pipeline_runs.selection`). Cap how many ids land in one run so that column
 * can never bloat unbounded; a larger trigger batch is split across several
 * bounded runs that together still cover every row. ~5k uuids ≈ under 200 KB.
 */
export const MAX_PIPELINE_SELECTION_ROWS = 5_000;

/** Split a row-id list into windows no larger than {@link MAX_PIPELINE_SELECTION_ROWS}
 * (or `size`). Empty input yields no windows; a within-cap list yields one. */
export function chunkPipelineSelection<T>(
  rowIds: readonly T[],
  size = MAX_PIPELINE_SELECTION_ROWS,
): readonly (readonly T[])[] {
  const limit = Math.max(1, Math.floor(size));
  if (rowIds.length === 0) return [];
  if (rowIds.length <= limit) return [rowIds];
  const chunks: (readonly T[])[] = [];
  for (let offset = 0; offset < rowIds.length; offset += limit) {
    chunks.push(rowIds.slice(offset, offset + limit));
  }
  return chunks;
}

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
