/**
 * Worker endpoint: set a cell's status only (meters ONLY on a terminal status).
 * Replaces `convex/http.ts` `/webhook/setCellStatus`. Secret-gated bearer.
 */

import { type CloudCellStatus, WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorker } from "../_lib";

export const runtime = "nodejs";

interface SetCellStatusBody {
  rowId: string;
  columnId: string;
  status: CloudCellStatus;
  error?: string | null;
}

export function POST(req: Request): Promise<Response> {
  return runWorker(req, (body: SetCellStatusBody) =>
    Effect.gen(function* () {
      const svc = yield* WebhookService;
      return yield* svc.setCellStatus({
        rowId: body.rowId,
        columnId: body.columnId,
        status: body.status,
        ...(body.error !== undefined ? { error: body.error } : {}),
      });
    }),
  );
}
