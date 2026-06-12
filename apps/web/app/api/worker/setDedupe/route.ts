/**
 * Worker endpoint: set (or clear) a CLOUD table's row-dedup config (the agent's
 * `set_dedupe` tool in cloud mode), then sweep existing duplicates once.
 *
 * `column` is a column ID (the cloud source resolves the agent's column NAME to
 * its id first, mirroring the local source) or `null` to disable. Member-
 * attributed: `GridService.setDedupe` resolves the table's workspace, asserts the
 * `X-Gtmgrid-Member` user is a member with cloud access (fail-closed: 401/403/
 * 402), persists the config, and runs the dedup sweep (each removed row metered +
 * broadcast as a `row.delete`). Returns `{ dedupe, deleted }`.
 */

import { GridService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerAsMember } from "../_lib";

export const runtime = "nodejs";

interface SetDedupeBody {
  tableId: string;
  column: string | null;
  keep?: "oldest" | "newest";
}

export function POST(req: Request): Promise<Response> {
  return runWorkerAsMember(req, (body: SetDedupeBody) =>
    Effect.gen(function* () {
      const svc = yield* GridService;
      return yield* svc.setDedupe({
        tableId: body.tableId,
        column: body.column ?? null,
        keep: body.keep ?? "oldest",
      });
    }),
  );
}
