/**
 * Worker endpoint: upsert a cell (COALESCE merge; meters ONLY on a terminal
 * status). Replaces `convex/http.ts` `/webhook/setCell`. Secret-gated bearer.
 *
 * `value` is COALESCE: its PRESENCE in the body (even `null`) means "overwrite";
 * omitting it keeps the existing value. We forward that presence as `hasValue`.
 */

import { WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerSecretOrMember } from "../_lib";
import { SetCellSchema } from "../_schemas";

export const runtime = "nodejs";
export function POST(req: Request): Promise<Response> {
  return runWorkerSecretOrMember(req, SetCellSchema, (body) =>
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
