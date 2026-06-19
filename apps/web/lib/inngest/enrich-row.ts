import { buildColumnDeps, topoSortColumnIds } from "@gtmgrid/services/columns";
import {
  fetchGrid,
  runEnrichColumn,
  type StepRunner,
} from "./functions/process-webhook-record";

/**
 * Enrich ONE row by running its table's function columns in `{{ref}}` DEPENDENCY
 * order (Get API data → map field → compute value), each in its own durable
 * `step.run` so a mid-loop failure retries only the failed/remaining columns.
 *
 * The dependency-ordered counterpart to the webhook's inline enrichment loop,
 * factored out so the signal enricher (and any future per-row enrichment) gets
 * the same cascade. `keyPrefix` namespaces the step keys per caller/record so
 * Inngest memoizes them independently.
 */
export async function enrichRowInDepOrder(
  step: StepRunner,
  args: {
    readonly tableId: string;
    readonly workspaceId: string;
    readonly rowId: string;
    /** Unique-per-record namespace for the durable step keys. */
    readonly keyPrefix: string;
  },
): Promise<number> {
  const orderedColumnIds = await step.run(`${args.keyPrefix}:columns`, async () => {
    const grid = await fetchGrid(args.tableId);
    const fnCols = grid.columns
      .filter((c) => c.kind === "function")
      .map((c) => ({
        id: c._id,
        name: c.name,
        kind: c.kind,
        provider: c.provider,
        params: c.params,
        condition: c.condition,
      }));
    return topoSortColumnIds(fnCols, buildColumnDeps(fnCols));
  });

  let ran = 0;
  for (const columnId of orderedColumnIds) {
    ran += await step.run(`${args.keyPrefix}:col:${columnId}`, async () =>
      runEnrichColumn({ tableId: args.tableId, workspaceId: args.workspaceId }, columnId, args.rowId),
    );
  }
  return ran;
}
