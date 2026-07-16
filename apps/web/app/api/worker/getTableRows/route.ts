/**
 * Worker endpoint: a sibling table's rows + cells (columns keyed for name
 * mapping) — the table.lookup read. The gateway memoizes this per run, so a
 * 1,000-row lookup column issues ONE of these, not one per row. Same-project
 * scoping enforced in the service; secret-or-member trust; not metered (reads
 * are never billed).
 */

import { WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerSecretOrMember } from "../_lib";
import { GetTableRowsSchema } from "../_schemas";

export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return runWorkerSecretOrMember(req, GetTableRowsSchema, (body) =>
    Effect.gen(function* () {
      const svc = yield* WebhookService;
      return yield* svc.getTableRowsForActions({
        sourceTableId: body.sourceTableId,
        targetTableId: body.targetTableId,
      });
    }),
  );
}
