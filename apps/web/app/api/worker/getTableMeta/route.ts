/**
 * Worker endpoint: fetch only a table's metadata (worker getTableMeta shape).
 * A cloud run start needs just the table's `workspaceId` to resolve shared
 * connector credentials, so this skips the full-grid `getTable` payload (no
 * columns/rows/cells over the wire). Secret-gated bearer. (TRI-3273.)
 */

import { WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorker } from "../_lib";

export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return runWorker(req, (body: { tableId: string }) =>
    Effect.gen(function* () {
      const svc = yield* WebhookService;
      return yield* svc.getTableMeta(body.tableId);
    }),
  );
}
