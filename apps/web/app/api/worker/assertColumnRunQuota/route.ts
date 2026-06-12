/**
 * Worker endpoint: pre-flight quota gate for a cloud COLUMN run (TRI-3277).
 * Before a cloud run fans out, the sidecar calls this with the run's
 * `{ tableId, columnId, rowIds?, force }`; the service computes how many cells
 * the run would actually meter (candidate rows minus already-`done` skips unless
 * force) and asserts the workspace has the headroom. Over-quota fails with
 * `CloudActionsLimitError`, which `runWorkerSecretOrMember` maps to a 402 — so the run is
 * rejected up-front instead of over-metering silently. Secret-gated bearer.
 */

import { WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerSecretOrMember } from "../_lib";

export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return runWorkerSecretOrMember(
    req,
    (body: {
      tableId: string;
      columnId: string;
      rowIds?: string[];
      force?: boolean;
    }) =>
      Effect.gen(function* () {
        const svc = yield* WebhookService;
        return yield* svc.assertColumnRunQuota({
          tableId: body.tableId,
          columnId: body.columnId,
          ...(body.rowIds !== undefined ? { rowIds: body.rowIds } : {}),
          ...(body.force !== undefined ? { force: body.force } : {}),
        });
      }),
  );
}
