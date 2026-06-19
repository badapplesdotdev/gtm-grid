/**
 * Worker endpoint: fetch ONE keyset page of a table's grid (worker getTable
 * shape + `nextCursor`). All columns plus only this page's rows and their cells;
 * `nextCursor` is `null` on the last page. The engine walks these pages for a
 * full-column run so resident memory stays bounded to one page instead of the
 * whole 50k-row grid. Secret-gated bearer.
 */

import { WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerSecretOrMember } from "../_lib";
import { GetTablePageSchema } from "../_schemas";

export const runtime = "nodejs";

/** Default rows per page when the caller doesn't specify a limit. */
const WORKER_ROW_PAGE_SIZE = 200;

export function POST(req: Request): Promise<Response> {
  return runWorkerSecretOrMember(req, GetTablePageSchema, (body) =>
    Effect.gen(function* () {
      const svc = yield* WebhookService;
      return yield* svc.getTablePage({
        tableId: body.tableId,
        cursor: body.cursor ?? null,
        limit: body.limit ?? WORKER_ROW_PAGE_SIZE,
      });
    }),
  );
}
