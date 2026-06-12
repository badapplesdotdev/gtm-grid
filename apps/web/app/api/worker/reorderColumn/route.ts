/**
 * Worker endpoint: move a column to a new display index on a CLOUD table (the
 * agent's `reorder_columns` tool in cloud mode).
 *
 * Member-attributed + metered: `GridService.reorderColumn` resolves the column's
 * workspace, asserts the `X-Gtmgrid-Member` user is a member with cloud access
 * (fail-closed: 401/403/402), reindexes the table's columns (writing only those
 * whose position changes), meters ONE cloud action, and broadcasts a
 * `column.reorder` with the full new id order. Returns that order.
 */

import { GridService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerAsMember } from "../_lib";

export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return runWorkerAsMember(
    req,
    (body: { columnId: string; toIndex: number }) =>
      Effect.gen(function* () {
        const svc = yield* GridService;
        return yield* svc.reorderColumn(body.columnId, body.toIndex);
      }),
  );
}
