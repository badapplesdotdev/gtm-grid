/**
 * Worker endpoint: delete an entire CLOUD table (the agent's `delete_table` tool
 * in cloud mode) — all of its columns, rows and cells.
 *
 * Member-attributed + metered: `GridService.deleteTable` resolves the table's
 * workspace, asserts the `X-Gtmgrid-Member` user is a member with cloud access
 * (fail-closed: 401/403/402), deletes the table (children cascade via FK), meters
 * ONE cloud action, and broadcasts a `table.delete` (per-table + workspace room)
 * so open grids collapse and sidebars drop the table live.
 */

import { GridService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerAsMember } from "../_lib";

export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return runWorkerAsMember(req, (body: { tableId: string }) =>
    Effect.gen(function* () {
      const svc = yield* GridService;
      yield* svc.deleteTable(body.tableId);
      return { deleted: body.tableId };
    }),
  );
}
