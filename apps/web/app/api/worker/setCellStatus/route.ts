/**
 * Worker endpoint: set a cell's status only (meters ONLY on a terminal status).
 * Replaces `convex/http.ts` `/webhook/setCellStatus`. Secret-gated bearer.
 */

import { WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerSecretOrMember } from "../_lib";
import { SetCellStatusSchema } from "../_schemas";

export const runtime = "nodejs";
export function POST(req: Request): Promise<Response> {
  return runWorkerSecretOrMember(req, SetCellStatusSchema, (body) =>
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
