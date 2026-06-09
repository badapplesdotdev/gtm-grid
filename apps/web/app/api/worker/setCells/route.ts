/**
 * Worker endpoint: BATCHED cell upsert — apply an ARRAY of cell writes in one
 * POST (each a COALESCE merge that meters ONLY on a terminal status). The cloud
 * store buffers terminal writes during a column run and flushes them here in
 * chunks (bounded in-flight + backpressure), so a large run is one request per
 * chunk instead of one HTTP POST per cell. Secret-gated bearer.
 *
 * Per cell, `value` is COALESCE: its PRESENCE in the object (even `null`) means
 * "overwrite"; omitting it keeps the existing value. We forward that presence as
 * `hasValue`.
 */

import { type CloudCellStatus, WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorker } from "../_lib";

export const runtime = "nodejs";

interface SetCellEntry {
  rowId: string;
  columnId: string;
  value?: unknown;
  status?: CloudCellStatus;
  error?: string | null;
}

interface SetCellsBody {
  cells: SetCellEntry[];
}

export function POST(req: Request): Promise<Response> {
  return runWorker(req, (body: SetCellsBody) =>
    Effect.gen(function* () {
      const svc = yield* WebhookService;
      return yield* svc.setCells({
        cells: (body.cells ?? []).map((c) => ({
          rowId: c.rowId,
          columnId: c.columnId,
          hasValue: "value" in c,
          ...("value" in c ? { value: c.value } : {}),
          ...(c.status !== undefined ? { status: c.status } : {}),
          ...(c.error !== undefined ? { error: c.error } : {}),
        })),
      });
    }),
  );
}
