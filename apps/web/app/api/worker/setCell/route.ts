/**
 * Worker endpoint: upsert a cell (COALESCE merge; meters ONLY on a terminal
 * status). Replaces `convex/http.ts` `/webhook/setCell`. Secret-gated bearer.
 *
 * `value` is COALESCE: its PRESENCE in the body (even `null`) means "overwrite";
 * omitting it keeps the existing value. We forward that presence as `hasValue`.
 */

import { type CloudCellStatus, WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorker } from "../_lib";

export const runtime = "nodejs";

interface SetCellBody {
  rowId: string;
  columnId: string;
  value?: unknown;
  status?: CloudCellStatus;
  error?: string | null;
}

export function POST(req: Request): Promise<Response> {
  return runWorker(req, (body: SetCellBody) =>
    Effect.gen(function* () {
      const svc = yield* WebhookService;
      return yield* svc.setCell({
        rowId: body.rowId,
        columnId: body.columnId,
        hasValue: "value" in body,
        ...("value" in body ? { value: body.value } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.error !== undefined ? { error: body.error } : {}),
      });
    }),
  );
}
