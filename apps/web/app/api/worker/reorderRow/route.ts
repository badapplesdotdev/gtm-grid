/**
 * Worker endpoint: move a row to a new display index on a CLOUD table (the
 * agent's `reorder_rows` tool in cloud mode).
 *
 * Member-attributed + metered: `GridService.reorderRow` resolves the row's
 * workspace, asserts the `X-Gtmgrid-Member` user is a member with cloud access
 * (fail-closed: 401/403/402), reindexes the table's rows (writing only those
 * whose position changes), meters ONE cloud action, and broadcasts a
 * `row.reorder` with the full new id order. Returns that order.
 */

import { GridService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerAsMember } from "../_lib";
import { ReorderRowSchema } from "../_schemas";

export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return runWorkerAsMember(req, ReorderRowSchema, (body) =>
    Effect.gen(function* () {
      const svc = yield* GridService;
      return yield* svc.reorderRow(body.rowId, body.toIndex);
    }),
  );
}
