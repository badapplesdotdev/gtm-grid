/**
 * Worker endpoint: rename a CLOUD table (the agent's `rename_table` tool in cloud
 * mode).
 *
 * Member-attributed + metered: `GridService.renameTable` resolves the table's
 * workspace, asserts the `X-Gtmgrid-Member` user is a member with cloud access
 * (fail-closed: 401/403/402), updates the name (a blank name is ignored), meters
 * ONE cloud action, and broadcasts a `table.rename` (per-table + workspace room)
 * so open grids and sidebars relabel live. Returns the effective name.
 */

import { GridService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerAsMember } from "../_lib";
import { RenameTableSchema } from "../_schemas";

export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return runWorkerAsMember(req, RenameTableSchema, (body) =>
    Effect.gen(function* () {
      const svc = yield* GridService;
      return yield* svc.renameTable(body.tableId, body.name ?? "");
    }),
  );
}
