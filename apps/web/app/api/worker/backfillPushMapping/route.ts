/**
 * Worker endpoint: re-apply a push connection's CURRENT mapping to every row
 * that carries a stored raw payload — the "map later, backfill" flow after the
 * user edits the mapping on the TARGET table. A re-projection of already-
 * ingested (already-billed) data: NOT metered. Member-gated on the member path
 * (the service asserts workspace membership).
 */

import { WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerSecretOrMember } from "../_lib";
import { BackfillPushMappingSchema } from "../_schemas";

export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return runWorkerSecretOrMember(req, BackfillPushMappingSchema, (body) =>
    Effect.gen(function* () {
      const svc = yield* WebhookService;
      return yield* svc.backfillPushMapping(body.webhookId);
    }),
  );
}
