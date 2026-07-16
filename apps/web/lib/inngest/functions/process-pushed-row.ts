/**
 * The durable worker behind table.push's `autoRunTarget` (Clay parity: "columns
 * run on new rows"). When a push touches a target row with the toggle on, the
 * `upsertRowInTable` route emits ONE `table/row.pushed` event; this function
 * recomputes the TARGET table's function columns over just that row — the same
 * per-column memoized enrich the webhook lane uses (`runEnrichColumn`), ordered
 * by the `{{ref}}` dependency graph.
 *
 * THE LOOP GUARD (the reason cross-table auto-run is safe to ship): the enrich
 * SKIPS the target's own `table.push` columns. Lookups are read-only and run
 * normally; only push columns can chain A→B→C→A, and skipping them bounds
 * cross-table cascades to depth 1. (A custom-code column calling
 * `sdk.table.push` with autoRunTarget:true is the deliberate power-user escape
 * hatch — replays stay cheap because the enrich skips already-done cells.)
 *
 * Durability mirrors process-webhook-record: the event may carry an
 * idempotency id (deduping far-apart duplicate emissions), and every step key
 * is unique per (event, column) so within-run retries never re-run — or
 * re-charge — an already-completed column.
 */

import { buildColumnDeps, topoSortColumnIds } from "@gtmgrid/services/columns";
import { inngest } from "../client";
import { onFailure } from "../on-failure";
import {
  fetchGridColumns,
  runEnrichColumn,
  toStepRunner,
  type StepRunner,
} from "./process-webhook-record";

/** The `table/row.pushed` event payload `upsertRowInTable` enqueues. */
export interface PushedRowData {
  readonly tableId: string;
  readonly workspaceId: string;
  readonly rowId: string;
  /** The caller-supplied idempotency key, or null (event-id keying only). */
  readonly recordId: string | null;
}

/** Narrow the loosely-typed Inngest payload; throw (→ retry) on malformation. */
export function parsePushedRowData(raw: unknown): PushedRowData {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("table/row.pushed event.data is not an object");
  }
  const d: Record<string, unknown> = { ...raw };
  const str = (k: string): string => {
    const v = d[k];
    if (typeof v !== "string") {
      throw new Error(`table/row.pushed event.data.${k} must be a string`);
    }
    return v;
  };
  return {
    tableId: str("tableId"),
    workspaceId: str("workspaceId"),
    rowId: str("rowId"),
    recordId: typeof d.recordId === "string" ? d.recordId : null,
  };
}

/** The result the handler returns. */
export interface ProcessPushedRowResult {
  readonly rowId: string;
  readonly ran: number;
  readonly skippedPushColumns: number;
}

/**
 * The handler body, extracted for direct testing with a fake {@link StepRunner}
 * (same seam as `processWebhookRecordHandler`). `stepKey` is the per-event
 * memoization prefix — the caller passes `recordId ?? event.id`.
 */
export async function processPushedRowHandler(
  data: PushedRowData,
  stepKey: string,
  step: StepRunner,
): Promise<ProcessPushedRowResult> {
  // 1) Resolve the target's function columns, dependency-ordered, MINUS its
  //    own table.push columns (the cascade bound). Memoized per event.
  const plan = await step.run(`push-enrich-columns:${stepKey}`, async () => {
    const columns = await fetchGridColumns(data.tableId);
    const fnCols = columns.filter((c) => c.kind === "function");
    const skippedPushColumns = fnCols.filter(
      (c) => c.provider === "table" && c.method === "push",
    ).length;
    const runnable = fnCols
      .filter((c) => !(c.provider === "table" && c.method === "push"))
      .map((c) => ({
        id: c._id,
        name: c.name,
        kind: c.kind,
        provider: c.provider,
        params: c.params,
        condition: c.condition,
      }));
    return {
      columnIds: topoSortColumnIds(runnable, buildColumnDeps(runnable)),
      skippedPushColumns,
    };
  });

  // 2) Run each column over JUST the pushed row, one memoized step per column.
  let ran = 0;
  for (const columnId of plan.columnIds) {
    const n = await step.run(`push-enrich:${stepKey}:${columnId}`, async () =>
      runEnrichColumn(
        { tableId: data.tableId, workspaceId: data.workspaceId },
        columnId,
        data.rowId,
      ),
    );
    ran += n;
  }

  return { rowId: data.rowId, ran, skippedPushColumns: plan.skippedPushColumns };
}

export const processPushedRow = inngest.createFunction(
  {
    id: "process-pushed-row",
    // Same two-tier concurrency shape as the webhook enricher: a global
    // account-wide cap plus a per-workspace lane so one busy workspace cannot
    // starve others. Pushed-row enriches share the webhook lane's risk profile
    // (they are the same runEnrichColumn work).
    concurrency: [
      { scope: "account", key: '"push-enrich"', limit: 50 },
      { key: "event.data.workspaceId", limit: 5 },
    ],
    retries: 3,
    onFailure,
    triggers: [{ event: "table/row.pushed" }],
  },
  async ({ event, step }) => {
    const data = parsePushedRowData(event.data);
    return processPushedRowHandler(
      data,
      data.recordId ?? event.id ?? `${data.tableId}:${data.rowId}`,
      toStepRunner(step),
    );
  },
);
