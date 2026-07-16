/**
 * Worker endpoint: resolve a cross-table TARGET (by id or exact name) within
 * the source table's project and return its schema — the table.push /
 * table.lookup gateway's column-name resolution. Returns `null` when the ref
 * doesn't resolve INSIDE the project (a cross-project table is
 * indistinguishable from a missing one — no leak). Not metered.
 */

import { WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerSecretOrMember } from "../_lib";
import { GetTableSchemaSchema } from "../_schemas";

export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return runWorkerSecretOrMember(req, GetTableSchemaSchema, (body) =>
    Effect.gen(function* () {
      const svc = yield* WebhookService;
      return yield* svc.getTableSchemaForActions({
        sourceTableId: body.sourceTableId,
        targetRef: body.targetRef,
      });
    }),
  );
}
