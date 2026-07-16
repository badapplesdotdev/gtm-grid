/**
 * Worker endpoint: BATCHED cell upsert — apply an ARRAY of cell writes in one
 * POST (each a COALESCE merge that meters ONLY on a terminal status). The cloud
 * store buffers terminal writes during a column run and flushes them here in
 * chunks (bounded in-flight + backpressure), so a large run is one request per
 * chunk instead of one HTTP POST per cell. Secret-gated bearer.
 *
 * Per cell, `value` is COALESCE: its PRESENCE in the object (even `null`) means
 * "overwrite"; omitting it keeps the existing value. We forward that presence as
 * `hasValue`.
 */

import { PipelineService, WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { inngest } from "../../../../lib/inngest/client";
import { runWorkerSecretOrMember } from "../_lib";
import { SetCellsSchema } from "../_schemas";

export const runtime = "nodejs";
export function POST(req: Request): Promise<Response> {
  return runWorkerSecretOrMember(req, SetCellsSchema, (body) =>
    Effect.gen(function* () {
      const svc = yield* WebhookService;
      const result = yield* svc.setCells({
        cells: (body.cells ?? []).map((c) => ({
          rowId: c.rowId,
          columnId: c.columnId,
          hasValue: "value" in c,
          ...("value" in c ? { value: c.value } : {}),
          ...(c.status !== undefined ? { status: c.status } : {}),
          ...(c.error !== undefined ? { error: c.error } : {}),
        })),
      });
      const byColumn = new Map<string, string[]>();
      for (const cell of body.cells ?? []) {
        if (!("value" in cell) || cell.status !== "done") continue;
        byColumn.set(cell.columnId, [...(byColumn.get(cell.columnId) ?? []), cell.rowId]);
      }
      const pipelines = yield* PipelineService;
      const runGroups = yield* Effect.forEach([...byColumn], ([columnId, rowIds]) => pipelines.createTriggeredRuns({ columnId, rowIds: [...new Set(rowIds)], trigger: "row_updated" }), { concurrency: 10 });
      const runs = runGroups.flat();
      if (runs.length > 0) yield* Effect.tryPromise(() => inngest.send(runs.map((run) => ({ id: `pipeline-run:${run.id}`, name: "pipeline/run.requested" as const, data: { runId: run.id, workspaceId: run.workspaceId } }))));
      return result;
    }),
  );
}
