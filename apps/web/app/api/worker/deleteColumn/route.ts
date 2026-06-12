/**
 * Worker endpoint: delete a column from a CLOUD table (the agent's
 * `delete_column` tool in cloud mode).
 *
 * Member-attributed + metered: `GridService.deleteColumn` resolves the column's
 * workspace, asserts the `X-Gtmgrid-Member` user is a member with cloud access
 * (fail-closed: 401/403/402), deletes the column (its cells cascade via FK),
 * meters ONE cloud action, and broadcasts a `column.delete` so viewers update.
 */

import { GridService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerAsMember } from "../_lib";

export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return runWorkerAsMember(req, (body: { columnId: string }) =>
    Effect.gen(function* () {
      const svc = yield* GridService;
      yield* svc.deleteColumn(body.columnId);
      return { deleted: body.columnId };
    }),
  );
}
