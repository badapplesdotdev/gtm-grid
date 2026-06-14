/**
 * Worker endpoint: add a column to a CLOUD table (the agent's `add_column` tool
 * in cloud mode — TRI-3299).
 *
 * Accepts the SAME column spec the authenticated `grid.addColumn` mutation does
 * (name/type/kind + the optional function fields provider/method/code/params),
 * so the cloud source maps the agent's `fn`/`code` to this shape once and the
 * service path is shared. Member-attributed + metered: `GridService.addColumn`
 * resolves the table's workspace, asserts the `X-Gtmgrid-Member` user is a
 * member with cloud access (fail-closed: 401/403/402), inserts the column, and
 * meters ONE cloud action server-side. Returns the new column id.
 */

import { GridService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerAsMember } from "../_lib";
import { CreateColumnSchema } from "../_schemas";

export const runtime = "nodejs";
export function POST(req: Request): Promise<Response> {
  return runWorkerAsMember(req, CreateColumnSchema, (body) =>
    Effect.gen(function* () {
      const svc = yield* GridService;
      const id = yield* svc.addColumn({
        tableId: body.tableId,
        name: body.name,
        type: body.type,
        kind: body.kind,
        provider: body.provider ?? null,
        method: body.method ?? null,
        code: body.code ?? null,
        params: body.params ?? {},
        condition: body.condition ?? null,
      });
      return { id, name: body.name, kind: body.kind };
    }),
  );
}
