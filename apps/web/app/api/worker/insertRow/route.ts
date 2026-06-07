/**
 * Worker endpoint: insert ONE received record as a row + cells (metered once per
 * record). Replaces `convex/http.ts` `/webhook/insertRow`. Secret-gated bearer.
 */

import { type CellMap, WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorker } from "../_lib";

export const runtime = "nodejs";

interface InsertRowBody {
  webhookId: string;
  cells: CellMap;
  recordId?: string;
}

export function POST(req: Request): Promise<Response> {
  return runWorker(req, (body: InsertRowBody) =>
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
