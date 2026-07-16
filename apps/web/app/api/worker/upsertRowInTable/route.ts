/**
 * Worker endpoint: UPSERT ONE pushed row into a sibling table — the table.push
 * write. Server-side indexed key match, patch-or-insert, metered ONCE per
 * record (mirrors the webhook upsertRow), with same-project target resolution
 * enforced in the service. `keyColumnId: null` appends unconditionally.
 *
 * `autoRunTarget` (Clay parity: the target's columns run over the touched row)
 * is honoured AFTER the write by emitting the `table/row.pushed` Inngest event
 * — the same durable enrich lane webhook records use. Emission is best-effort:
 * the row is already written and metered, so a failed enqueue must not fail
 * the push (the caller can re-run; the upsert is idempotent).
 */

import { WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { runWorkerSecretOrMember } from "../_lib";
import { UpsertRowInTableSchema } from "../_schemas";
import { inngest } from "../../../../lib/inngest/client";

export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return runWorkerSecretOrMember(req, UpsertRowInTableSchema, (body) =>
    Effect.gen(function* () {
      const svc = yield* WebhookService;
      const result = yield* svc.upsertRowInTable({
        sourceTableId: body.sourceTableId,
        targetTableId: body.targetTableId,
        keyColumnId: body.keyColumnId,
        keyValue: body.keyValue,
        cells: body.cells,
      });
      if (body.autoRunTarget === true) {
        yield* Effect.promise(() =>
          inngest
            .send({
              // Dedupe far-apart duplicate emissions when the caller supplies an
              // idempotency key; without one each push enqueues its own event
              // (the enrich itself skips already-done cells, so replays are cheap).
              ...(body.recordId !== undefined ? { id: body.recordId } : {}),
              name: "table/row.pushed",
              data: {
                tableId: result.tableId,
                workspaceId: result.workspaceId,
                rowId: result.rowId,
                recordId: body.recordId ?? null,
              },
            })
            .then(
              () => undefined,
              () => undefined, // best-effort: never fail a completed push
            ),
        );
      }
      return { rowId: result.rowId, created: result.created };
    }),
  );
}
