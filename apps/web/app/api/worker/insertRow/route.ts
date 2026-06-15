/**
 * Worker endpoint: insert ONE received record as a row + cells (metered once per
 * record). Replaces `convex/http.ts` `/webhook/insertRow`. Secret-gated bearer.
 */

import { WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorker } from "../_lib";
import { InsertRowSchema } from "../_schemas";

export const runtime = "nodejs";
export function POST(req: Request): Promise<Response> {
  return runWorker(req, InsertRowSchema, (body) =>
    Effect.gen(function* () {
      const svc = yield* WebhookService;
      return yield* svc.insertRow({
        webhookId: body.webhookId,
        cells: body.cells,
        ...(body.recordId !== undefined ? { recordId: body.recordId } : {}),
      });
    }),
  );
}
