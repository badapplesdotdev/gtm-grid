/**
 * Worker endpoint: fetch a table's full grid (worker getTable shape). Replaces
 * `convex/http.ts` `/webhook/getTable`. Secret-gated bearer.
 */

import { WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerSecretOrMember } from "../_lib";

export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return runWorkerSecretOrMember(req, (body: { tableId: string }) =>
    Effect.gen(function* () {
      const svc = yield* WebhookService;
      return yield* svc.getTable(body.tableId);
    }),
  );
}
