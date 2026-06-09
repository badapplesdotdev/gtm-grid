/**
 * Worker endpoint: create a table in a CLOUD project (the agent's `create_table`
 * tool in cloud mode — TRI-3299).
 *
 * Member-attributed + metered: `GridService.createTable` resolves the project's
 * workspace, asserts the forwarded `X-Gtmgrid-Member` user is a member with
 * cloud access (fail-closed: 401/403/402), inserts the table, and meters ONE
 * cloud action server-side (no client counter). Returns the new table id.
 */

import { GridService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerAsMember } from "../_lib";

export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return runWorkerAsMember(
    req,
    (body: { projectId: string; name: string }) =>
      Effect.gen(function* () {
        const svc = yield* GridService;
        const id = yield* svc.createTable({
          projectId: body.projectId,
          name: body.name,
        });
        return { id, name: body.name };
      }),
  );
}
