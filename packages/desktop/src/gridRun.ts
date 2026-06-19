/**
 * Cascade-aware grid run orchestration (TRI column-data cascade).
 *
 * Pure, React-free helpers that decide WHICH columns to run and in WHAT ORDER,
 * delegating the actual run to a caller-supplied `runOne`. CloudGrid wires
 * `runOne` to the sidecar (`runCloudColumn` + the header spinner); these helpers
 * own the dependency logic so it can be verified EXACTLY (order + scoping) without
 * rendering the grid.
 *
 * `runOne(columnId, { force, rowIds })` runs one column over `rowIds` (all rows
 * when omitted); `force` re-runs already-`done` cells. Built on the shared
 * dependency primitives in `@gtmgrid/services/columns`.
 */

import {
  buildColumnDeps,
  type MinimalColumn,
  runColumnsWithDeps,
  transitiveDependents,
} from "@gtmgrid/services/columns";

/** Runs one column over a row scope; `force` recomputes already-done cells. */
export type RunOne = (
  columnId: string,
  opts: { force: boolean; rowIds?: string[] },
) => Promise<void>;

/**
 * The data cascade: after `seedColumnIds` produced data for `rowIds`, run every
 * column DOWNSTREAM of them (their transitive dependents) for the SAME rows, with
 * `force: true` because their input just changed. Dependency-ordered — independent
 * siblings run in parallel (up to `concurrency`), a dependent only after the
 * in-set columns it reads. The seeds themselves are never re-run. No-op when the
 * seeds have no dependents.
 */
export async function cascadeDependents(
  seedColumnIds: readonly string[],
  functionColumns: readonly MinimalColumn[],
  rowIds: string[] | undefined,
  concurrency: number,
  runOne: RunOne,
): Promise<void> {
  const dependentIds = transitiveDependents(seedColumnIds, functionColumns);
  if (dependentIds.size === 0) return;
  const subset = functionColumns.filter((c) => dependentIds.has(c.id));
  await runColumnsWithDeps(subset, buildColumnDeps(subset), concurrency, (col) =>
    runOne(col.id, { force: true, rowIds }),
  );
}

/**
 * Run every function column in DEPENDENCY order (independent columns in parallel,
 * dependents after their sources). The cascade-aware "Run all" / "Run selected
 * rows": ordering IS the cascade, so no separate downstream pass is needed.
 */
export async function runColumnsInDepOrder(
  functionColumns: readonly MinimalColumn[],
  rowIds: string[] | undefined,
  concurrency: number,
  runOne: RunOne,
  force: boolean,
): Promise<void> {
  await runColumnsWithDeps(
    functionColumns,
    buildColumnDeps(functionColumns),
    concurrency,
    (col) => runOne(col.id, { force, rowIds }),
  );
}
