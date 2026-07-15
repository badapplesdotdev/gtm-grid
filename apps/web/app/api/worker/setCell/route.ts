/**
 * Worker endpoint: upsert a cell (COALESCE merge; meters ONLY on a terminal
 * status). Replaces `convex/http.ts` `/webhook/setCell`. Secret-gated bearer.
 *
 * `value` is COALESCE: its PRESENCE in the body (even `null`) means "overwrite";
 * omitting it keeps the existing value. We forward that presence as `hasValue`.
 */

import { PipelineService, WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { inngest } from "../../../../lib/inngest/client";
import { runWorkerSecretOrMember } from "../_lib";
import { SetCellSchema } from "../_schemas";

export const runtime = "nodejs";
export function POST(req: Request): Promise<Response> {
  return runWorkerSecretOrMember(req, SetCellSchema, (body) =>
    Effect.gen(function* () {
      const svc = yield* WebhookService;
      const result = yield* svc.setCell({
        rowId: body.rowId,
        columnId: body.columnId,
        hasValue: "value" in body,
        ...("value" in body ? { value: body.value } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.error !== undefined ? { error: body.error } : {}),
      });
      if (!("value" in body) || body.status !== "done") return result;
      const pipelines = yield* PipelineService;
      const runs = yield* pipelines.createTriggeredRuns({ columnId: body.columnId, rowIds: [body.rowId], trigger: "row_updated" });
      if (runs.length > 0) yield* Effect.tryPromise(() => inngest.send(runs.map((run) => ({ id: `pipeline-run:${run.id}`, name: "pipeline/run.requested" as const, data: { runId: run.id, workspaceId: run.workspaceId } }))));
      return result;
    }),
  );
}
