/**
 * Worker endpoint: patch a column's definition on a CLOUD table (the agent's
 * `update_column` tool in cloud mode) — rename / type / function provider-method-
 * code-params-condition. Only the provided fields are changed (omitted fields
 * keep their value); the cloud source sends just the keys the agent set.
 *
 * Member-attributed + metered: `GridService.updateColumn` resolves the column's
 * workspace, asserts the `X-Gtmgrid-Member` user is a member with cloud access
 * (fail-closed: 401/403/402), applies the patch, meters ONE cloud action, and
 * broadcasts a `column.update` with the full updated projection. Returns the
 * updated column's id + name.
 */

import { GridService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerAsMember } from "../_lib";
import { UpdateColumnSchema } from "../_schemas";

export const runtime = "nodejs";
export function POST(req: Request): Promise<Response> {
  return runWorkerAsMember(req, UpdateColumnSchema, (body) =>
    Effect.gen(function* () {
      const svc = yield* GridService;
      const col = yield* svc.updateColumn(body.columnId, body.patch ?? {});
      return { id: col.id, name: col.name };
    }),
  );
}
