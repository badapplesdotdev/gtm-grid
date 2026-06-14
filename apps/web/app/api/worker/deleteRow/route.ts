/**
 * Worker endpoint: delete a row from a CLOUD table (the agent's `delete_rows`
 * tool in cloud mode). The cloud source resolves the agent's row _ids and calls
 * this once per row.
 *
 * Member-attributed + metered: `GridService.deleteRow` resolves the row's
 * workspace, asserts the `X-Gtmgrid-Member` user is a member with cloud access
 * (fail-closed: 401/403/402), deletes the row (its cells cascade via FK), meters
 * ONE cloud action, and broadcasts a `row.delete` so every viewer's grid updates.
 */

import { GridService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerAsMember } from "../_lib";
import { DeleteRowSchema } from "../_schemas";

export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return runWorkerAsMember(req, DeleteRowSchema, (body) =>
    Effect.gen(function* () {
      const svc = yield* GridService;
      yield* svc.deleteRow(body.rowId);
      return { deleted: body.rowId };
    }),
  );
}
