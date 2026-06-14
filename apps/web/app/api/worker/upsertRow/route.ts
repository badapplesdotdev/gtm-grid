/**
 * Worker endpoint: UPSERT ONE received record (server-side match on the upsert
 * key, patch-or-insert cells, metered once per record — never per cell).
 * Replaces `convex/http.ts` `/webhook/upsertRow`. Secret-gated bearer.
 */

import { WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorker } from "../_lib";
import { UpsertRowSchema } from "../_schemas";

export const runtime = "nodejs";
export function POST(req: Request): Promise<Response> {
  return runWorker(req, UpsertRowSchema, (body) =>
    Effect.gen(function* () {
      const svc = yield* WebhookService;
      return yield* svc.upsertRow({
        webhookId: body.webhookId,
        upsertKey: body.upsertKey,
        cells: body.cells,
        ...(body.recordId !== undefined ? { recordId: body.recordId } : {}),
      });
    }),
  );
}
