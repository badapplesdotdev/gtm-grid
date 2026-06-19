/**
 * Worker endpoint: fetch the grid scoped to a SPECIFIC set of rows (worker
 * getTable shape). All columns plus only the requested rows and their cells —
 * bounded by `rowIds.length`, never the whole table. Used by the engine's
 * row-scoped run and the webhook single-row enricher so neither loads a 50k-row
 * grid to touch a handful of rows. Secret-gated bearer.
 */

import { WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerSecretOrMember } from "../_lib";
import { GetTableForRowsSchema } from "../_schemas";

export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return runWorkerSecretOrMember(req, GetTableForRowsSchema, (body) =>
    Effect.gen(function* () {
      const svc = yield* WebhookService;
      return yield* svc.getTableForRows(body.tableId, body.rowIds);
    }),
  );
}
