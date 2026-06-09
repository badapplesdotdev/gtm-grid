/**
 * Worker endpoint: bulk-add rows (+ optional cell values) to a CLOUD table (the
 * agent's `add_rows` tool in cloud mode — TRI-3299).
 *
 * Mirrors the authenticated `grid.addRowsWithCells` mutation: each row is a
 * `{ columnId: value }` map (the cloud source resolves the agent's column NAMES
 * to ids before calling, so this boundary speaks column ids exactly as the tRPC
 * path does). Member-attributed + metered with an ATOMIC quota pre-check:
 * `GridService.addRowsWithCells` resolves the table's workspace, asserts the
 * `X-Gtmgrid-Member` user is a member with cloud access, rejects an import that
 * would exceed the plan's remaining cloud actions BEFORE writing
 * (`CloudActionsLimitError` → 402), then writes rows + cells and meters ONE
 * cloud action PER ROW server-side. Returns the new row ids.
 */

import { GridService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerAsMember } from "../_lib";

export const runtime = "nodejs";

interface AddRowsBody {
  tableId: string;
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

export function POST(req: Request): Promise<Response> {
  return runWorkerAsMember(req, (body: AddRowsBody) =>
    Effect.gen(function* () {
      const svc = yield* GridService;
      return yield* svc.addRowsWithCells({
        tableId: body.tableId,
        rows: body.rows ?? [],
      });
    }),
  );
}
