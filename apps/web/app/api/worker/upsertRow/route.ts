/**
 * Worker endpoint: UPSERT ONE received record (server-side match on the upsert
 * key, patch-or-insert cells, metered once per record — never per cell).
 * Replaces `convex/http.ts` `/webhook/upsertRow`. Secret-gated bearer.
 */

import { type CellMap, WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorker } from "../_lib";

export const runtime = "nodejs";

interface UpsertRowBody {
  webhookId: string;
  upsertKey: string;
  cells: CellMap;
  recordId?: string;
}

export function POST(req: Request): Promise<Response> {
  return runWorker(req, (body: UpsertRowBody) =>
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
